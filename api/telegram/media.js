import { Readable } from 'node:stream';
import { once } from 'node:events';
import { getCache } from '@vercel/functions';
import { json } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { telegram } from '../../lib/telegram.js';
import {
  buildFastStartIndex,
  cachedFastStartIndex,
  isMp4ProbeRange,
  parseByteRange,
  streamIndexedRange
} from '../../lib/mp4-faststart.js';

const BOT_API_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const BOT_FILE_PATH_TTL_MS = 50 * 60 * 1000;
const TICKET_TABLE = 'lms_v4_media_tickets';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const botFilePathCache = new Map();
let mediaRuntimeCache;

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

function appendServerTiming(res, name, durationMs) {
  const metric = `${name};dur=${Math.max(0, Math.round(durationMs))}`;
  const current = String(res.getHeader('Server-Timing') || '').trim();
  res.setHeader('Server-Timing', current ? `${current}, ${metric}` : metric);
}

function sharedMediaCache() {
  if (!process.env.RUNTIME_CACHE_ENDPOINT || !process.env.RUNTIME_CACHE_HEADERS) return null;
  if (!mediaRuntimeCache) mediaRuntimeCache = getCache({ namespace: 'tgcloner-media-v1' });
  return mediaRuntimeCache;
}

async function botFilePath(fileId) {
  const cached = botFilePathCache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) return { path: cached.path, source: 'memory' };
  const shared = sharedMediaCache();
  if (shared) {
    try {
      const value = await shared.get(`bot-file-path:${fileId}`);
      if (value?.path && typeof value.path === 'string') {
        botFilePathCache.set(fileId, { path: value.path, expiresAt: Date.now() + BOT_FILE_PATH_TTL_MS });
        return { path: value.path, source: 'runtime' };
      }
    } catch (error) {
      console.warn('[telegram-media-gateway] runtime file-path cache read failed', error?.message || error);
    }
  }
  const fileInfo = await telegram('getFile', { file_id: fileId });
  if (!fileInfo?.file_path) throw new GatewayError('telegram_get_file_failed', 502);
  botFilePathCache.set(fileId, {
    path: fileInfo.file_path,
    expiresAt: Date.now() + BOT_FILE_PATH_TTL_MS
  });
  if (shared) {
    try {
      await shared.set(`bot-file-path:${fileId}`, { path: fileInfo.file_path }, {
        ttl: Math.floor(BOT_FILE_PATH_TTL_MS / 1000),
        tags: ['telegram-bot-file-path'],
        name: 'telegram-bot-file-path'
      });
    } catch (error) {
      console.warn('[telegram-media-gateway] runtime file-path cache write failed', error?.message || error);
    }
  }
  return { path: fileInfo.file_path, source: 'telegram' };
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

function isMp4(media) {
  return String(media.mimeType || '').toLowerCase() === 'video/mp4' || String(media.name || '').toLowerCase().endsWith('.mp4');
}

async function fetchBotRange(url, start, end, signal) {
  const upstream = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  const wholeFile = start === 0 && Number(upstream.headers.get('content-length') || 0) === end + 1;
  if ((!upstream.ok && upstream.status !== 206) || (upstream.status !== 206 && !wholeFile)) {
    throw new GatewayError('telegram_file_range_failed', 502);
  }
  return upstream;
}

async function readBotRange(url, start, end) {
  const upstream = await fetchBotRange(url, start, end);
  const bytes = Buffer.from(await upstream.arrayBuffer());
  const expected = end - start + 1;
  if (bytes.length !== expected) throw new GatewayError('telegram_file_range_incomplete', 502);
  return bytes;
}

async function streamBotRange(url, start, end, signal, onChunk) {
  const upstream = await fetchBotRange(url, start, end, signal);
  if (!upstream.body) throw new GatewayError('telegram_file_fetch_failed', 502);
  const readable = Readable.fromWeb(upstream.body);
  try {
    for await (const chunk of readable) {
      if (signal?.aborted) {
        const error = new Error('Media request aborted');
        error.code = 'request_aborted';
        throw error;
      }
      await onChunk(Buffer.from(chunk));
    }
  } finally {
    if (signal?.aborted) readable.destroy();
  }
}

async function writeChunk(res, chunk) {
  if (res.destroyed) {
    const error = new Error('Media request aborted');
    error.code = 'request_aborted';
    throw error;
  }
  if (!res.write(chunk)) await once(res, 'drain');
}

async function streamViaBotApi(req, res, row, media) {
  if (!media.fileId) throw new GatewayError('media_file_id_missing', 409);
  const getFileStartedAt = Date.now();
  const fileInfo = await botFilePath(media.fileId);
  appendServerTiming(res, `bot-file-${fileInfo.source}`, Date.now() - getFileStartedAt);

  const botToken = clean(requireEnv('TELEGRAM_BOT_TOKEN'));
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.path}`;
  const range = parseByteRange(req.headers.range, media.size);
  if (!range) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${media.size}`);
    return res.end();
  }

  let index = { mode: 'passthrough', size: media.size, reason: 'not_mp4' };
  const probeOnly = isMp4(media) && isMp4ProbeRange(range);
  if (probeOnly) {
    index = { mode: 'probe-passthrough', size: media.size, reason: 'browser_probe' };
  } else if (req.method !== 'HEAD' && isMp4(media) && process.env.MP4_VIRTUAL_FASTSTART_ENABLED !== 'false') {
    const indexStartedAt = Date.now();
    index = await cachedFastStartIndex(
      `bot:${row.id}:${media.fileId}:${media.size}`,
      () => buildFastStartIndex({ size: media.size, readRange: (start, end) => readBotRange(fileUrl, start, end) })
    );
    appendServerTiming(res, 'mp4-index', Date.now() - indexStartedAt);
  }

  res.statusCode = range.partial ? 206 : 200;
  res.setHeader('X-Telegram-Media-Transport', 'bot-api');
  res.setHeader('X-MP4-Layout', index.mode);
  res.setHeader('X-MP4-Index-Cache', index.cacheSource || (probeOnly ? 'skipped-probe' : 'none'));
  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(range.end - range.start + 1));
  if (range.partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${media.size}`);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.name || 'telegram-media')}`);
  res.setHeader('Cache-Control', 'private, max-age=300');

  if (req.method === 'HEAD') return res.end();

  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  res.once('close', onClose);
  try {
    await streamIndexedRange({
      index,
      start: range.start,
      end: range.end,
      streamOriginal: (start, end, onChunk) => streamBotRange(fileUrl, start, end, abortController.signal, onChunk),
      onChunk: chunk => writeChunk(res, chunk)
    });
    res.end();
  } finally {
    res.off('close', onClose);
  }
}

export default async function handler(req, res) {
  const requestStartedAt = Date.now();
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  try {
    const ticketToken = String(req.query?.ticket || '').trim();
    const { row, media } = await resolveTicketMedia(ticketToken);
    appendServerTiming(res, 'ticket-media', Date.now() - requestStartedAt);
    if (media.size > BOT_API_DOWNLOAD_LIMIT || !media.fileId) {
      res.statusCode = 307;
      res.setHeader('Location', `/api/telegram/warmup?stream=1&ticket=${encodeURIComponent(ticketToken)}`);
      res.setHeader('X-Telegram-Media-Transport', 'mtproto-redirect');
      console.info(`[telegram-media-gateway] transport=mtproto-redirect method=${req.method} size=${media.size} elapsed_ms=${Date.now() - requestStartedAt}`);
      return res.end();
    }
    await streamViaBotApi(req, res, row, media);
    console.info(`[telegram-media-gateway] transport=bot-api method=${req.method} size=${media.size} range=${String(req.headers.range || 'none')} layout=${String(res.getHeader('X-MP4-Layout') || 'none')} index_cache=${String(res.getHeader('X-MP4-Index-Cache') || 'none')} server_timing=${String(res.getHeader('Server-Timing') || 'none')} elapsed_ms=${Date.now() - requestStartedAt}`);
  } catch (error) {
    const code = error?.code || 'media_gateway_failed';
    const status = Number(error?.status || 500);
    if (code !== 'request_aborted' && error?.name !== 'AbortError') {
      console.error('[telegram-media-gateway]', code, error?.message || error, `elapsed_ms=${Date.now() - requestStartedAt}`);
    }
    if (!res.headersSent) return json(res, status, { ok: false, error: code });
    if (!res.writableEnded) res.end();
  }
}
