import { isAuthenticated } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';
import { botApiChatIdToPrivateLinkId } from '../../lib/links.js';
import { upsertSource } from '../../lib/repository.js';
import { patch } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { getChat } from '../../lib/telegram.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!body.chat_id) return json(res, 400, { ok: false, error: 'chat_id_required' });

  const chat = await getChat(body.chat_id);
  if (chat.type !== 'channel') return json(res, 400, { ok: false, error: 'source_must_be_channel' });

  await patch(TABLES.sources, 'active=eq.true', { active: false, updated_at: new Date().toISOString() }, { returning: false });
  const rows = await upsertSource({
    chat_id: String(chat.id),
    title: chat.title || null,
    username: chat.username || null,
    private_link_id: botApiChatIdToPrivateLinkId(chat.id),
    active: true,
    updated_at: new Date().toISOString()
  });

  json(res, 200, { ok: true, source: rows[0] });
}
