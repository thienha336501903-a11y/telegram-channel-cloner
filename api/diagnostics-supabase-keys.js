import { json } from '../lib/http.js';
import { select } from '../lib/supabase.js';
import { TABLES } from '../lib/tables.js';

const BOT_LIMIT = 20 * 1024 * 1024;
const CAGIATAY_SOURCE_ID = 'de2e9a07-631b-4e93-8140-24c3b8893ec3';

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

function videoMeta(row) {
  const item = row?.raw_message?.video;
  if (!item) return null;
  return {
    messageId: Number(row.source_message_id),
    fileId: String(item.file_id || ''),
    size: Number(item.file_size || 0),
    name: String(item.file_name || '')
  };
}

async function telegramMediaProbe() {
  const token = clean(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) return { ok: false, error: 'bot_token_missing' };
  const rows = await select(TABLES.sourceMessages, `select=source_message_id,message_type,raw_message&source_id=eq.${encodeURIComponent(CAGIATAY_SOURCE_ID)}&message_type=eq.video&order=source_message_id.asc`);
  const videos = (rows || []).map(videoMeta).filter(Boolean);
  const small = videos.find((v) => v.size < 10 * 1024 * 1024) || videos[0] || null;
  const near = videos.find((v) => v.size > 18 * 1024 * 1024 && v.size <= BOT_LIMIT) || null;
  const large = videos.find((v) => v.size > BOT_LIMIT) || null;
  const samples = [];

  for (const video of [small, near, large].filter(Boolean)) {
    const infoResponse = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(video.fileId)}`);
    const info = await infoResponse.json().catch(() => null);
    const sample = {
      messageId: video.messageId,
      name: video.name,
      size: video.size,
      withinBotLimit: video.size <= BOT_LIMIT,
      getFileStatus: infoResponse.status,
      getFileOk: Boolean(info?.ok),
      description: info?.description || null,
      range: null
    };
    if (infoResponse.ok && info?.ok && info?.result?.file_path) {
      const fileResponse = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`, { headers: { Range: 'bytes=0-1023' } });
      sample.range = {
        status: fileResponse.status,
        contentLength: fileResponse.headers.get('content-length'),
        contentRange: fileResponse.headers.get('content-range'),
        acceptRanges: fileResponse.headers.get('accept-ranges')
      };
      try { await fileResponse.body?.cancel(); } catch {}
    }
    samples.push(sample);
  }

  return { ok: true, totalVideos: videos.length, samples };
}

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') return json(res, 404, { ok: false, error: 'not_found' });
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  const run = String(req.query?.run || '');
  if (run === 'cagiatay') {
    const module = await import('./telegram/cagiatay-backfill-once.js');
    return module.default(req, res);
  }
  if (run === 'media') return json(res, 200, await telegramMediaProbe());

  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.all([
    probe('SUPABASE_SECRET_KEY', process.env.SUPABASE_SECRET_KEY),
    probe('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY)
  ]);
  return json(res, 200, { ok: true, now, nowIso: new Date(now * 1000).toISOString(), results });
}
