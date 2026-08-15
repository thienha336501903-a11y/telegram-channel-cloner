import { getCache } from '@vercel/functions';
import { json } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { telegram } from '../../lib/telegram.js';

const TICKET_TABLE = 'lms_v4_media_tickets';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOT_FILE_PATH_TTL_MS = 50 * 60 * 1000;
const THUMBNAIL_CACHE_TTL_SECONDS = 24 * 60 * 60;
const THUMBNAIL_BROWSER_TTL_SECONDS = 60 * 60;
const THUMBNAIL_MAX_CACHE_BYTES = 512 * 1024;
const botFilePathCache = new Map();
const thumbnailMemoryCache = new Map();
let thumbnailRuntimeCache;

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

function sharedThumbnailCache() {
  if (!process.env.RUNTIME_CACHE_ENDPOINT || !process.env.RUNTIME_CACHE_HEADERS) return null;
  if (!thumbnailRuntimeCache) thumbnailRuntimeCache = getCache({ namespace: 'tgcloner-thumbnails-v1' });
  return thumbnailRuntimeCache;
}

async function botFilePath(fileId) {
  const cached = botFilePathCache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) return { path: cached.path, source: 'memory' };

  const shared = sharedThumbnailCache();
  if (shared) {
    try {
      const value = await shared.get(`bot-file-path:${fileId}`);
      if (value?.path && typeof value.path === 'string') {
        botFilePathCache.set(fileId, { path: value.path, expiresAt: Date.now() + BOT_FILE_PATH_TTL_MS });
        return { path: value.path, source: 'runtime' };
      }
    } catch (error) {
      console.warn('[telegram-thumbnail-gateway] runtime file-path cache read failed', error?.message || error);
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
      console.warn('[telegram-thumbnail-gateway] runtime file-path cache write failed', error?.message || error);
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

function pickThumbnail(raw, messageType) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const key = messageType === 'video_note' ? 'video_note' : messageType;
  const item = value[key] && typeof value[key] === 'object' ? value[key] : null;
  if (!item) return null;
  const thumb = item.thumbnail || item.thumb || null;
  if (!thumb?.file_id) return null;
  return {
    fileId: String(thumb.file_id),
    size: Number(thumb.file_size || 0),
    mimeType: 'image/jpeg',
    name: 'telegram-thumbnail.jpg'
  };
}

async function resolveThumbnailMetadata(ticket) {
  const shared = sharedThumbnailCache();
  const cacheKey = `thumbnail-meta:${ticket.source_id}:${ticket.message_id}`;
  if (shared) {
    try {
      const cached = await shared.get(cacheKey);
      if (cached?.fileId) return { ...cached, metaCache: 'runtime' };
    } catch (error) {
      console.warn('[telegram-thumbnail-gateway] runtime metadata cache read failed', error?.message || error);
    }
  }

  const rows = await select(
    TABLES.sourceMessages,
    `select=id,source_id,message_type,raw_message&id=eq.${encodeURIComponent(ticket.message_id)}&source_id=eq.${encodeURIComponent(ticket.source_id)}&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] || null : null;
  if (!row) throw new GatewayError('media_not_found', 404);
  const thumbnail = pickThumbnail(row.raw_message, row.message_type);
  if (!thumbnail) throw new GatewayError('thumbnail_not_found', 404);

  if (shared) {
    try {
      await shared.set(cacheKey, thumbnail, {
        ttl: THUMBNAIL_CACHE_TTL_SECONDS,
        tags: ['telegram-thumbnail-meta'],
        name: 'telegram-thumbnail-meta'
      });
    } catch (error) {
      console.warn('[telegram-thumbnail-gateway] runtime metadata cache write failed', error?.message || error);
    }
  }
  return { ...thumbnail, metaCache: 'database' };
}

async function resolveTicketThumbnail(ticketToken) {
  if (!UUID_RE.test(ticketToken)) throw new GatewayError('invalid_ticket', 400);
  const ticket = await loadTicket(ticketToken);
  if (!ticket || ticket.revoked_at) throw new GatewayError('ticket_invalid', 403);
  if (!ticket.expires_at || Date.parse(ticket.expires_at) <= Date.now()) throw new GatewayError('ticket_expired', 403);
  return resolveThumbnailMetadata(ticket);
}

function setThumbnailHeaders(res, thumbnail, contentType, length, cacheSource) {
  res.statusCode = 200;
  res.setHeader('Content-Type', String(contentType || '').toLowerCase().startsWith('image/') ? contentType : thumbnail.mimeType);
  if (Number.isFinite(Number(length)) && Number(length) >= 0) res.setHeader('Content-Length', String(length));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(thumbnail.name)}`);
  res.setHeader('Cache-Control', `private, max-age=${THUMBNAIL_BROWSER_TTL_SECONDS}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Thumbnail-Cache', cacheSource);
}

async function loadCachedThumbnailBytes(thumbnail) {
  const memory = thumbnailMemoryCache.get(thumbnail.fileId);
  if (memory && memory.expiresAt > Date.now()) {
    return { bytes: memory.bytes, contentType: memory.contentType, source: 'memory' };
  }

  const shared = sharedThumbnailCache();
  if (!shared) return null;
  try {
    const cached = await shared.get(`thumbnail-bytes:${thumbnail.fileId}`);
    if (!cached?.bodyBase64) return null;
    const bytes = Buffer.from(cached.bodyBase64, 'base64');
    const contentType = String(cached.contentType || thumbnail.mimeType);
    thumbnailMemoryCache.set(thumbnail.fileId, {
      bytes,
      contentType,
      expiresAt: Date.now() + THUMBNAIL_CACHE_TTL_SECONDS * 1000
    });
    return { bytes, contentType, source: 'runtime' };
  } catch (error) {
    console.warn('[telegram-thumbnail-gateway] runtime bytes cache read failed', error?.message || error);
    return null;
  }
}

async function saveThumbnailBytes(thumbnail, bytes, contentType) {
  thumbnailMemoryCache.set(thumbnail.fileId, {
    bytes,
    contentType,
    expiresAt: Date.now() + THUMBNAIL_CACHE_TTL_SECONDS * 1000
  });
  if (bytes.length > THUMBNAIL_MAX_CACHE_BYTES) return;

  const shared = sharedThumbnailCache();
  if (!shared) return;
  try {
    await shared.set(`thumbnail-bytes:${thumbnail.fileId}`, {
      bodyBase64: bytes.toString('base64'),
      contentType
    }, {
      ttl: THUMBNAIL_CACHE_TTL_SECONDS,
      tags: ['telegram-thumbnail-bytes'],
      name: 'telegram-thumbnail-bytes'
    });
  } catch (error) {
    console.warn('[telegram-thumbnail-gateway] runtime bytes cache write failed', error?.message || error);
  }
}

async function streamThumbnail(req, res, thumbnail) {
  const cacheStartedAt = Date.now();
  const cached = await loadCachedThumbnailBytes(thumbnail);
  appendServerTiming(res, `thumbnail-bytes-${cached?.source || 'miss'}`, Date.now() - cacheStartedAt);
  if (cached) {
    setThumbnailHeaders(res, thumbnail, cached.contentType, cached.bytes.length, cached.source);
    if (req.method === 'HEAD') return res.end();
    return res.end(cached.bytes);
  }

  const getFileStartedAt = Date.now();
  const fileInfo = await botFilePath(thumbnail.fileId);
  appendServerTiming(res, `thumbnail-file-${fileInfo.source}`, Date.now() - getFileStartedAt);
  const botToken = clean(requireEnv('TELEGRAM_BOT_TOKEN'));
  const upstreamStartedAt = Date.now();
  const upstream = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileInfo.path}`);
  if (!upstream.ok) throw new GatewayError('telegram_file_fetch_failed', 502);
  appendServerTiming(res, 'thumbnail-file-headers', Date.now() - upstreamStartedAt);

  const upstreamType = String(upstream.headers.get('content-type') || '').toLowerCase();
  const contentType = upstreamType.startsWith('image/') ? upstreamType : thumbnail.mimeType;
  if (req.method === 'HEAD') {
    const length = Number(upstream.headers.get('content-length') || thumbnail.size || 0);
    setThumbnailHeaders(res, thumbnail, contentType, length, 'miss');
    try { await upstream.body?.cancel(); } catch {}
    return res.end();
  }

  const bodyStartedAt = Date.now();
  const bytes = Buffer.from(await upstream.arrayBuffer());
  appendServerTiming(res, 'thumbnail-file-body', Date.now() - bodyStartedAt);
  await saveThumbnailBytes(thumbnail, bytes, contentType);
  setThumbnailHeaders(res, thumbnail, contentType, bytes.length, 'telegram');
  return res.end(bytes);
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
    const thumbnail = await resolveTicketThumbnail(ticketToken);
    appendServerTiming(res, `ticket-thumbnail-${thumbnail.metaCache || 'unknown'}`, Date.now() - requestStartedAt);
    await streamThumbnail(req, res, thumbnail);
    console.info(`[telegram-thumbnail-gateway] method=${req.method} meta_cache=${thumbnail.metaCache || 'unknown'} byte_cache=${String(res.getHeader('X-Thumbnail-Cache') || 'none')} elapsed_ms=${Date.now() - requestStartedAt}`);
  } catch (error) {
    const code = error?.code || 'thumbnail_gateway_failed';
    const status = Number(error?.status || 500);
    console.error('[telegram-thumbnail-gateway]', code, error?.message || error);
    if (!res.headersSent) return json(res, status, { ok: false, error: code });
    if (!res.writableEnded) res.end();
  }
}
