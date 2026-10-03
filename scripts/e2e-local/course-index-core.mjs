import { createHash } from 'node:crypto';

const MAX_TELEGRAM_TEXT = 4096;

function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive safe integer`);
  return number;
}

function safeLabel(value) {
  return String(value || '')
    .replace(/(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/)\S+/gi, '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function titleFor(messages, position, maxLength) {
  const content = messages.map((message) => message.text || message.caption || '').find((text) => String(text).trim());
  const firstLine = String(content || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  const plain = safeLabel(firstLine);
  const fallback = messages.length > 1 ? `Album ${position}` : `Bài ${position}`;
  const clean = plain || fallback;
  const letters = Array.from(clean);
  return letters.length > maxLength ? `${letters.slice(0, maxLength - 1).join('')}…` : clean;
}

function destinationLink(destination, messageId) {
  const chat = String(destination.chat_id || '');
  if (!/^-100[1-9]\d+$/.test(chat)) throw new Error('Destination is not a Bot API channel ID');
  const username = String(destination.username || '').replace(/^@/, '');
  if (username && !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error('Unsafe destination username');
  return username
    ? `https://t.me/${username}/${messageId}`
    : `https://t.me/c/${chat.slice(4)}/${messageId}`;
}

export function buildCourseIndex({ source, destination, messages, mappings, appendixStartSourceId = null }) {
  if (!Array.isArray(messages) || !messages.length || !Array.isArray(mappings)) throw new Error('Course rows are required');
  const ordered = [...messages].sort((a, b) => Number(a.source_message_id) - Number(b.source_message_id));
  const bySource = new Map();
  for (const mapping of mappings) {
    const sourceId = positiveId(mapping.source_message_id, 'mapping source ID');
    const destinationId = positiveId(mapping.destination_message_id, 'mapping destination ID');
    if (mapping.status !== 'copied' || bySource.has(sourceId)) throw new Error('Mappings must be unique and copied');
    bySource.set(sourceId, destinationId);
  }
  if (ordered.length !== bySource.size) throw new Error('Every source post must have exactly one copied mapping');

  const groups = [];
  const seenAlbums = new Set();
  let previousSource = 0;
  let previousDestination = 0;
  for (const message of ordered) {
    const sourceId = positiveId(message.source_message_id, 'source post ID');
    const destinationId = bySource.get(sourceId);
    if (sourceId <= previousSource || !destinationId || destinationId <= previousDestination) {
      throw new Error('Source or destination order changed; index publication is blocked');
    }
    previousSource = sourceId;
    previousDestination = destinationId;
    const album = message.media_group_id ? String(message.media_group_id) : null;
    if (album && groups.at(-1)?.album === album) {
      groups.at(-1).messages.push(message);
    } else {
      if (album && seenAlbums.has(album)) throw new Error('An album is not contiguous in source order');
      groups.push({ album, messages: [message], firstSourceId: sourceId, destinationId });
    }
    if (album) seenAlbums.add(album);
  }
  const boundary = appendixStartSourceId == null ? null : positiveId(appendixStartSourceId, 'appendix start ID');
  if (boundary && !groups.some((group) => group.firstSourceId === boundary)) {
    throw new Error('Appendix boundary must start at an existing lesson or the first post of an album');
  }

  function format(maxTitleLength) {
    let text = '📚 MỤC LỤC & PHỤ LỤC KHÓA HỌC\n';
    const courseTitle = safeLabel(source?.title);
    if (courseTitle) text += `${Array.from(courseTitle).slice(0, 80).join('')}\n`;
    text += `${ordered.length} bài đăng · ${groups.length} mục theo thứ tự học\n\n`;
    const entities = [];
    const entries = [];
    for (const [index, group] of groups.entries()) {
      if (group.firstSourceId === boundary) text += '\nPHỤ LỤC\n';
      const position = index + 1;
      const title = titleFor(group.messages, position, maxTitleLength);
      const label = group.messages.length > 1 ? `${title} (${group.messages.length} bài)` : title;
      const prefix = `${String(position).padStart(2, '0')}. `;
      text += prefix;
      const offset = text.length; // Bot API entity offsets are UTF-16 code units.
      text += label;
      const url = destinationLink(destination, group.destinationId);
      entities.push({ type: 'text_link', offset, length: label.length, url });
      text += '\n';
      entries.push({ sourceIds: group.messages.map((message) => Number(message.source_message_id)), destinationId: group.destinationId, title: label, url });
    }
    return { text: text.trimEnd(), entities, entries };
  }

  let index;
  for (const length of [64, 48, 36, 24, 16]) {
    index = format(length);
    if (index.text.length <= MAX_TELEGRAM_TEXT) break;
  }
  if (index.text.length > MAX_TELEGRAM_TEXT) throw new Error('Course index exceeds one Telegram message; split pages before publishing');
  const hash = createHash('sha256').update(JSON.stringify({ text: index.text, entities: index.entities })).digest('hex');
  return { ...index, hash, postCount: ordered.length, groupCount: groups.length,
    albumCount: groups.filter((group) => group.album && group.messages.length > 1).length,
    highWatermark: previousSource };
}
