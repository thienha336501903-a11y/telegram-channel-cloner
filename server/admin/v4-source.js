import { isAuthenticated } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';
import { botApiChatIdToPrivateLinkId, normalizeTelegramSourceRef } from '../../lib/links.js';
import { queueReaderJob } from '../../lib/reader-jobs.js';
import { getSourceByChatId, upsertSource } from '../../lib/repository.js';
import { getChat } from '../../lib/telegram.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['POST'])) return;

  const body = await readJson(req);
  let sourceRef;
  try {
    sourceRef = normalizeTelegramSourceRef(body.source_ref || body.chat_id);
  } catch {
    return json(res, 400, { ok: false, error: 'telegram_post_link_or_channel_required' });
  }

  const chat = await getChat(sourceRef.chatId);
  if (chat.type !== 'channel') return json(res, 400, { ok: false, error: 'source_must_be_channel' });

  const existing = await getSourceByChatId(chat.id);
  const rows = await upsertSource({
    chat_id: String(chat.id),
    title: chat.title || null,
    username: chat.username || null,
    private_link_id: botApiChatIdToPrivateLinkId(chat.id),
    active: Boolean(existing?.active),
    updated_at: new Date().toISOString()
  });
  const source = rows[0];

  let readerJob = null;
  let readerJobCreated = false;
  if (!source?.indexed_at) {
    try {
      const queued = await queueReaderJob(source);
      readerJob = queued.job;
      readerJobCreated = queued.created;
    } catch (error) {
      console.warn('[v4-source] reader job queue failed', error?.message || error);
    }
  }

  json(res, 200, {
    ok: true,
    source,
    already_registered: Boolean(existing),
    mirror_master: Boolean(existing?.active),
    resolved_chat_id: String(chat.id),
    source_message_id: sourceRef.messageId,
    history_import_required: !source?.indexed_at,
    reader_job: readerJob,
    reader_job_created: readerJobCreated
  });
}
