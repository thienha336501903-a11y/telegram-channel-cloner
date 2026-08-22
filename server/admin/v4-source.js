import { isAuthenticated } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';
import { botApiChatIdToPrivateLinkId } from '../../lib/links.js';
import { queueReaderJob } from '../../lib/reader-jobs.js';
import { getSourceByChatId, upsertSource } from '../../lib/repository.js';
import { getChat } from '../../lib/telegram.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['POST'])) return;

  const body = await readJson(req);
  if (!body.chat_id) return json(res, 400, { ok: false, error: 'chat_id_required' });

  const chat = await getChat(body.chat_id);
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
    history_import_required: !source?.indexed_at,
    reader_job: readerJob,
    reader_job_created: readerJobCreated
  });
}
