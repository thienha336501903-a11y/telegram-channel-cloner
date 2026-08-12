import { isAuthenticated } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';
import { getChat } from '../../lib/telegram.js';
import { upsertDestination } from '../../lib/repository.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!body.chat_id) return json(res, 400, { ok: false, error: 'chat_id_required' });
  const chat = await getChat(body.chat_id);
  if (chat.type !== 'channel') return json(res, 400, { ok: false, error: 'destination_must_be_channel' });
  const rows = await upsertDestination({
    chat_id: String(chat.id),
    title: chat.title || body.title || null,
    username: chat.username || null,
    active: body.active !== false,
    verified_at: new Date().toISOString()
  });
  json(res, 200, { ok: true, destination: rows[0] });
}
