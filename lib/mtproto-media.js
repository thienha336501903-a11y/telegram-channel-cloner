import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import bigInt from 'big-integer';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { patch, select } from './supabase.js';
import { TABLES } from './tables.js';

export const MTPROTO_CHUNK_SIZE = 512 * 1024;

let clientPromise = null;

function clean(value) {
  return String(value || '').trim().replace(/^[\'\"]|[\'\"]$/g, '');
}

function mtprotoConfig() {
  const apiId = Number.parseInt(clean(process.env.TELEGRAM_API_ID), 10);
  const apiHash = clean(process.env.TELEGRAM_API_HASH);
  const botToken = clean(process.env.TELEGRAM_BOT_TOKEN);
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash || !botToken) {
    const error = new Error('MTProto environment is incomplete');
    error.code = 'mtproto_not_configured';
    throw error;
  }
  return { apiId, apiHash, botToken };
}

function sessionEncryptionKey() {
  const secret = clean(process.env.SESSION_SECRET);
  if (!secret) throw new Error('SESSION_SECRET is required for MTProto session encryption');
  return createHash('sha256').update(`tgcloner-mtproto-session:${secret}`).digest();
}

function encryptSession(session) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(session), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptSession(payload) {
  const raw = String(payload || '').trim();
  if (!raw) return '';
  const [version, ivPart, tagPart, cipherPart] = raw.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !cipherPart) throw new Error('Invalid MTProto session cache format');
  const decipher = createDecipheriv('aes-256-gcm', sessionEncryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherPart, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

async function loadStoredSession() {
  try {
    const rows = await select(TABLES.settings, 'select=mtproto_session_ciphertext&singleton=eq.true&limit=1');
    const encrypted = Array.isArray(rows) ? rows[0]?.mtproto_session_ciphertext : '';
    if (!encrypted) return '';
    const session = decryptSession(encrypted);
    if (session) console.info('[mtproto-session] restored encrypted session cache');
    return session;
  } catch (error) {
    console.warn('[mtproto-session] cache read/decrypt failed; falling back to fresh auth', error?.message || error);
    return '';
  }
}

async function saveStoredSession(session) {
  const value = String(session || '').trim();
  if (!value) return;
  try {
    await patch(TABLES.settings, 'singleton=eq.true', {
      mtproto_session_ciphertext: encryptSession(value),
      updated_at: new Date().toISOString()
    });
    console.info('[mtproto-session] encrypted session cache saved');
  } catch (error) {
    console.warn('[mtproto-session] cache save failed', error?.message || error);
  }
}

async function clearStoredSession() {
  try {
    await patch(TABLES.settings, 'singleton=eq.true', {
      mtproto_session_ciphertext: null,
      updated_at: new Date().toISOString()
    });
  } catch {}
}

async function startClient(sessionValue, config) {
  const client = new TelegramClient(new StringSession(sessionValue || ''), config.apiId, config.apiHash, {
    connectionRetries: 5,
    requestRetries: 5,
    autoReconnect: true,
    sequentialUpdates: true
  });
  try {
    await client.start({ botAuthToken: config.botToken });
    return client;
  } catch (error) {
    try { await client.disconnect(); } catch {}
    throw error;
  }
}

async function createClient() {
  const config = mtprotoConfig();
  const startedAt = Date.now();
  const cachedSession = await loadStoredSession();
  let client;
  let source = cachedSession ? 'cache' : 'fresh';

  if (cachedSession) {
    try {
      client = await startClient(cachedSession, config);
    } catch (error) {
      console.warn('[mtproto-session] cached session rejected; refreshing bot authorization', error?.message || error);
      await clearStoredSession();
      source = 'fresh-recovery';
      client = await startClient('', config);
    }
  } else {
    client = await startClient('', config);
  }

  const serialized = String(client.session?.save?.() || '').trim();
  if (serialized && serialized !== cachedSession) await saveStoredSession(serialized);
  console.info(`[mtproto-session] client ready source=${source} elapsed_ms=${Date.now() - startedAt}`);
  return client;
}

export async function getMtprotoClient() {
  if (!clientPromise) {
    clientPromise = createClient().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

export async function closeMtprotoClient() {
  const active = clientPromise;
  clientPromise = null;
  if (!active) return;
  try {
    const client = await active;
    await client.disconnect();
  } catch {}
}

export function resetMtprotoClient() {
  void closeMtprotoClient();
}

export async function resolveMtprotoDocument({ chatId, messageId }) {
  const client = await getMtprotoClient();
  const entity = await client.getInputEntity(String(chatId));
  const messages = await client.getMessages(entity, { ids: Number(messageId) });
  const message = Array.isArray(messages) ? messages[0] || null : null;
  const document = message?.media?.document || null;
  if (!message || !document) {
    const error = new Error('Telegram document not found');
    error.code = 'mtproto_media_not_found';
    throw error;
  }

  const size = Number(document.size || 0);
  if (!Number.isFinite(size) || size <= 0) {
    const error = new Error('Telegram document has invalid size');
    error.code = 'mtproto_media_invalid';
    throw error;
  }

  const location = new Api.InputDocumentFileLocation({
    id: document.id,
    accessHash: document.accessHash,
    fileReference: document.fileReference,
    thumbSize: ''
  });

  return { client, entity, message, document, location, size };
}

export async function streamResolvedMtprotoRange({ resolved, start, end, signal, onChunk }) {
  const { client, location, size } = resolved;
  const first = Math.max(0, Number(start || 0));
  const last = Math.min(size - 1, Number(end ?? (size - 1)));
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last || first >= size) {
    const error = new Error('Invalid MTProto byte range');
    error.code = 'invalid_range';
    throw error;
  }

  let cursor = first;
  let written = 0;
  while (cursor <= last) {
    if (signal?.aborted) {
      const error = new Error('Media request aborted');
      error.code = 'request_aborted';
      throw error;
    }

    const alignedOffset = Math.floor(cursor / MTPROTO_CHUNK_SIZE) * MTPROTO_CHUNK_SIZE;
    const buffer = await client._media.getFile(
      client.session.dcId,
      location,
      bigInt(alignedOffset),
      MTPROTO_CHUNK_SIZE,
      signal
    );
    if (!buffer?.length) break;

    const sliceStart = cursor - alignedOffset;
    const sliceEnd = Math.min(buffer.length, (last - alignedOffset) + 1);
    if (sliceEnd <= sliceStart) break;

    const chunk = buffer.subarray(sliceStart, sliceEnd);
    await onChunk(chunk);
    cursor += chunk.length;
    written += chunk.length;
  }

  if (written !== (last - first + 1)) {
    const error = new Error(`MTProto range incomplete: ${written}/${last - first + 1}`);
    error.code = 'mtproto_range_incomplete';
    throw error;
  }

  return { ...resolved, start: first, end: last, written };
}

export async function streamMtprotoRange({ chatId, messageId, start, end, signal, onChunk }) {
  const resolved = await resolveMtprotoDocument({ chatId, messageId });
  return streamResolvedMtprotoRange({ resolved, start, end, signal, onChunk });
}
