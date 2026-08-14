import { json } from '../../lib/http.js';
import { telegram } from '../../lib/telegram.js';

const CHAT_ID = '-1004486574754';
const TEST_TEXT = '__clone_factory_test_v4_webhook_20260814';

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') return json(res, 404, { ok: false, error: 'not_found' });
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const deleteId = Number(req.query?.delete || 0);
    if (Number.isInteger(deleteId) && deleteId > 0) {
      const deleted = await telegram('deleteMessage', { chat_id: CHAT_ID, message_id: deleteId });
      return json(res, 200, { ok: Boolean(deleted), action: 'delete', messageId: deleteId });
    }
    const sent = await telegram('sendMessage', {
      chat_id: CHAT_ID,
      text: TEST_TEXT,
      disable_notification: true,
      protect_content: true
    });
    return json(res, 200, { ok: true, action: 'send', messageId: sent?.message_id || null, text: TEST_TEXT });
  } catch (error) {
    return json(res, 503, { ok: false, error: error?.message || 'telegram_e2e_failed', code: error?.errorCode || null });
  }
}
