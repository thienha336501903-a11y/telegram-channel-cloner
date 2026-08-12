import { json, method, readJson } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { normalizeBotChannelPost, linksForNormalizedMessage } from '../../lib/source-message.js';
import { getActiveSource, listDestinations, recordInternalLinks, upsertSourceMessage } from '../../lib/repository.js';
import { insert } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

async function enqueue(source, normalized, { edited = false, hasInternalLinks = false } = {}) {
  const destinations = (await listDestinations({ activeOnly: true })).filter((d) => d.source_id === source.id || !d.source_id);
  for (const destination of destinations) {
    const [job] = await insert(TABLES.cloneJobs, { source_id: source.id, destination_id: destination.id, mode: 'live_mirror', status: 'queued' });
    if (!edited) {
      await insert(TABLES.cloneJobItems, { job_id: job.id, source_message_id: normalized.source_message_id, source_message_ids: [normalized.source_message_id], phase: 'copy', status: 'queued' }, { returning: false });
    }
    if (edited || hasInternalLinks) {
      await insert(TABLES.cloneJobItems, { job_id: job.id, source_message_id: normalized.source_message_id, source_message_ids: [normalized.source_message_id], phase: 'rewrite', status: 'queued' }, { returning: false });
    }
  }
}

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  const secret = requireEnv('TELEGRAM_WEBHOOK_SECRET');
  if (req.headers['x-telegram-bot-api-secret-token'] !== secret) return json(res, 401, { ok: false });
  const update = await readJson(req, { maxBytes: 5_000_000 });
  const message = update.channel_post || update.edited_channel_post;
  if (!message) return json(res, 200, { ok: true, ignored: true });

  const source = await getActiveSource();
  if (!source || String(message.chat?.id) !== String(source.chat_id)) return json(res, 200, { ok: true, ignored: true });

  const normalized = normalizeBotChannelPost(message);
  const links = linksForNormalizedMessage(normalized, source);
  const [saved] = await upsertSourceMessage({
    source_id: source.id,
    source_message_id: normalized.source_message_id,
    media_group_id: normalized.media_group_id,
    message_type: normalized.message_type,
    text: normalized.text,
    text_entities: normalized.text_entities,
    caption: normalized.caption,
    caption_entities: normalized.caption_entities,
    reply_to_source_message_id: normalized.reply_to_source_message_id,
    is_pinned: normalized.is_pinned,
    raw_message: normalized.raw_message,
    source_date: normalized.source_date,
    has_internal_links: links.length > 0,
    updated_at: new Date().toISOString()
  });
  await recordInternalLinks(source.id, saved.id, links);
  await enqueue(source, normalized, { edited: Boolean(update.edited_channel_post), hasInternalLinks: links.length > 0 });
  json(res, 200, { ok: true });
}
