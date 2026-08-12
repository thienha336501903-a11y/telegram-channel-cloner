import { json, method, readJson } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { botApiChatIdToPrivateLinkId } from '../../lib/links.js';
import { upsertSource } from '../../lib/repository.js';

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (req.headers.authorization !== `Bearer ${requireEnv('READER_INGEST_SECRET')}`) return json(res, 401, { ok: false, error: 'unauthorized' });
  const body = await readJson(req);
  if (!body.chat_id) return json(res, 400, { ok: false, error: 'chat_id_required' });
  const rows = await upsertSource({
    chat_id: String(body.chat_id),
    title: body.title || null,
    username: body.username || null,
    private_link_id: body.private_link_id || botApiChatIdToPrivateLinkId(body.chat_id),
    active: true,
    indexed_at: null
  });
  json(res, 200, { ok: true, source: rows[0] });
}
