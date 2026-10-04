// Guarded TEST-only publisher for one destination-owned index per retained 1→2 destination.
// It never touches Production and only accepts the exact learner-free TEST fixture.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTwoDestinationPreviews } from './preview-two-course-index.mjs';
import { verifyTwoTestBotAccess } from './verify-two-test-bot-access.mjs';
import {
  editTextSafely, getChatSafely, isKnownTelegramFailure, pinMessageSafely, sendTextSafely
} from '../../lib/distributor-telegram.js';

const SOURCE = '-1004320185488';
const DESTINATIONS = ['-1003933578709', '-1004492904064'];
const DB_CONTAINER = 'tgcloner-e2e-1to2-db';
const STATE_VERSION = 1;
const LEGACY_INDEX = Object.freeze({
  '-1003933578709': {
    messageId: 69,
    hash: '8fb4d444dadb850945e8b0bfbd7fe0ff64419a98b9a436ad752ed845e077549f'
  },
  '-1004492904064': {
    messageId: 191,
    hash: '6ee7ce50beaa3ebd48af0611f143bd95c20a72d0c7545b5a1621cca1b6bef4b9'
  }
});

const sql = `
with s as (select id,chat_id,title,active from public.tgcloner_sources where chat_id='${SOURCE}'),
d as (select id,source_id,chat_id,username,active,course_index_message_id,
      course_index_content_hash,course_index_high_watermark from public.tgcloner_destinations
      where chat_id in ('${DESTINATIONS.join("','")}'))
select json_build_object(
  'source',(select row_to_json(s) from s),
  'messages',(select json_agg(json_build_object('source_message_id',m.source_message_id,
    'media_group_id',m.media_group_id,'message_type',m.message_type,
    'text',m.text,'caption',m.caption) order by m.source_message_id)
    from public.tgcloner_source_messages m join s on s.id=m.source_id),
  'destinations',(select json_agg(json_build_object(
    'destination',row_to_json(d),
    'runs',(select json_agg(json_build_object('id',r.id,'source_id',r.source_id,
      'destination_id',r.destination_id,'status',r.status,'phase',r.phase,
      'high_watermark',r.snapshot_high_watermark,
      'manifest_closed_at',r.manifest_closed_at,'verified_at',r.last_verified_at,
      'manifest_ids',(select json_agg(mf.source_message_id order by mf.source_message_id)
        from public.tgcloner_clone_manifest mf where mf.run_id=r.id),
      'unsafe_work',(select count(*) from public.tgcloner_clone_work w where w.run_id=r.id
        and (w.status not in ('done','skipped','cancelled') or w.side_effect_state='ambiguous'))
    )) from public.tgcloner_clone_runs r where r.destination_id=d.id),
    'mappings',(select json_agg(json_build_object('source_message_id',m.source_message_id,
      'destination_message_id',m.destination_message_id,'status',m.status)
      order by m.source_message_id)
      from public.tgcloner_message_mappings m where m.destination_id=d.id)
  ) order by d.chat_id) from d)
)::text`;

function psql(statement) {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  }).trim();
}

function readSnapshot() {
  return JSON.parse(psql(sql));
}

export function buildPublishRows(data) {
  const previews = buildTwoDestinationPreviews(data, { afterOne: true });
  return previews.map((preview) => {
    const raw = data.destinations.find((row) => row.destination.chat_id === preview.destination);
    if (!raw) throw new Error(`Missing TEST destination snapshot: ${preview.destination}`);
    return { ...preview, destinationRow: raw.destination };
  });
}

function expectedLinkEntities(index) {
  return index.entities.map((entity) => `${entity.offset}:${entity.length}:${entity.url}`).sort();
}

export function pinnedIndexHash(chat, messageId) {
  const pinned = chat?.pinned_message;
  if (Number(pinned?.message_id || 0) !== Number(messageId) || typeof pinned?.text !== 'string') return null;
  const entities = (pinned.entities || [])
    .filter((entity) => entity.type === 'text_link')
    .map((entity) => ({ type: 'text_link', offset: Number(entity.offset), length: Number(entity.length), url: String(entity.url || '') }));
  return createHash('sha256').update(JSON.stringify({ text: pinned.text, entities })).digest('hex');
}

export function pinMatches(chat, index, messageId) {
  const pinned = chat?.pinned_message;
  if (Number(pinned?.message_id || 0) !== Number(messageId) || pinned?.text !== index.text) return false;
  const actual = (pinned.entities || []).filter((entity) => entity.type === 'text_link')
    .map((entity) => `${entity.offset}:${entity.length}:${entity.url}`).sort();
  return JSON.stringify(actual) === JSON.stringify(expectedLinkEntities(index));
}

export function validateState(state, row, { allowContentUpdate = false } = {}) {
  if (!state) return null;
  if (state.version !== STATE_VERSION || state.sourceChatId !== SOURCE ||
      state.destinationChatId !== row.destination || state.runId !== row.runId ||
      !['armed', 'known_failure', 'sent', 'published', 'editing'].includes(state.phase)) {
    throw new Error(`Unknown index ledger for ${row.destination}; reconcile before any write`);
  }
  if (state.messageId != null && (!Number.isSafeInteger(Number(state.messageId)) || Number(state.messageId) < 1)) {
    throw new Error(`Invalid index message ID in ledger for ${row.destination}`);
  }
  if (state.phase === 'armed') {
    throw new Error(`Previous index send outcome is ambiguous for ${row.destination}; inspect the TEST channel before retrying`);
  }
  if (state.phase !== 'known_failure' && !state.messageId) {
    throw new Error(`Index ledger is incomplete for ${row.destination}; reconcile before retrying`);
  }
  if (state.contentHash && state.contentHash !== row.index.hash && !allowContentUpdate) {
    throw new Error(`Index content changed for ${row.destination}; use the reviewed TEST update-existing path`);
  }
  if (allowContentUpdate && state.contentHash !== row.index.hash &&
      !['published', 'editing'].includes(state.phase)) {
    throw new Error(`Index update state is unsafe for ${row.destination}`);
  }
  return state;
}

async function saveState(path, data) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}

async function loadState(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function registerIndex(row, messageId) {
  const destinationId = String(row.destinationRow.id || '');
  const runId = String(row.runId || '');
  if (!/^[0-9a-f-]{36}$/i.test(destinationId) || !/^[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error('Local TEST index registration identity is invalid');
  }
  const registered = psql(`select d.course_index_message_id::text || ':' || d.course_index_content_hash || ':' || d.course_index_high_watermark::text
    from public.tgcloner_distributor_register_course_index('${runId}'::uuid, ${Number(messageId)}, '${row.index.hash}', ${row.index.highWatermark}) d
    where d.id='${destinationId}'::uuid`);
  const expected = `${Number(messageId)}:${row.index.hash}:${row.index.highWatermark}`;
  if (registered !== expected) throw new Error(`Index registration failed for ${row.destination}`);
}

function verifyRegisteredSnapshot(row, messageId, {
  expectedHash = row.index.hash,
  expectedHighWatermark = row.index.highWatermark
} = {}) {
  const destination = row.destinationRow;
  const fields = [destination.course_index_message_id, destination.course_index_content_hash,
    destination.course_index_high_watermark];
  if (fields.every((value) => value == null)) return false;
  if (Number(destination.course_index_message_id) !== Number(messageId) ||
      destination.course_index_content_hash !== expectedHash ||
      Number(destination.course_index_high_watermark) !== Number(expectedHighWatermark)) {
    throw new Error(`Registered TEST index differs from expected evidence for ${row.destination}`);
  }
  return true;
}

async function updateExistingOne(row, stateDir) {
  const expected = LEGACY_INDEX[row.destination];
  if (!expected) throw new Error(`No reviewed legacy TEST index identity for ${row.destination}`);

  const statePath = join(stateDir, `course-index-${row.destination}.json`);
  let state = validateState(await loadState(statePath), row, { allowContentUpdate: true });
  if (!state?.messageId || Number(state.messageId) !== expected.messageId) {
    throw new Error(`TEST index message identity changed for ${row.destination}`);
  }
  if (Number(state.highWatermark) !== 62 || row.index.highWatermark !== 62) {
    throw new Error(`TEST index watermark changed for ${row.destination}`);
  }

  const previousHash = state.phase === 'editing'
    ? String(state.previousContentHash || '')
    : String(state.contentHash || '');
  const targetHash = state.phase === 'editing'
    ? String(state.targetContentHash || '')
    : row.index.hash;

  if (previousHash !== expected.hash || targetHash !== row.index.hash || previousHash === targetHash) {
    throw new Error(`Unexpected TEST index hash transition for ${row.destination}`);
  }

  verifyRegisteredSnapshot(row, state.messageId, {
    expectedHash: previousHash,
    expectedHighWatermark: 62
  });

  const chat = await getChatSafely({ chatId: row.destination });
  if (chat?.type !== 'channel' || String(chat.id) !== row.destination ||
      Number(chat?.pinned_message?.message_id || 0) !== Number(state.messageId)) {
    throw new Error(`Pinned TEST index identity changed for ${row.destination}`);
  }

  const currentHash = pinnedIndexHash(chat, state.messageId);
  if (currentHash === targetHash) {
    registerIndex(row, state.messageId);
    state = { ...state, phase: 'published', contentHash: targetHash, highWatermark: 62 };
    delete state.previousContentHash;
    delete state.targetContentHash;
    await saveState(statePath, state);
    console.log(`E2E_1TO2_INDEX_DESTINATION_PASS destination=${row.destination} message_id=${state.messageId} existing=true updated=true recovered=true`);
    return;
  }
  if (currentHash !== previousHash) {
    throw new Error(`Pinned TEST index content is neither reviewed old nor target content for ${row.destination}`);
  }

  if (state.phase !== 'editing') {
    state = {
      ...state,
      phase: 'editing',
      previousContentHash: previousHash,
      targetContentHash: targetHash
    };
    await saveState(statePath, state);
  }

  await editTextSafely({
    chatId: row.destination,
    messageId: Number(state.messageId),
    text: row.index.text,
    entities: row.index.entities,
    disableLinkPreview: true
  });

  const afterEdit = await getChatSafely({ chatId: row.destination });
  if (!pinMatches(afterEdit, row.index, state.messageId)) {
    throw new Error(`Edited TEST index verification failed for ${row.destination}; do not retry blindly`);
  }

  registerIndex(row, state.messageId);
  state = { ...state, phase: 'published', contentHash: targetHash, highWatermark: 62 };
  delete state.previousContentHash;
  delete state.targetContentHash;
  await saveState(statePath, state);
  console.log(`E2E_1TO2_INDEX_DESTINATION_PASS destination=${row.destination} message_id=${state.messageId} existing=true updated=true`);
}

async function publishOne(row, stateDir) {
  const statePath = join(stateDir, `course-index-${row.destination}.json`);
  let state = validateState(await loadState(statePath), row);
  const chat = await getChatSafely({ chatId: row.destination });
  if (chat?.type !== 'channel' || String(chat.id) !== row.destination) {
    throw new Error(`TEST destination identity changed: ${row.destination}`);
  }

  if (state?.retryNotBefore && Date.now() < Date.parse(state.retryNotBefore)) {
    throw new Error(`Telegram retry_after is active for ${row.destination} until ${state.retryNotBefore}`);
  }

  if (state?.messageId) {
    verifyRegisteredSnapshot(row, state.messageId);
    if (chat.pinned_message && Number(chat.pinned_message.message_id) !== Number(state.messageId)) {
      throw new Error(`A different message is pinned in ${row.destination}; no Telegram write attempted`);
    }
    if (!chat.pinned_message) {
      await pinMessageSafely({ chatId: row.destination, messageId: Number(state.messageId) });
    }
    const afterPin = await getChatSafely({ chatId: row.destination });
    if (!pinMatches(afterPin, row.index, state.messageId)) {
      throw new Error(`Pinned index verification failed for ${row.destination}`);
    }
    registerIndex(row, state.messageId);
    state = { ...state, phase: 'published', contentHash: row.index.hash, highWatermark: row.index.highWatermark };
    delete state.retryNotBefore;
    await saveState(statePath, state);
    console.log(`E2E_1TO2_INDEX_DESTINATION_PASS destination=${row.destination} message_id=${state.messageId} existing=true`);
    return;
  }

  if (verifyRegisteredSnapshot(row, 0)) {
    throw new Error(`DB has an index registration without a local message ledger for ${row.destination}`);
  }
  if (chat.pinned_message) {
    throw new Error(`Destination ${row.destination} already has an unregistered pinned message; inspect before publishing`);
  }

  const base = {
    version: STATE_VERSION, sourceChatId: SOURCE, destinationChatId: row.destination,
    runId: row.runId, contentHash: row.index.hash, highWatermark: row.index.highWatermark
  };
  await saveState(statePath, { ...base, phase: 'armed' });
  let sent;
  try {
    sent = await sendTextSafely({ chatId: row.destination, text: row.index.text, entities: row.index.entities });
  } catch (error) {
    if (isKnownTelegramFailure(error)) {
      const retryNotBefore = error.retryAfter
        ? new Date(Date.now() + error.retryAfter * 1000).toISOString() : null;
      await saveState(statePath, { ...base, phase: 'known_failure', retryNotBefore });
    }
    throw error;
  }
  const messageId = Number(sent.message_id);
  state = { ...base, phase: 'sent', messageId };
  await saveState(statePath, state);

  await pinMessageSafely({ chatId: row.destination, messageId });
  const afterPin = await getChatSafely({ chatId: row.destination });
  if (!pinMatches(afterPin, row.index, messageId)) {
    throw new Error(`New TEST index pin could not be independently verified for ${row.destination}`);
  }
  registerIndex(row, messageId);
  state.phase = 'published';
  await saveState(statePath, state);
  console.log(`E2E_1TO2_INDEX_DESTINATION_PASS destination=${row.destination} message_id=${messageId} existing=false`);
}

async function main() {
  const afterOne = process.argv.includes('--after-one');
  const publish = process.argv.includes('--publish');
  const updateExisting = process.argv.includes('--update-existing');
  if (updateExisting && !publish) throw new Error('--update-existing requires --publish');
  if (!afterOne) throw new Error('The retained 1to2 index path requires --after-one after the verified source #62 gate');
  const rows = buildPublishRows(readSnapshot());
  for (const row of rows) {
    console.log(`E2E_1TO2_INDEX_READY destination=${row.destination} run=${row.runId} posts=${row.index.postCount} entries=${row.index.groupCount} H=${row.index.highWatermark} hash=${row.index.hash}`);
  }
  if (!publish) {
    console.log('E2E_1TO2_INDEX_PUBLISH_PREVIEW_ONLY no_telegram_write=true');
    return;
  }

  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const stateDir = String(process.env.E2E_1TO2_INDEX_STATE_DIR || '').trim();
  if (!token || !stateDir) throw new Error('TEST bot token and local 1to2 index state directory are required');
  await verifyTwoTestBotAccess({ token });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, 'publish.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('Another 1to2 index publish is active or needs manual recovery');
    throw error;
  });
  try {
    for (const row of rows) {
      if (updateExisting) await updateExistingOne(row, stateDir);
      else await publishOne(row, stateDir);
    }
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
  console.log(updateExisting
    ? 'E2E_1TO2_INDEX_UPDATED_PASS destinations=2 H=62'
    : 'E2E_1TO2_INDEX_PUBLISHED_PASS destinations=2 H=62');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
