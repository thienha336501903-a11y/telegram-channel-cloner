import { json } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { getMtprotoClient } from '../../lib/mtproto-media.js';

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

async function requireActiveTicket(token) {
  if (!UUID_RE.test(token)) return { ok: false, status: 400, error: 'invalid_ticket' };
  const base = clean(requireEnv('SUPABASE_URL')).replace(/\/$/, '');
  const qs = new URLSearchParams({
    select: 'token,expires_at,revoked_at',
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
  return { ok: true };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  try {
    const ticket = String(req.query?.ticket || '').trim();
    const access = await requireActiveTicket(ticket);
    if (!access.ok) return json(res, access.status, { ok: false, error: access.error });

    const startedAt = Date.now();
    await getMtprotoClient();
    res.setHeader('Server-Timing', `mtproto-warmup;dur=${Date.now() - startedAt}`);
    res.statusCode = 204;
    return res.end();
  } catch (error) {
    console.error('[telegram-mtproto-warmup]', error?.message || error);
    return json(res, 500, { ok: false, error: 'mtproto_warmup_failed' });
  }
}
