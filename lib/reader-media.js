const HYDRATABLE_MEDIA_TYPES = new Set([
  'photo',
  'video',
  'document',
  'audio',
  'voice',
  'animation',
  'video_note'
]);

function validMtprotoDescriptor(value) {
  return Boolean(
    value
    && value.mtproto === true
    && Number.isFinite(Number(value.file_size))
    && Number(value.file_size) > 0
  );
}

export function hasUsableReaderMtprotoMedia(message) {
  const raw = message?.raw_message;
  const messageType = String(message?.message_type || 'other');
  if (!raw?.from_reader || !HYDRATABLE_MEDIA_TYPES.has(messageType)) return false;
  if (messageType === 'photo') {
    return Array.isArray(raw.photo) && raw.photo.some(validMtprotoDescriptor);
  }
  return validMtprotoDescriptor(raw[messageType]);
}
