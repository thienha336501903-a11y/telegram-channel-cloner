// Optional server-side channel allowlist (R1, Owner 25/11). READER_CHANNEL_ALLOWLIST holds comma-separated
// Telegram channel ids (-100…, bare id) and/or @usernames. Unset or blank = no restriction (current behaviour,
// so deploying this code changes nothing until the Owner sets the variable). Set = only those channels can be
// registered, receive live posts, get Reader jobs or ingest data. The value comes from the server env, never
// from a request.
function normalizeRef(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('@')) return raw.toLowerCase();
  const digits = raw.replace(/^-100(?=\d)/, '').replace(/^-/, '');
  return /^\d+$/.test(digits) ? digits : '';
}

export function readerChannelAllowlist(env = process.env) {
  const entries = String(env.READER_CHANNEL_ALLOWLIST || '').split(',').map(normalizeRef).filter(Boolean);
  return entries.length ? new Set(entries) : null;
}

// A source matches by chat id or by @username.
export function isReaderChannelAllowed(source, env = process.env) {
  const allow = readerChannelAllowlist(env);
  if (!allow) return true;
  const refs = typeof source === 'object' && source !== null
    ? [source.chat_id, source.username ? '@' + String(source.username).replace(/^@/, '') : '']
    : [source];
  return refs.map(normalizeRef).some(key => key && allow.has(key));
}

export function assertReaderChannelAllowed(source, env = process.env) {
  if (!isReaderChannelAllowed(source, env)) {
    throw Object.assign(new Error('reader_channel_not_allowlisted'), { status: 403, code: 'reader_channel_not_allowlisted' });
  }
}
