import { json } from '../lib/http.js';

function clean(value) {
  return String(value || '').trim().replace(/^[\'\"]|[\'\"]$/g, '');
}

function meta(value) {
  const key = clean(value);
  if (!key) return { present: false };
  if (key.startsWith('sb_secret_')) return { present: true, kind: 'sb_secret' };
  const parts = key.split('.');
  if (parts.length !== 3) return { present: true, kind: 'opaque_or_invalid' };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      present: true,
      kind: 'jwt',
      role: payload?.role || null,
      iat: Number(payload?.iat || 0) || null,
      exp: Number(payload?.exp || 0) || null,
      iatIso: payload?.iat ? new Date(Number(payload.iat) * 1000).toISOString() : null,
      expIso: payload?.exp ? new Date(Number(payload.exp) * 1000).toISOString() : null
    };
  } catch {
    return { present: true, kind: 'jwt_unparseable' };
  }
}

async function probe(name, value) {
  const key = clean(value);
  const info = meta(key);
  if (!key) return { name, ...info };
  const url = clean(process.env.SUPABASE_URL).replace(/\/$/, '');
  const headers = { apikey: key };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  try {
    const r = await fetch(`${url}/rest/v1/tgcloner_sources?select=id&limit=1`, { headers });
    let error = null;
    if (!r.ok) {
      try {
        const body = await r.json();
        error = { code: body?.code || null, message: body?.message || null };
      } catch {
        error = { message: `HTTP ${r.status}` };
      }
    }
    return { name, ...info, status: r.status, ok: r.ok, error };
  } catch (e) {
    return { name, ...info, status: null, ok: false, error: { message: e?.message || 'probe_failed' } };
  }
}

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') return json(res, 404, { ok: false, error: 'not_found' });
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.all([
    probe('SUPABASE_SECRET_KEY', process.env.SUPABASE_SECRET_KEY),
    probe('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY)
  ]);
  return json(res, 200, { ok: true, now, nowIso: new Date(now * 1000).toISOString(), results });
}
