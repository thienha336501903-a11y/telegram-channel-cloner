import { json } from '../../lib/http.js';
import { telegram } from '../../lib/telegram.js';

const CHAT_ID = '-1004486574754';
const TEST_MESSAGE_ID = 16;

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') return json(res, 404, { ok: false, error: 'not_found' });
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const cleanup = { attempted: true, deleted: false, error: null };
  try {
    cleanup.deleted = Boolean(await telegram('deleteMessage', { chat_id: CHAT_ID, message_id: TEST_MESSAGE_ID }));
  } catch (error) {
    cleanup.error = error?.message || 'delete_failed';
  }
  try {
    const chat = await telegram('getChat', { chat_id: CHAT_ID });
    return json(res, 200, {
      ok: true,
      cleanup,
      chat: {
        id: String(chat?.id || ''),
        title: chat?.title || null,
        type: chat?.type || null,
        hasProtectedContent: Boolean(chat?.has_protected_content)
      }
    });
  } catch (error) {
    return json(res, 503, { ok: false, cleanup, error: error?.message || 'telegram_probe_failed', code: error?.errorCode || null });
  }
}
