import { json, method, readJson } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { patch } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (req.headers.authorization !== `Bearer ${requireEnv('READER_INGEST_SECRET')}`) return json(res, 401, { ok: false, error: 'unauthorized' });
  const body = await readJson(req);
  if (!body.source_id) return json(res, 400, { ok: false, error: 'source_id_required' });
  const rows = await patch('telegram_sources', `id=eq.${encodeURIComponent(body.source_id)}`, { indexed_at: new Date().toISOString(), indexed_message_count: Number(body.message_count || 0) });
  json(res, 200, { ok: true, source: rows[0] || null });
}
