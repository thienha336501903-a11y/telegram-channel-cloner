import { Api } from 'teleproto';
import { getMtprotoClient } from './mtproto-media.js';

function mediaError(message, code = 'mtproto_media_not_found') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sizeBytes(item) {
  const direct = Number(item?.size || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const progressive = Array.isArray(item?.sizes)
    ? item.sizes.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  return progressive.length ? Math.max(...progressive) : 0;
}

function chooseLargestSize(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      item,
      bytes: sizeBytes(item),
      area: Math.max(0, Number(item?.w || 0)) * Math.max(0, Number(item?.h || 0))
    }))
    .filter(({ item, bytes }) => item?.type && bytes > 0)
    .sort((a, b) => (b.area - a.area) || (b.bytes - a.bytes))[0] || null;
}

function documentName(document) {
  for (const attribute of document?.attributes || []) {
    const fileName = String(attribute?.fileName || attribute?.file_name || '').trim();
    if (fileName) return fileName;
  }
  const mimeType = String(document?.mimeType || document?.mime_type || '').toLowerCase();
  if (mimeType === 'video/mp4') return 'telegram-video.mp4';
  if (mimeType.startsWith('video/')) return 'telegram-video';
  if (mimeType.startsWith('audio/')) return 'telegram-audio';
  return 'telegram-document';
}

async function loadMessage(chatId, messageId) {
  const client = await getMtprotoClient();
  const entity = await client.getInputEntity(String(chatId));
  const messages = await client.getMessages(entity, { ids: Number(messageId) });
  const message = Array.isArray(messages) ? messages[0] || null : null;
  if (!message) throw mediaError('Telegram message not found');
  return { client, entity, message };
}

export async function resolveMtprotoHistoricalMedia({ chatId, messageId }) {
  const base = await loadMessage(chatId, messageId);
  const document = base.message?.media?.document || null;
  if (document) {
    const size = Number(document.size || 0);
    if (!Number.isFinite(size) || size <= 0) {
      throw mediaError('Telegram document has invalid size', 'mtproto_media_invalid');
    }
    const location = new Api.InputDocumentFileLocation({
      id: document.id,
      accessHash: document.accessHash,
      fileReference: document.fileReference,
      thumbSize: ''
    });
    return {
      ...base,
      kind: 'document',
      document,
      location,
      size,
      mimeType: String(document.mimeType || document.mime_type || 'application/octet-stream'),
      name: documentName(document)
    };
  }

  const photo = base.message?.media?.photo || null;
  if (photo) {
    const chosen = chooseLargestSize(photo.sizes);
    if (!chosen) throw mediaError('Telegram photo has no downloadable size', 'mtproto_media_invalid');
    const location = new Api.InputPhotoFileLocation({
      id: photo.id,
      accessHash: photo.accessHash,
      fileReference: photo.fileReference,
      thumbSize: String(chosen.item.type)
    });
    return {
      ...base,
      kind: 'photo',
      photo,
      photoSize: chosen.item,
      location,
      size: chosen.bytes,
      mimeType: 'image/jpeg',
      name: 'telegram-photo.jpg',
      width: Number(chosen.item.w || 0),
      height: Number(chosen.item.h || 0)
    };
  }

  throw mediaError('Telegram message has no supported media');
}

export async function resolveMtprotoHistoricalThumbnail({ chatId, messageId }) {
  const base = await loadMessage(chatId, messageId);
  const document = base.message?.media?.document || null;
  if (!document) throw mediaError('Telegram document thumbnail not found', 'mtproto_thumbnail_not_found');
  const chosen = chooseLargestSize(document.thumbs);
  if (!chosen) throw mediaError('Telegram document thumbnail not found', 'mtproto_thumbnail_not_found');
  const location = new Api.InputDocumentFileLocation({
    id: document.id,
    accessHash: document.accessHash,
    fileReference: document.fileReference,
    thumbSize: String(chosen.item.type)
  });
  return {
    ...base,
    kind: 'thumbnail',
    document,
    thumbnail: chosen.item,
    location,
    size: chosen.bytes,
    mimeType: 'image/jpeg',
    name: 'telegram-thumbnail.jpg',
    width: Number(chosen.item.w || 0),
    height: Number(chosen.item.h || 0)
  };
}
