// Telegram private-channel links: https://t.me/c/<internal-channel-id>/<message-id>
// Public channel links: https://t.me/<username>/<message-id>

const PRIVATE_RE = /https?:\/\/(?:t\.me|telegram\.me)\/c\/(\d+)\/(\d+)(?:\?[^\s<]*)?/gi;
const PUBLIC_RE = /https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{5,})\/(\d+)(?:\?[^\s<]*)?/gi;

export function botApiChatIdToPrivateLinkId(chatId) {
  const s = String(chatId);
  if (s.startsWith('-100')) return s.slice(4);
  return null;
}

export function destinationMessageLink({ destinationChatId, destinationUsername, messageId }) {
  if (destinationUsername) return `https://t.me/${destinationUsername.replace(/^@/, '')}/${messageId}`;
  const internal = botApiChatIdToPrivateLinkId(destinationChatId);
  if (!internal) throw new Error(`Cannot build private Telegram link for chat id ${destinationChatId}`);
  return `https://t.me/c/${internal}/${messageId}`;
}

export function extractInternalLinks(text, source) {
  if (!text) return [];
  const found = [];
  const sourcePrivateId = source?.private_link_id ? String(source.private_link_id) : null;
  const sourceUsername = source?.username ? String(source.username).replace(/^@/, '').toLowerCase() : null;

  for (const match of text.matchAll(PRIVATE_RE)) {
    if (sourcePrivateId && match[1] === sourcePrivateId) {
      found.push({ full: match[0], source_message_id: Number(match[2]), kind: 'private' });
    }
  }
  for (const match of text.matchAll(PUBLIC_RE)) {
    if (match[1].toLowerCase() === 'c') continue;
    if (sourceUsername && match[1].toLowerCase() === sourceUsername) {
      found.push({ full: match[0], source_message_id: Number(match[2]), kind: 'public' });
    }
  }
  return found;
}

export function rewriteInternalLinks(text, { source, destination, mappings }) {
  if (!text) return { text, rewritten: 0, unresolved: [] };
  const map = mappings instanceof Map ? mappings : new Map(Object.entries(mappings || {}).map(([k, v]) => [Number(k), Number(v)]));
  const links = extractInternalLinks(text, source);
  let output = text;
  let rewritten = 0;
  const unresolved = [];

  // Replace longer strings first so repeated links remain deterministic.
  for (const link of [...links].sort((a, b) => b.full.length - a.full.length)) {
    const target = map.get(Number(link.source_message_id));
    if (!target) {
      unresolved.push(link.source_message_id);
      continue;
    }
    const replacement = destinationMessageLink({
      destinationChatId: destination.chat_id,
      destinationUsername: destination.username,
      messageId: target
    });
    output = output.split(link.full).join(replacement);
    rewritten += 1;
  }
  return { text: output, rewritten, unresolved: [...new Set(unresolved)] };
}

export function utf16Length(text) {
  // Telegram MessageEntity offsets/lengths use UTF-16 code units. JS string length is UTF-16 units.
  return String(text ?? '').length;
}

export function rewriteTextAndEntities(text, entities, context) {
  // Rewriting literal URLs changes offsets. We conservatively rebuild only URL entities that
  // point inside the source channel and shift all later entity offsets by the accumulated delta.
  if (!text) return { text, entities: entities || [], rewritten: 0, unresolved: [] };
  const originalEntities = Array.isArray(entities) ? structuredClone(entities) : [];
  const links = extractInternalLinks(text, context.source).sort((a, b) => text.indexOf(a.full) - text.indexOf(b.full));
  if (!links.length) return { text, entities: originalEntities, rewritten: 0, unresolved: [] };

  const map = context.mappings instanceof Map ? context.mappings : new Map(Object.entries(context.mappings || {}).map(([k, v]) => [Number(k), Number(v)]));
  let output = '';
  let cursor = 0;
  let delta = 0;
  let rewritten = 0;
  const unresolved = [];
  const shifts = [];

  for (const link of links) {
    const start = text.indexOf(link.full, cursor);
    if (start < 0) continue;
    const target = map.get(Number(link.source_message_id));
    let replacement = link.full;
    if (target) {
      replacement = destinationMessageLink({ destinationChatId: context.destination.chat_id, destinationUsername: context.destination.username, messageId: target });
      rewritten += 1;
    } else {
      unresolved.push(link.source_message_id);
    }
    output += text.slice(cursor, start) + replacement;
    const change = utf16Length(replacement) - utf16Length(link.full);
    shifts.push({ start, end: start + utf16Length(link.full), deltaBefore: delta, change, replacement });
    delta += change;
    cursor = start + link.full.length;
  }
  output += text.slice(cursor);

  const adjusted = originalEntities.map((entity) => {
    const e = { ...entity };
    let shift = 0;
    for (const s of shifts) {
      if (s.start < e.offset) shift += s.change;
      else if (s.start === e.offset && e.length === (s.end - s.start)) e.length += s.change;
    }
    e.offset += shift;
    return e;
  });

  return { text: output, entities: adjusted, rewritten, unresolved: [...new Set(unresolved)] };
}
