import { botApiChatIdToPrivateLinkId, extractInternalLinks } from './links.js';

export function normalizeBotChannelPost(message) {
  const chat = message.chat || {};
  return {
    source_chat_id: String(chat.id),
    source_message_id: Number(message.message_id),
    media_group_id: message.media_group_id || null,
    message_type: detectMessageType(message),
    text: message.text ?? null,
    text_entities: message.entities ?? [],
    caption: message.caption ?? null,
    caption_entities: message.caption_entities ?? [],
    reply_to_source_message_id: message.reply_to_message?.message_id ?? null,
    is_pinned: Boolean(message.pinned_message),
    raw_message: message,
    source_username: chat.username || null,
    source_title: chat.title || null,
    source_private_link_id: botApiChatIdToPrivateLinkId(chat.id),
    source_date: message.date ? new Date(message.date * 1000).toISOString() : null
  };
}

export function detectMessageType(m) {
  if (m.text) return 'text';
  if (m.photo) return 'photo';
  if (m.video) return 'video';
  if (m.document) return 'document';
  if (m.audio) return 'audio';
  if (m.voice) return 'voice';
  if (m.animation) return 'animation';
  if (m.video_note) return 'video_note';
  if (m.sticker) return 'sticker';
  return 'other';
}

export function linksForNormalizedMessage(message, source) {
  return [
    ...extractInternalLinks(message.text, source).map((x) => ({ ...x, location: 'text' })),
    ...extractInternalLinks(message.caption, source).map((x) => ({ ...x, location: 'caption' }))
  ];
}
