import { once } from 'node:events';
import { Readable } from 'node:stream';
import { json } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { telegram } from '../../lib/telegram.js';
import {
  resolveMtprotoDocument,
  resetMtprotoClient,
  streamResolvedMtprotoRange
} from '../../lib/mtproto-media.js';

const BOT_API_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const TICKET_TABLE = 'lms_v4_media_tickets';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class GatewayError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function clean(value) {
  return String(value || '').trim().replace(/^[\'\"]|[\'\"]$/g, '');
}

function supabaseHeaders() {
  const key = clean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!key) throw new Error('Missing Supabase server key');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function loadTicket(token) {
  const base = clean(requireEnv('SUPABASE_URL')).replace(/\/$/, '');
  const qs = new URLSearchParams({
    select: 'token,course_slug,source_id,message_id,email,expires_at,revoked_at',
    token: `eq.${token}`,
    limit: '1'
  });
  const response = await fetch(`${base}/rest/v1/${TICKET_TABLE}?${qs.toString()}`, {
    headers: supabaseHeaders()
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Ticket lookup failed: ${response.status}`);
  return Array.isArray(data) ? data[0] || null : null;
}

function pickMedia(raw, messageType) {
  const value = raw && typeof raw === 'object' ? raw : {};
  if (messageType === 'photo' && Array.isArray(value.photo) && value.photo.length) {
    const item = value.photo[value.photo.length - 1] || {};
    return {
      fileId: String(item.file_id || ''),
      size: Number(item.file_size || 0),
      mimeType: 'image/jpeg',
      name: 'telegram-photo.jpg'
    };
  }
  const key = messageType === 'video_note' ? 'video_note' : messageType;
  const item = value[key] && typeof value[key] === 'object' ? value[key] : null;
  if (!item) return null;
  return {
    fileId: String(item.file_id || ''),
    size: Number(item.file_size || 0),
    mimeType: String(item.mime_type || 'application/octet-stream'),
    name: String(item.file_name || `telegram-${messageType}`)
  };
}

async function resolveTicketMedia(ticketToken) {
  if (!UUID_RE.test(ticketToken)) throw new GatewayError('invalid_ticket', 400);

  const ticket = await loadTicket(ticketToken);
  if (!ticket || ticket.revoked_at) throw new GatewayError('ticket_invalid', 403);
  if (!ticket.expires_at || Date.parse(ticket.expires_at) <= Date.now()) {
    throw new GatewayError('ticket_expired', 403);
  }

  const rows = await select(
    TABLES.sourceMessages,
    `select=id,source_id,source_message_id,message_type,raw_message&id=eq.${encodeURIComponent(ticket.message_id)}&source_id=eq.${encodeURIComponent(ticket.source_id)}&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] || null : null;
  if (!row) throw new GatewayError('media_not_found', 404);

  const media = pickMedia(row.raw_message, row.message_type);
  if (!media) throw new GatewayError('media_metadata_missing', 409);
  return { ticket, row, media };
}

function parseRange(rangeHeader, size) {
  const raw = String(rangeHeader || '').trim();
  if (!raw) return { partial: false, start: 0, end: size - 1 };
  if (!raw.startsWith('bytes=') || raw.includes(',')) throw new GatewayError('range_not_satisfiable', 416);

  const spec = raw.slice(6).trim();
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) throw new GatewayError('range_not_satisfiable', 416);

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new GatewayError('range_not_satisfiable', 416);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
      throw new GatewayError('range_not_satisfiable', 416);
    }
    if (match[2]) {
      end = Number.parseInt(match[2], 10);
      if (!Number.isSafeInteger(end) || end < start) throw new GatewayError('range_not_satisfiable', 416);
      end = Math.min(end, size - 1);
    } else {
      end = size - 1;
    }
  }
  return { partial: true, start, end };
}

function setMediaHeaders(res, media, size, range) {
  res.statusCode = range.partial ? 206 : 200;
  res.setHeader('Content-Type', media.mimeType || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(range.end - range.start + 1));
  if (range.partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.name || 'telegram-media')}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
}

async function streamViaBotApi(req, res, media) {
  if (!media.fileId) throw new GatewayError('media_file_id_missing', 409);
  const fileInfo = await telegram('getFile', { file_id: media.fileId });
  if (!fileInfo?.file_path) throw new GatewayError('telegram_get_file_failed', 502);

  const botToken = clean(requireEnv('TELEGRAM_BOT_TOKEN'));
  const upstreamHeaders = {};
  const range = String(req.headers.range || '').trim();
  if (range) upstreamHeaders.Range = range;

  const upstream = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`,
    { headers: upstreamHeaders }
  );
  if ((!upstream.ok && upstream.status !== 206) || !upstream.body) {
    throw new GatewayError('telegram_file_fetch_failed', 502);
  }

  res.statusCode = upstream.status;
  res.setHeader('Content-Type', upstream.headers.get('content-type') || media.mimeType);
  res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
  const length = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  if (length) res.setHeader('Content-Length', length);
  if (contentRange) res.setHeader('Content-Range', contentRange);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.name || 'telegram-media')}`);
  res.setHeader('Cache-Control', 'private, max-age=300');

  if (req.method === 'HEAD') {
    try { await upstream.body.cancel(); } catch {}
    return res.end();
  }
  Readable.fromWeb(upstream.body).pipe(res);
}

async function streamViaMtproto(req, res, row, media) {
  const sourceRows = await select(
    TABLES.sources,
    `select=id,chat_id&id=eq.${encodeURIComponent(row.source_id)}&limit=1`
  );
  const source = Array.isArray(sourceRows) ? sourceRows[0] || null : null;
  if (!source?.chat_id) throw new GatewayError('telegram_source_missing', 404);

  let resolved;
  try {
    resolved = await resolveMtprotoDocument({
      chatId: source.chat_id,
      messageId: row.source_message_id
    });
  } catch (error) {
    resetMtprotoClient();
    throw error;
  }

  const size = resolved.size;
  const probeRange = process.env.VERCEL_ENV === 'preview' && String(req.query?.probe || '') === '1'
    ? 'bytes=1048576-1050623'
    : req.headers.range;
  let range;
  try {
    range = parseRange(probeRange, size);
  } catch (error) {
    if (error?.status === 416) res.setHeader('Content-Range', `bytes */${size}`);
    throw error;
  }
  setMediaHeaders(res, media, size, range);
  if (req.method === 'HEAD') return res.end();

  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  res.once('close', onClose);

  try {
    await streamResolvedMtprotoRange({
      resolved,
      start: range.start,
      end: range.end,
      signal: abortController.signal,
      onChunk: async (chunk) => {
        if (!res.write(chunk)) await once(res, 'drain');
      }
    });
    res.end();
  } catch (error) {
    if (error?.code !== 'request_aborted') resetMtprotoClient();
    throw error;
  } finally {
    res.off('close', onClose);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  try {
    const ticketToken = String(req.query?.ticket || '').trim();
    const { row, media } = await resolveTicketMedia(ticketToken);
    if (media.size > BOT_API_DOWNLOAD_LIMIT) {
      await streamViaMtproto(req, res, row, media);
      return;
    }
    await streamViaBotApi(req, res, media);
  } catch (error) {
    const code = error?.code || 'media_gateway_failed';
    const status = Number(error?.status || 500);
    console.error('[telegram-media-gateway]', code, error?.message || error);
    if (!res.headersSent) return json(res, status, { ok: false, error: code });
    if (!res.writableEnded) res.end();
  }
}
