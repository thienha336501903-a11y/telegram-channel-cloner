import { requireEnv } from './env.js';

export class DistributorTelegramKnownFailure extends Error {
  constructor(method, payload = {}, status = null) {
    super(payload?.description || `Telegram ${method} failed`);
    this.name = 'DistributorTelegramKnownFailure';
    this.method = method;
    this.status = status;
    this.errorCode = Number(payload?.error_code || status || 0) || null;
    this.parameters = payload?.parameters || {};
    this.retryAfter = Number.isFinite(Number(this.parameters?.retry_after)) ? Number(this.parameters.retry_after) : null;
  }
}

export class DistributorTelegramAmbiguousFailure extends Error {
  constructor(method, reason, { status = null, cause = null, partialResult = null } = {}) {
    super(`Telegram ${method} result ambiguous: ${reason}`);
    this.name = 'DistributorTelegramAmbiguousFailure';
    this.method = method;
    this.reason = reason;
    this.status = status;
    this.partialResult = partialResult;
    if (cause) this.cause = cause;
  }
}

function copyParams({ sourceChatId, destinationChatId }) {
  return { chat_id: destinationChatId, from_chat_id: sourceChatId, disable_notification: true };
}

async function telegramCall(method, params, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('telegram_timeout')), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    });
  } catch (error) {
    throw new DistributorTelegramAmbiguousFailure(method, 'transport_error', { cause: error });
  } finally {
    clearTimeout(timer);
  }

  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    throw new DistributorTelegramAmbiguousFailure(method, 'response_body_unreadable', { status: response.status, cause: error });
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (error) {
    throw new DistributorTelegramAmbiguousFailure(method, 'response_not_json', { status: response.status, cause: error });
  }

  if (!response.ok || payload?.ok !== true) {
    const code = Number(payload?.error_code || response.status || 0);
    if (response.status >= 500 || code >= 500 || !payload?.description) {
      throw new DistributorTelegramAmbiguousFailure(method, 'server_or_unstructured_failure', {
        status: response.status,
        partialResult: payload?.result ?? null
      });
    }
    throw new DistributorTelegramKnownFailure(method, payload, response.status);
  }

  if (payload.result === undefined || payload.result === null) {
    throw new DistributorTelegramAmbiguousFailure(method, 'success_without_result', { status: response.status });
  }
  return payload.result;
}

export async function copyOneSafely({ sourceChatId, sourceMessageId, destinationChatId }, options = {}) {
  const result = await telegramCall('copyMessage', {
    ...copyParams({ sourceChatId, destinationChatId }),
    message_id: sourceMessageId
  }, options);
  const messageId = Number(result?.message_id);
  if (!Number.isSafeInteger(messageId) || messageId < 1) {
    throw new DistributorTelegramAmbiguousFailure('copyMessage', 'invalid_success_message_id', { partialResult: result });
  }
  return { destinationMessageIds: [messageId], raw: result };
}

export async function copyManySafely({ sourceChatId, sourceMessageIds, destinationChatId }, options = {}) {
  const expected = Array.isArray(sourceMessageIds) ? sourceMessageIds.map(Number) : [];
  if (!expected.length || expected.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('distributor_copy_source_ids_invalid');

  const result = await telegramCall('copyMessages', {
    ...copyParams({ sourceChatId, destinationChatId }),
    message_ids: expected
  }, options);
  const rows = Array.isArray(result) ? result : [];
  const destinationMessageIds = rows.map((row) => Number(row?.message_id));
  if (rows.length !== expected.length || destinationMessageIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new DistributorTelegramAmbiguousFailure('copyMessages', 'partial_or_malformed_album_result', {
      partialResult: { expectedCount: expected.length, destinationMessageIds }
    });
  }
  return { destinationMessageIds, raw: result };
}

export async function editTextSafely({ chatId, messageId, text, entities = [], disableLinkPreview = false }, options = {}) {
  const params = { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: disableLinkPreview } };
  if (entities?.length) params.entities = entities;
  return telegramCall('editMessageText', params, options);
}

export async function sendTextSafely({ chatId, text, entities = [] }, options = {}) {
  const params = {
    chat_id: chatId, text, disable_notification: true,
    link_preview_options: { is_disabled: true }
  };
  if (entities.length) params.entities = entities;
  const result = await telegramCall('sendMessage', params, options);
  const messageId = Number(result?.message_id);
  if (!Number.isSafeInteger(messageId) || messageId < 1 || String(result?.chat?.id) !== String(chatId)) {
    throw new DistributorTelegramAmbiguousFailure('sendMessage', 'invalid_success_message', { partialResult: result });
  }
  return result;
}

export async function editCaptionSafely({ chatId, messageId, caption, captionEntities = [] }, options = {}) {
  const params = { chat_id: chatId, message_id: messageId, caption };
  if (captionEntities?.length) params.caption_entities = captionEntities;
  return telegramCall('editMessageCaption', params, options);
}

export async function pinMessageSafely({ chatId, messageId }, options = {}) {
  const result = await telegramCall('pinChatMessage', {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true
  }, options);
  if (result !== true) throw new DistributorTelegramAmbiguousFailure('pinChatMessage', 'unexpected_success_result', { partialResult: result });
  return true;
}

export async function unpinAllMessagesSafely({ chatId }, options = {}) {
  const result = await telegramCall('unpinAllChatMessages', { chat_id: chatId }, options);
  if (result !== true) throw new DistributorTelegramAmbiguousFailure('unpinAllChatMessages', 'unexpected_success_result', { partialResult: result });
  return true;
}

export async function getChatSafely({ chatId }, options = {}) {
  const result = await telegramCall('getChat', { chat_id: chatId }, options);
  if (!result || typeof result !== 'object') throw new DistributorTelegramAmbiguousFailure('getChat', 'invalid_chat_result', { partialResult: result });
  return result;
}

export function isKnownTelegramFailure(error) {
  return error instanceof DistributorTelegramKnownFailure;
}

export function isAmbiguousTelegramFailure(error) {
  return error instanceof DistributorTelegramAmbiguousFailure;
}
