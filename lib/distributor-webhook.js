export function distributorEventFromUpdate(update, source, normalized) {
  const edited = Boolean(update?.edited_channel_post);
  const updateId = Number(update?.update_id);
  const telegramUpdateId = Number.isSafeInteger(updateId) && updateId >= 0 ? updateId : null;
  const sourceMessageId = Number(normalized?.source_message_id);
  if (!source?.id || !Number.isSafeInteger(sourceMessageId) || sourceMessageId < 1) {
    throw new Error('distributor_webhook_event_invalid');
  }
  const eventKind = edited ? 'message_edit' : 'message_new';
  const fallbackVersion = Number(
    update?.edited_channel_post?.edit_date
      ?? update?.channel_post?.date
      ?? normalized?.raw_message?.edit_date
      ?? normalized?.raw_message?.date
      ?? 0
  ) || 0;
  const eventKey = telegramUpdateId !== null
    ? `bot_webhook:update:${telegramUpdateId}`
    : `bot_webhook:${source.id}:${sourceMessageId}:${eventKind}:${fallbackVersion}`;

  return {
    eventKey,
    telegramUpdateId,
    origin: 'bot_webhook',
    eventKind,
    sourceMessageId,
    observedAt: normalized?.source_date || null,
    payload: {
      media_group_id: normalized?.media_group_id || null,
      has_internal_links: Boolean(normalized?.has_internal_links),
      source_chat_id: String(normalized?.source_chat_id || source?.chat_id || '')
    }
  };
}
