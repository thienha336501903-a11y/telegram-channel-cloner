import { json, method, readJson } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { normalizeBotChannelPost, linksForNormalizedMessage } from '../../lib/source-message.js';
import {
  getSourceByChatId,
  getSourceMessage,
  listDestinations,
  recordInternalLinks,
  syncSourceIndexedMessageCount,
  upsertSourceMessage
} from '../../lib/repository.js';
import { insert, patch } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

async function enqueue(source, normalized, { edited = false, hasInternalLinks = false } = {}) {
  // Only the current MASTER participates in the clone/mirror queue. Inactive
  // registered sources are still indexed for V4 course playback, but must not
  // unexpectedly mirror into generic destinations.
  if (!source?.active) return;
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

function selfForwardOrigin(message) {
  const origin = message?.forward_origin && typeof message.forward_origin === 'object'
    ? message.forward_origin
    : null;
  const originChatId = origin?.chat?.id ?? message?.forward_from_chat?.id;
  const originMessageId = origin?.message_id ?? message?.forward_from_message_id;
  if (!originMessageId || String(originChatId ?? '') !== String(message?.chat?.id ?? '')) return null;
  return Number(originMessageId) || null;
}

async function hydrateHistoricalSelfForward(source, message) {
  const originalMessageId = selfForwardOrigin(message);
  if (!originalMessageId) return false;

  const original = await getSourceMessage(source.id, originalMessageId);
  if (!original?.raw_message?.from_reader) return false;

  await patch(TABLES.sourceMessages, `id=eq.${encodeURIComponent(original.id)}`, {
    raw_message: {
      ...message,
      from_reader: true,
      from_history_self_forward: true,
      original_source_message_id: originalMessageId,
      temp_forward_message_id: Number(message?.message_id || 0) || null
    },
    updated_at: new Date().toISOString()
  }, { returning: false });
  return true;
}

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  const secret = requireEnv('TELEGRAM_WEBHOOK_SECRET');
  if (req.headers['x-telegram-bot-api-secret-token'] !== secret) return json(res, 401, { ok: false });
  const update = await readJson(req, { maxBytes: 5_000_000 });
  const message = update.channel_post || update.edited_channel_post;
  if (!message) return json(res, 200, { ok: true, ignored: true });

  // V4 supports many course sources at the same time. Any Telegram channel that
  // has already been registered in tgcloner_sources keeps receiving/indexing live
  // channel posts even after another source becomes the current MASTER.
  const source = await getSourceByChatId(message.chat?.id);
  if (!source) return json(res, 200, { ok: true, ignored: true });

  // Historical media hydration temporarily forwards an old post back into the
  // same channel so Bot API returns reusable file_id / thumbnail metadata. When
  // that temporary post hits the webhook, enrich the already-indexed original
  // row instead of creating a fifth/duplicate V4 lesson or mirror job.
  if (!update.edited_channel_post && await hydrateHistoricalSelfForward(source, message)) {
    return json(res, 200, { ok: true, ignored: true, hydrated_history: true });
  }

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
  await syncSourceIndexedMessageCount(source.id);
  await recordInternalLinks(source.id, saved.id, links);
  await enqueue(source, normalized, { edited: Boolean(update.edited_channel_post), hasInternalLinks: links.length > 0 });
  json(res, 200, { ok: true, indexed: true, mirrored: Boolean(source.active) });
}
