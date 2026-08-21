import { json, method } from '../../lib/http.js';
import { telegram } from '../../lib/telegram.js';

export default async function handler(req, res) {
  if (!method(req, res, ['GET'])) return;
  try {
    const me = await telegram('getMe');
    return json(res, 200, {
      ok: true,
      bot: {
        id: Number(me?.id || 0) || null,
        username: me?.username || null,
        first_name: me?.first_name || null,
        can_join_groups: Boolean(me?.can_join_groups),
        can_read_all_group_messages: Boolean(me?.can_read_all_group_messages),
        supports_inline_queries: Boolean(me?.supports_inline_queries)
      }
    });
  } catch (error) {
    return json(res, 500, { ok: false, error: error?.message || 'get_me_failed' });
  }
}
