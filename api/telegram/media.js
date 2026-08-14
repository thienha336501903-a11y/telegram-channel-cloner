import { Readable } from 'node:stream';
import { json } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { telegram } from '../../lib/telegram.js';

const BOT_API_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const TICKET_TABLE = 'lms_v4_media_tickets';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  try {
    const ticketToken = String(req.query?.ticket || '').trim();
    if (!UUID_RE.test(ticketToken)) return json(res, 400, { ok: false, error: 'invalid_ticket' });

    const ticket = await loadTicket(ticketToken);
    if (!ticket || ticket.revoked_at) return json(res, 403, { ok: false, error: 'ticket_invalid' });
    if (!ticket.expires_at || Date.parse(ticket.expires_at) <= Date.now()) {
      return json(res, 403, { ok: false, error: 'ticket_expired' });
    }

    const rows = await select(
      TABLES.sourceMessages,
      `select=id,source_id,message_type,raw_message&id=eq.${encodeURIComponent(ticket.message_id)}&source_id=eq.${encodeURIComponent(ticket.source_id)}&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] || null : null;
    if (!row) return json(res, 404, { ok: false, error: 'media_not_found' });

    const media = pickMedia(row.raw_message, row.message_type);
    if (!media?.fileId) return json(res, 409, { ok: false, error: 'media_file_id_missing' });
    if (media.size > BOT_API_DOWNLOAD_LIMIT) {
      return json(res, 409, { ok: false, error: 'mtproto_required' });
    }

    const fileInfo = await telegram('getFile', { file_id: media.fileId });
    if (!fileInfo?.file_path) return json(res, 502, { ok: false, error: 'telegram_get_file_failed' });

    const botToken = clean(requireEnv('TELEGRAM_BOT_TOKEN'));
    const upstreamHeaders = {};
    const range = String(req.headers.range || '').trim();
    if (range) upstreamHeaders.Range = range;

    const upstream = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`,
      { headers: upstreamHeaders }
    );
    if ((!upstream.ok && upstream.status !== 206) || !upstream.body) {
      return json(res, 502, { ok: false, error: 'telegram_file_fetch_failed' });
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

    if (req.method === 'HEAD') return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error('[telegram-media-gateway]', error);
    if (!res.headersSent) return json(res, 500, { ok: false, error: 'media_gateway_failed' });
    res.end();
  }
}
