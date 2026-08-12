import { requireEnv } from './env.js';

export class TelegramError extends Error {
  constructor(method, payload) {
    super(payload?.description || `Telegram ${method} failed`);
    this.name = 'TelegramError';
    this.method = method;
    this.errorCode = payload?.error_code;
    this.parameters = payload?.parameters || {};
  }
}

export async function telegram(method, params = {}) {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new TelegramError(method, payload);
  return payload.result;
}

export function retryAfterSeconds(error) {
  const value = error?.parameters?.retry_after;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export async function copyOne({ sourceChatId, sourceMessageId, destinationChatId, caption, captionEntities }) {
  const params = {
    chat_id: destinationChatId,
    from_chat_id: sourceChatId,
    message_id: sourceMessageId,
    disable_notification: true
  };
  if (caption !== undefined) params.caption = caption;
  if (captionEntities !== undefined) params.caption_entities = captionEntities;
  return telegram('copyMessage', params);
}

export async function copyMany({ sourceChatId, sourceMessageIds, destinationChatId }) {
  return telegram('copyMessages', {
    chat_id: destinationChatId,
    from_chat_id: sourceChatId,
    message_ids: sourceMessageIds,
    disable_notification: true
  });
}

export async function editText({ chatId, messageId, text, entities }) {
  const params = { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: false } };
  if (entities?.length) params.entities = entities;
  return telegram('editMessageText', params);
}

export async function editCaption({ chatId, messageId, caption, captionEntities }) {
  const params = { chat_id: chatId, message_id: messageId, caption };
  if (captionEntities?.length) params.caption_entities = captionEntities;
  return telegram('editMessageCaption', params);
}

export async function pin({ chatId, messageId }) {
  return telegram('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
}

export async function getChat(chatId) {
  return telegram('getChat', { chat_id: chatId });
}

export async function getMe() {
  return telegram('getMe');
}
