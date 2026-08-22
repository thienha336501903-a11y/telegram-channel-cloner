import { json, method, readJson } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { botApiChatIdToPrivateLinkId } from '../../lib/links.js';
import { getSourceByChatId, upsertSource } from '../../lib/repository.js';
import { getChat } from '../../lib/telegram.js';

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (req.headers.authorization !== `Bearer ${requireEnv('READER_INGEST_SECRET')}`) return json(res, 401, { ok: false, error: 'unauthorized' });
  const body = await readJson(req);
  if (!body.chat_id) return json(res, 400, { ok: false, error: 'chat_id_required' });

  // Historical media is served later by the Cloner bot over MTProto. Refuse to
  // register a Reader-only source that the bot itself cannot access, otherwise
  // indexing would succeed but learner media would fail only at playback time.
  const chatId = String(body.chat_id);
  let botChat;
  try {
    botChat = await getChat(chatId);
  } catch (error) {
    console.warn('[reader-register-source] bot cannot access source', error?.message || error);
    return json(res, 409, {
      ok: false,
      error: 'telegram_bot_source_access_required',
      hint: 'Add the Cloner bot to this Telegram channel, then run history import again.'
    });
  }
  if (botChat?.type !== 'channel') {
    return json(res, 400, { ok: false, error: 'source_must_be_channel' });
  }

  // Historical indexing is source-scoped. It must never promote a V4 source to
  // clone/mirror MASTER. Existing MASTER state is preserved; a new source is
  // registered as non-MASTER and can still be used/indexed by V4.
  const existing = await getSourceByChatId(chatId);
  const rows = await upsertSource({
    chat_id: chatId,
    title: botChat.title || body.title || existing?.title || null,
    username: botChat.username || body.username || existing?.username || null,
    private_link_id: body.private_link_id || existing?.private_link_id || botApiChatIdToPrivateLinkId(body.chat_id),
    active: Boolean(existing?.active)
  });
  json(res, 200, {
    ok: true,
    source: rows[0],
    already_registered: Boolean(existing),
    mirror_master: Boolean(existing?.active),
    bot_access_verified: true
  });
}
