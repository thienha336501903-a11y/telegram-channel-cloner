import { json, method, readJson } from '../../lib/http.js';
import { authenticateReaderRequest } from '../../lib/reader-manager.js';
import { hasUsableReaderMtprotoMedia } from '../../lib/reader-media.js';
import { linksForNormalizedMessage } from '../../lib/source-message.js';
import { recordInternalLinks, upsertSourceMessage } from '../../lib/repository.js';
import { patch, select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { telegram } from '../../lib/telegram.js';

const HYDRATABLE_MEDIA_TYPES = new Set([
  'photo',
  'video',
  'document',
  'audio',
  'voice',
  'animation',
  'video_note'
]);

async function hydrateHistoricalMedia(source, saved, message) {
  const sourceMessageId = Number(message.source_message_id);
  const messageType = String(message.message_type || 'other');
  if (!HYDRATABLE_MEDIA_TYPES.has(messageType) || !Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) {
    return { attempted: false, hydrated: false };
  }

  let forwarded = null;
  try {
    // Legacy hydration path only. The isolated Distributor E2E harness sets
    // TGCLONER_READER_NO_SOURCE_MUTATION=true and fails before this code can
    // temporarily forward/delete anything in the source channel.
    forwarded = await telegram('forwardMessage', {
      chat_id: source.chat_id,
      from_chat_id: source.chat_id,
      message_id: sourceMessageId,
      disable_notification: true
    });

    const hydratedRaw = {
      ...(forwarded || {}),
      from_reader: true,
      from_history_self_forward: true,
      original_source_message_id: sourceMessageId,
      temp_forward_message_id: Number(forwarded?.message_id || 0) || null
    };
    await patch(TABLES.sourceMessages, `id=eq.${encodeURIComponent(saved.id)}`, {
      raw_message: hydratedRaw,
      updated_at: new Date().toISOString()
    }, { returning: false });
    return { attempted: true, hydrated: true };
  } catch (error) {
    console.warn('[reader-ingest] historical media hydration failed', {
      source_id: source.id,
      source_message_id: sourceMessageId,
      message_type: messageType,
      error: error?.message || String(error)
    });
    return { attempted: true, hydrated: false, error: error?.message || 'hydrate_failed' };
  } finally {
    const tempMessageId = Number(forwarded?.message_id || 0);
    if (tempMessageId > 0) {
      try {
        await telegram('deleteMessage', { chat_id: source.chat_id, message_id: tempMessageId });
      } catch (error) {
        console.warn('[reader-ingest] temporary hydration message cleanup failed', {
          source_id: source.id,
          temp_message_id: tempMessageId,
          error: error?.message || String(error)
        });
      }
    }
  }
}

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (!await authenticateReaderRequest(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  const body = await readJson(req, { maxBytes: 8_000_000 });
  if (!body.source_id || !Array.isArray(body.messages)) return json(res, 400, { ok: false, error: 'source_id_and_messages_required' });
  const sources = await select(TABLES.sources, `select=*&id=eq.${encodeURIComponent(body.source_id)}&limit=1`);
  const source = sources[0];
  if (!source) return json(res, 404, { ok: false, error: 'source_not_found' });

  const noSourceMutation = String(process.env.TGCLONER_READER_NO_SOURCE_MUTATION || '').toLowerCase() === 'true';
  let savedCount = 0;
  let linkCount = 0;
  let hydrationAttempts = 0;
  let hydratedCount = 0;
  let mtprotoPreserved = 0;
  const hydrationErrors = [];
  for (const m of body.messages) {
    const messageType = String(m.message_type || 'other');
    if (
      noSourceMutation
      && m.raw_message?.from_reader
      && HYDRATABLE_MEDIA_TYPES.has(messageType)
      && !hasUsableReaderMtprotoMedia(m)
    ) {
      return json(res, 409, {
        ok: false,
        error: 'reader_media_descriptor_required_no_source_mutation',
        source_message_id: Number(m.source_message_id) || null,
        message_type: messageType
      });
    }

    // Reader messages already use the same normalized text/entity shape as the
    // webhook. Reuse one extractor so hidden MessageEntityTextUrl links are
    // indexed immediately rather than relying on a one-time migration backfill.
    const links = linksForNormalizedMessage(m, source);
    const [saved] = await upsertSourceMessage({
      source_id: source.id,
      source_message_id: Number(m.source_message_id),
      media_group_id: m.media_group_id || null,
      message_type: messageType,
      text: m.text ?? null,
      text_entities: m.text_entities || [],
      caption: m.caption ?? null,
      caption_entities: m.caption_entities || [],
      reply_to_source_message_id: m.reply_to_source_message_id || null,
      is_pinned: Boolean(m.is_pinned),
      raw_message: m.raw_message || {},
      source_date: m.source_date || null,
      has_internal_links: links.length > 0,
      updated_at: new Date().toISOString()
    });
    await recordInternalLinks(source.id, saved.id, links);

    if (hasUsableReaderMtprotoMedia(m)) {
      mtprotoPreserved += 1;
    } else if (m.raw_message?.from_reader) {
      const hydration = await hydrateHistoricalMedia(source, saved, m);
      if (hydration.attempted) hydrationAttempts += 1;
      if (hydration.hydrated) hydratedCount += 1;
      if (hydration.error) hydrationErrors.push({ source_message_id: Number(m.source_message_id), error: hydration.error });
    }

    savedCount += 1;
    linkCount += links.length;
  }
  json(res, 200, {
    ok: true,
    saved: savedCount,
    internal_links: linkCount,
    hydration_attempts: hydrationAttempts,
    hydrated: hydratedCount,
    mtproto_preserved: mtprotoPreserved,
    hydration_errors: hydrationErrors
  });
}
