import { json } from '../../lib/http.js';
import { telegram, getMe } from '../../lib/telegram.js';

const CHAT_ID = '-1004486574754';

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') return json(res, 404, { ok: false, error: 'not_found' });
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  try {
    const me = await getMe();
    const chat = await telegram('getChat', { chat_id: CHAT_ID });
    const member = await telegram('getChatMember', { chat_id: CHAT_ID, user_id: me.id });
    return json(res, 200, {
      ok: true,
      bot: { id: me.id, username: me.username || null },
      chat: { id: String(chat?.id || ''), title: chat?.title || null, type: chat?.type || null },
      member: {
        status: member?.status || null,
        canPostMessages: Boolean(member?.can_post_messages),
        canEditMessages: Boolean(member?.can_edit_messages),
        canDeleteMessages: Boolean(member?.can_delete_messages),
        canInviteUsers: Boolean(member?.can_invite_users),
        canManageChat: Boolean(member?.can_manage_chat)
      }
    });
  } catch (error) {
    return json(res, 503, { ok: false, error: error?.message || 'telegram_access_check_failed', code: error?.errorCode || null });
  }
}
