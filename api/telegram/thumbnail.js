import { Readable } from 'node:stream';
import { json } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { telegram } from '../../lib/telegram.js';

const TICKET_TABLE = 'lms_v4_media_tickets';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOT_FILE_PATH_TTL_MS = 50 * 60 * 1000;
const botFilePathCache = new Map();

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

async function botFilePath(fileId) {
  const cached = botFilePathCache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) return { path: cached.path, cached: true };
  const fileInfo = await telegram('getFile', { file_id: fileId });
  if (!fileInfo?.file_path) throw new GatewayError('telegram_get_file_failed', 502);
  botFilePathCache.set(fileId, {
    path: fileInfo.file_path,
    expiresAt: Date.now() + BOT_FILE_PATH_TTL_MS
  });
  return { path: fileInfo.file_path, cached: false };
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

async function resolveTicketThumbnail(ticketToken) {
  if (!UUID_RE.test(ticketToken)) throw new GatewayError('invalid_ticket', 400);
  const ticket = await loadTicket(ticketToken);
  if (!ticket || ticket.revoked_at) throw new GatewayError('ticket_invalid', 403);
  if (!ticket.expires_at || Date.parse(ticket.expires_at) <= Date.now()) throw new GatewayError('ticket_expired', 403);

  const rows = await select(
    TABLES.sourceMessages,
    `select=id,source_id,message_type,raw_message&id=eq.${encodeURIComponent(ticket.message_id)}&source_id=eq.${encodeURIComponent(ticket.source_id)}&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] || null : null;
  if (!row) throw new GatewayError('media_not_found', 404);
  const thumbnail = pickThumbnail(row.raw_message, row.message_type);
  if (!thumbnail) throw new GatewayError('thumbnail_not_found', 404);
  return thumbnail;
}

async function streamThumbnail(req, res, thumbnail) {
  const getFileStartedAt = Date.now();
  const fileInfo = await botFilePath(thumbnail.fileId);
  appendServerTiming(res, fileInfo.cached ? 'thumbnail-file-cache' : 'thumbnail-get-file', Date.now() - getFileStartedAt);
  const botToken = clean(requireEnv('TELEGRAM_BOT_TOKEN'));
  const upstreamStartedAt = Date.now();
  const upstream = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileInfo.path}`);
  if (!upstream.ok || !upstream.body) throw new GatewayError('telegram_file_fetch_failed', 502);
  appendServerTiming(res, 'thumbnail-file-headers', Date.now() - upstreamStartedAt);

  res.statusCode = 200;
  const upstreamType = String(upstream.headers.get('content-type') || '').toLowerCase();
  res.setHeader('Content-Type', upstreamType.startsWith('image/') ? upstreamType : thumbnail.mimeType);
  const length = upstream.headers.get('content-length');
  if (length) res.setHeader('Content-Length', length);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(thumbnail.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'HEAD') {
    try { await upstream.body.cancel(); } catch {}
    return res.end();
  }
  Readable.fromWeb(upstream.body).pipe(res);
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
    appendServerTiming(res, 'ticket-thumbnail', Date.now() - requestStartedAt);
    await streamThumbnail(req, res, thumbnail);
    console.info(`[telegram-thumbnail-gateway] method=${req.method} elapsed_ms=${Date.now() - requestStartedAt}`);
  } catch (error) {
    const code = error?.code || 'thumbnail_gateway_failed';
    const status = Number(error?.status || 500);
    console.error('[telegram-thumbnail-gateway]', code, error?.message || error);
    if (!res.headersSent) return json(res, status, { ok: false, error: code });
    if (!res.writableEnded) res.end();
  }
}
