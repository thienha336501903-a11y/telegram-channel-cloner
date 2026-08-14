import { json } from '../../lib/http.js';
import { telegram, retryAfterSeconds } from '../../lib/telegram.js';
import { normalizeBotChannelPost } from '../../lib/source-message.js';
import { getActiveSourceByChatId, logEvent, upsertSourceMessage } from '../../lib/repository.js';
import { patch } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

const CHAT_ID = '-1004486574754';
const FIRST_SOURCE_MESSAGE_ID = 1;
const LAST_SOURCE_MESSAGE_ID = 15;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function telegramWithRetry(method, params) {
  try {
    return await telegram(method, params);
  } catch (error) {
    const retryAfter = retryAfterSeconds(error);
    if (!retryAfter) throw error;
    await sleep((retryAfter * 1000) + 250);
    return telegram(method, params);
  }
}

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') return json(res, 404, { ok: false, error: 'not_found' });
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  const source = await getActiveSourceByChatId(CHAT_ID);
  if (!source) return json(res, 404, { ok: false, error: 'source_not_found' });

  const chat = await telegram('getChat', { chat_id: CHAT_ID });
  if (chat?.has_protected_content) {
    return json(res, 409, { ok: false, error: 'protected_content_still_enabled' });
  }

  const result = { attempted: 0, indexed: 0, skipped: 0, types: {}, errors: [] };

  for (let originalId = FIRST_SOURCE_MESSAGE_ID; originalId <= LAST_SOURCE_MESSAGE_ID; originalId += 1) {
    result.attempted += 1;
    let forwarded = null;
    try {
      forwarded = await telegramWithRetry('forwardMessage', {
        chat_id: CHAT_ID,
        from_chat_id: CHAT_ID,
        message_id: originalId,
        disable_notification: true,
        protect_content: true
      });

      const originalDate = Number(forwarded?.forward_origin?.date || 0);
      const normalized = normalizeBotChannelPost({
        ...forwarded,
        message_id: originalId,
        date: originalDate || forwarded?.date
      });

      normalized.raw_message = {
        ...normalized.raw_message,
        from_history_self_forward: true,
        original_source_message_id: originalId,
        temp_forward_message_id: forwarded?.message_id || null
      };

      await upsertSourceMessage({
        source_id: source.id,
        source_message_id: originalId,
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
        has_internal_links: false,
        updated_at: new Date().toISOString()
      });

      result.indexed += 1;
      result.types[normalized.message_type] = Number(result.types[normalized.message_type] || 0) + 1;
    } catch (error) {
      result.skipped += 1;
      result.errors.push({ sourceMessageId: originalId, error: error?.message || 'forward_failed', code: error?.errorCode || null });
    } finally {
      const tempMessageId = Number(forwarded?.message_id || 0);
      if (tempMessageId > 0) {
        try { await telegram('deleteMessage', { chat_id: CHAT_ID, message_id: tempMessageId }); } catch {}
      }
    }
    await sleep(180);
  }

  await patch(TABLES.sources, `id=eq.${encodeURIComponent(source.id)}`, {
    indexed_at: new Date().toISOString(),
    indexed_message_count: result.indexed
  });
  await logEvent({ source_id: source.id, event_type: 'v4_history_backfill_completed', payload: result });

  return json(res, 200, { ok: result.indexed > 0, result });
}
