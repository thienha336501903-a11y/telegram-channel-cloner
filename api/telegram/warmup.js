import { once } from 'node:events';
import { json } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import {
  applyPlaybackCors,
  clean,
  ticketTokenFromRequest,
  validateProtectedPlayback
} from '../../lib/v4-playback-guard.js';
import {
  buildFastStartIndex,
  cachedFastStartIndex,
  isMp4ProbeRange,
  parseByteRange,
  streamIndexedRange
} from '../../lib/mp4-faststart.js';
import {
  getMtprotoClient,
  resetMtprotoClient,
  streamResolvedMtprotoRange
} from '../../lib/mtproto-media.js';
import { resolveMtprotoHistoricalMedia } from '../../lib/mtproto-history-media.js';

const BOT_API_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const TICKET_TABLE = 'lms_v4_media_tickets';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_TYPES = new Set(['video', 'animation', 'video_note']);

function supabaseHeaders() {
  const key = clean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!key) throw new Error('Missing Supabase server key');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function appendServerTiming(res, name, durationMs) {
  const metric = `${name};dur=${Math.max(0, Math.round(durationMs))}`;
  const current = String(res.getHeader('Server-Timing') || '').trim();
  res.setHeader('Server-Timing', current ? `${current}, ${metric}` : metric);
}

async function loadActiveTicket(token) {
  if (!UUID_RE.test(token)) return { ok: false, status: 400, error: 'invalid_ticket' };
  const base = clean(requireEnv('SUPABASE_URL')).replace(/\/$/, '');
  const qs = new URLSearchParams({
    select: 'token,source_id,message_id,expires_at,revoked_at,purpose,playback_proof_hash,bound_ua_hash,bound_ip_hash',
    token: `eq.${token}`,
    limit: '1'
  });
  const response = await fetch(`${base}/rest/v1/${TICKET_TABLE}?${qs.toString()}`, {
    headers: supabaseHeaders()
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Ticket lookup failed: ${response.status}`);
  const ticket = Array.isArray(data) ? data[0] || null : null;
  if (!ticket || ticket.revoked_at) return { ok: false, status: 403, error: 'ticket_invalid' };
  if (!ticket.expires_at || Date.parse(ticket.expires_at) <= Date.now()) {
    return { ok: false, status: 403, error: 'ticket_expired' };
  }
  return { ok: true, ticket };
}

function pickMedia(raw, messageType) {
  const value = raw && typeof raw === 'object' ? raw : {};
  if (messageType === 'photo' && Array.isArray(value.photo) && value.photo.length) {
    const item = value.photo[value.photo.length - 1] || {};
    return {
      fileId: String(item.file_id || ''),
      size: Number(item.file_size || 0),
      mimeType: 'image/jpeg',
      name: 'telegram-photo.jpg',
      mtproto: Boolean(item.mtproto)
    };
  }
  const key = messageType === 'video_note' ? 'video_note' : messageType;
  const item = value[key] && typeof value[key] === 'object' ? value[key] : null;
  if (!item) return null;
  return {
    fileId: String(item.file_id || ''),
    size: Number(item.file_size || 0),
    mimeType: String(item.mime_type || 'application/octet-stream'),
    name: String(item.file_name || `telegram-${messageType}`),
    mtproto: Boolean(item.mtproto)
  };
}

async function resolveTicketMedia(ticket) {
  const rows = await select(
    TABLES.sourceMessages,
    `select=id,source_id,source_message_id,message_type,raw_message&id=eq.${encodeURIComponent(ticket.message_id)}&source_id=eq.${encodeURIComponent(ticket.source_id)}&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] || null : null;
  if (!row) return { ok: false, status: 404, error: 'media_not_found' };
  const media = pickMedia(row.raw_message, row.message_type);
  if (!media) return { ok: false, status: 409, error: 'media_metadata_missing' };
  if (media.fileId && media.size <= BOT_API_DOWNLOAD_LIMIT) {
    return { ok: false, status: 409, error: 'mtproto_not_required' };
  }
  return { ok: true, row, media };
}

function isMp4(media) {
  return String(media.mimeType || '').toLowerCase() === 'video/mp4' || String(media.name || '').toLowerCase().endsWith('.mp4');
}

async function readResolvedRange(resolved, start, end) {
  const chunks = [];
  await streamResolvedMtprotoRange({
    resolved,
    start,
    end,
    onChunk: async chunk => chunks.push(Buffer.from(chunk))
  });
  return Buffer.concat(chunks);
}

async function streamMtproto(req, res, row, media, protectedPlayback = false) {
  const sourceRows = await select(
    TABLES.sources,
    `select=id,chat_id&id=eq.${encodeURIComponent(row.source_id)}&limit=1`
  );
  const source = Array.isArray(sourceRows) ? sourceRows[0] || null : null;
  if (!source?.chat_id) return { ok: false, status: 404, error: 'telegram_source_missing' };

  const resolveStartedAt = Date.now();
  let resolved;
  try {
    resolved = await resolveMtprotoHistoricalMedia({
      chatId: source.chat_id,
      messageId: row.source_message_id
    });
  } catch (error) {
    resetMtprotoClient();
    throw error;
  }
  appendServerTiming(res, 'mtproto-resolve', Date.now() - resolveStartedAt);

  media.size = Number(resolved.size || media.size || 0);
  media.mimeType = String(resolved.mimeType || media.mimeType || 'application/octet-stream');
  media.name = String(resolved.name || media.name || 'telegram-media');

  const range = parseByteRange(req.headers.range, resolved.size);
  if (!range) {
    res.setHeader('Content-Range', `bytes */${resolved.size}`);
    return { ok: false, status: 416, error: 'range_not_satisfiable' };
  }

  let index = { mode: 'passthrough', size: resolved.size, reason: 'not_mp4' };
  const probeOnly = isMp4(media) && isMp4ProbeRange(range);
  const prepareOnly = String(req.query?.prepare || '') === '1';
  if (probeOnly) {
    index = { mode: 'probe-passthrough', size: resolved.size, reason: 'browser_probe' };
  } else if (
    isMp4(media) &&
    process.env.MP4_VIRTUAL_FASTSTART_ENABLED !== 'false' &&
    (req.method !== 'HEAD' || prepareOnly)
  ) {
    const indexStartedAt = Date.now();
    const mediaId = String(resolved.document?.id || resolved.photo?.id || row.id);
    index = await cachedFastStartIndex(
      `mtproto:${row.id}:${mediaId}:${resolved.size}`,
      () => buildFastStartIndex({
        size: resolved.size,
        readRange: (start, end) => readResolvedRange(resolved, start, end)
      })
    );
    appendServerTiming(res, 'mp4-index', Date.now() - indexStartedAt);
  }

  res.setHeader('X-Telegram-Media-Transport', 'mtproto');
  res.setHeader('X-MP4-Layout', index.mode);
  res.setHeader('X-MP4-Index-Cache', index.cacheSource || (probeOnly ? 'skipped-probe' : 'none'));
  if (prepareOnly) {
    res.statusCode = 204;
    return { ok: true, prepared: true };
  }

  res.statusCode = range.partial ? 206 : 200;
  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(range.end - range.start + 1));
  if (range.partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${resolved.size}`);
  res.setHeader('Content-Disposition', protectedPlayback ? 'inline' : `inline; filename*=UTF-8''${encodeURIComponent(media.name)}`);
  res.setHeader('Cache-Control', protectedPlayback ? 'private, no-store' : 'private, max-age=300');
  if (req.method === 'HEAD') return { ok: true };

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
      streamOriginal: (start, end, onChunk) => streamResolvedMtprotoRange({
        resolved,
        start,
        end,
        signal: abortController.signal,
        onChunk
      }),
      onChunk: async chunk => {
        if (!res.write(chunk)) await once(res, 'drain');
      }
    });
    res.end();
    return { ok: true };
  } catch (error) {
    if (error?.code !== 'request_aborted') resetMtprotoClient();
    throw error;
  } finally {
    res.off('close', onClose);
  }
}

export default async function handler(req, res) {
  const corsOkay = applyPlaybackCors(req, res);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') {
    res.statusCode = corsOkay ? 204 : 403;
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  try {
    const tokenInput = ticketTokenFromRequest(req);
    const access = await loadActiveTicket(tokenInput.token);
    if (!access.ok) return json(res, access.status, { ok: false, error: access.error });

    const startedAt = Date.now();
    const prepareOnly = String(req.query?.prepare || '') === '1';
    const streamOnly = String(req.query?.stream || '') === '1';
    const purpose = String(access.ticket.purpose || 'legacy');

    if (streamOnly && purpose === 'warmup') {
      return json(res, 403, { ok: false, error: 'warmup_ticket_not_streamable' });
    }

    const guard = validateProtectedPlayback(req, access.ticket, tokenInput.via);
    if (!guard.ok) return json(res, guard.status, { ok: false, error: guard.error });
    const protectedPlayback = Boolean(guard.protected);

    if (!prepareOnly && !streamOnly) {
      await getMtprotoClient();
      res.setHeader('Server-Timing', `mtproto-warmup;dur=${Date.now() - startedAt}`);
      res.statusCode = 204;
      return res.end();
    }

    const resolved = await resolveTicketMedia(access.ticket);
    if (!resolved.ok) return json(res, resolved.status, { ok: false, error: resolved.error });
    if (streamOnly && purpose === 'feed' && VIDEO_TYPES.has(resolved.row.message_type)) {
      return json(res, 403, { ok: false, error: 'playback_lease_required' });
    }
    appendServerTiming(res, 'ticket-media', Date.now() - startedAt);
    const streamed = await streamMtproto(req, res, resolved.row, resolved.media, protectedPlayback);
    if (!streamed.ok) return json(res, streamed.status, { ok: false, error: streamed.error });
    console.info(`[telegram-mtproto-media] protected=${protectedPlayback ? '1' : '0'} method=${req.method} size=${resolved.media.size} range=${String(req.headers.range || 'none')} layout=${String(res.getHeader('X-MP4-Layout') || 'none')} index_cache=${String(res.getHeader('X-MP4-Index-Cache') || 'none')} server_timing=${String(res.getHeader('Server-Timing') || 'none')} elapsed_ms=${Date.now() - startedAt}`);
    if (!res.writableEnded) res.end();
  } catch (error) {
    console.error('[telegram-mtproto-warmup]', error?.message || error);
    if (!res.headersSent) return json(res, 500, { ok: false, error: 'mtproto_warmup_failed' });
    if (!res.writableEnded) res.end();
  }
}
