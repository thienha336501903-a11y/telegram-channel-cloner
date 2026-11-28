import { isAuthenticated } from '../../lib/auth.js';
import { json, method } from '../../lib/http.js';
import { getMe, telegram, TelegramError } from '../../lib/telegram.js';

// Read-only: shows which bot TELEGRAM_BOT_TOKEN belongs to and, optionally, its rights in one chat.
// Only getMe/getChatMember are called; the token never appears in the response.
const PERMISSIONS = ['can_post_messages', 'can_edit_messages', 'can_pin_messages', 'can_delete_messages', 'can_manage_chat'];

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['GET'])) return;

  const rawChatId = req.query?.chat_id;
  const chatId = rawChatId === undefined || rawChatId === '' ? null : String(rawChatId);
  if (chatId !== null && !/^-\d{5,20}$/.test(chatId)) return json(res, 400, { ok: false, error: 'chat_id_invalid' });

  try {
    const me = await getMe();
    const bot = { id: me.id, username: me.username, first_name: me.first_name };
    if (chatId === null) return json(res, 200, { ok: true, bot });

    const member = await telegram('getChatMember', { chat_id: chatId, user_id: me.id });
    const rights = Object.fromEntries(PERMISSIONS.map((key) => [key, member[key] === true]));
    return json(res, 200, { ok: true, bot, chat_id: chatId, member: { status: member.status, ...rights } });
  } catch (error) {
    if (error instanceof TelegramError) return json(res, 502, { ok: false, error: 'telegram_error', method: error.method, description: error.message });
    throw error;
  }
}
