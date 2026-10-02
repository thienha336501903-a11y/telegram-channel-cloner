// One guarded, restart-safe index for the already copied learner-free TEST channel.
// Uses the retained local Docker database. No source Telegram or Production API is written.
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildCourseIndex } from './course-index-core.mjs';
import { verifyTestBot } from './test-bot-identity.mjs';
import {
  editTextSafely, getChatSafely, isKnownTelegramFailure,
  pinMessageSafely, sendTextSafely
} from '../../lib/distributor-telegram.js';

const SOURCE = '-1003535777660';
const DESTINATION = '-1004492904064';
const RUN = '023c3197-fe64-4ddf-9229-2632a2fad4a9';
const EXPECTED_FIRST = [[2, 14], [3, 15], [4, 16], [5, 17], [7, 18]];
const publish = process.argv.includes('--publish');
const appendixStart = Number(process.env.E2E_INDEX_APPENDIX_START || 0) || null;

const sql = `
with s as (select id,chat_id,title,active from public.tgcloner_sources where chat_id='${SOURCE}'),
d as (select id,source_id,chat_id,username,active from public.tgcloner_destinations where chat_id='${DESTINATION}'),
r as (select id,source_id,destination_id,status,phase,manifest_closed_at,snapshot_high_watermark
     from public.tgcloner_clone_runs where id='${RUN}')
select json_build_object(
  'source',(select row_to_json(s) from s),
  'destination',(select row_to_json(d) from d),
  'run',(select row_to_json(r) from r),
  'manifest_count',(select count(*) from public.tgcloner_clone_manifest where run_id='${RUN}'),
  'unsafe_work',(select count(*) from public.tgcloner_clone_work where run_id='${RUN}' and
      ((phase='copy' and status not in ('done','skipped','cancelled')) or
       status in ('blocked_ambiguous','blocked_dependency','failed') or side_effect_state='ambiguous')),
  'source_drift',(select count(*) from public.tgcloner_clone_manifest mf
    join public.tgcloner_source_messages m on m.source_id=(select id from s) and m.source_message_id=mf.source_message_id
    where mf.run_id='${RUN}' and mf.source_fingerprint is distinct from md5(jsonb_build_object(
      'message_type',m.message_type,'text',m.text,'text_entities',m.text_entities,
      'caption',m.caption,'caption_entities',m.caption_entities,'media_group_id',m.media_group_id,
      'is_pinned',m.is_pinned,'has_internal_links',m.has_internal_links,'source_date',m.source_date)::text)),
  'messages',(select json_agg(json_build_object('source_message_id',m.source_message_id,
    'media_group_id',m.media_group_id,'text',m.text,'caption',m.caption) order by m.source_message_id)
    from public.tgcloner_source_messages m join s on m.source_id=s.id),
  'mappings',(select json_agg(json_build_object('source_message_id',m.source_message_id,
    'destination_message_id',m.destination_message_id,'status',m.status) order by m.source_message_id)
    from public.tgcloner_message_mappings m join d on m.destination_id=d.id)
)::text`;

function readSnapshot() {
  const output = execFileSync('docker', ['exec', 'tgcloner-e2e-db', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  }).trim();
  return JSON.parse(output);
}

function checkSnapshot(data) {
  if (data?.source?.chat_id !== SOURCE || data?.destination?.chat_id !== DESTINATION ||
      data.destination.source_id !== data.source.id || data?.run?.id !== RUN ||
      data.run.source_id !== data.source.id || data.run.destination_id !== data.destination.id ||
      data.source.active !== false || data.destination.active !== false ||
      data.run.status !== 'active' || !data.run.manifest_closed_at ||
      Number(data.run.snapshot_high_watermark) !== 56 || Number(data.manifest_count) !== 53 ||
      Number(data.unsafe_work) !== 0 || Number(data.source_drift) !== 0 ||
      data.messages?.length !== 53 || data.mappings?.length !== 53 ||
      Number(data.messages.at(-1)?.source_message_id) !== 56) {
    throw new Error('Local TEST snapshot changed or copy work is unsafe; no index was posted');
  }
  for (const [sourceId, destinationId] of EXPECTED_FIRST) {
    const row = data.mappings.find((mapping) => Number(mapping.source_message_id) === sourceId);
    if (Number(row?.destination_message_id) !== destinationId || row?.status !== 'copied') {
      throw new Error('Verified course prefix changed; no index was posted');
    }
  }
}

async function saveState(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function loadState(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkPinned(chat, index, messageId) {
  const pinned = chat?.pinned_message;
  if (Number(pinned?.message_id || 0) !== Number(messageId)) return false;
  if (pinned.text !== index.text) throw new Error('Pinned index text differs from the generated snapshot');
  const actualUrls = new Set((pinned.entities || []).filter((entity) => entity.type === 'text_link').map((entity) => entity.url));
  if (index.entities.some((entity) => !actualUrls.has(entity.url))) throw new Error('Pinned index is missing destination links');
  return true;
}

const data = readSnapshot();
checkSnapshot(data);
const index = buildCourseIndex({
  source: data.source, destination: data.destination, messages: data.messages,
  mappings: data.mappings, appendixStartSourceId: appendixStart
});
if (index.postCount !== 53 || index.highWatermark !== 56 || index.albumCount !== 11) {
  throw new Error('Index count, album inventory or high watermark changed');
}
console.log(`E2E_COURSE_INDEX_READY posts=${index.postCount} entries=${index.groupCount} H=${index.highWatermark} hash=${index.hash} chars=${index.text.length}`);
for (const [position, entry] of index.entries.entries()) {
  console.log(`INDEX_ENTRY ${String(position + 1).padStart(2, '0')} source=${entry.sourceIds.join(',')} destination=${entry.destinationId} title=${entry.title}`);
}
if (!publish) {
  console.log('E2E_COURSE_INDEX_PREVIEW_ONLY; no Telegram Bot API call made');
  process.exit(0);
}

const statePath = String(process.env.E2E_INDEX_STATE_PATH || '');
if (!statePath || !process.env.TELEGRAM_BOT_TOKEN) throw new Error('Local state path and TEST bot token are required');
await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
const lockPath = `${statePath}.lock`;
const lock = await open(lockPath, 'wx', 0o600).catch((error) => {
  if (error.code === 'EEXIST') throw new Error('Another index publish is active or needs manual recovery; no duplicate post will be sent');
  throw error;
});

try {
  const state = await loadState(statePath);
  if (state && (state.version !== 1 || state.sourceChatId !== SOURCE || state.destinationChatId !== DESTINATION || state.runId !== RUN ||
    !['known_failure', 'armed', 'sent', 'editing', 'published'].includes(state.phase))) {
    throw new Error('Index ledger is unknown; reconcile it before posting');
  }
  if (state && !state.messageId && state.phase !== 'known_failure') {
    throw new Error('Previous send outcome is ambiguous. Check the TEST channel and reconcile the ledger before retrying; no second post was sent');
  }
  if (state?.retryNotBefore && Date.now() < Date.parse(state.retryNotBefore)) {
    throw new Error(`Telegram retry_after is still active until ${state.retryNotBefore}; no Bot API write was attempted`);
  }
  await verifyTestBot({ token: process.env.TELEGRAM_BOT_TOKEN, expectedUsername: 'yeubep_distributor_test_bot' });
  const chat = await getChatSafely({ chatId: DESTINATION });
  if (chat.type !== 'channel' || String(chat.id) !== DESTINATION) throw new Error('TEST destination identity changed');

  const ledger = state || { version: 1, sourceChatId: SOURCE, destinationChatId: DESTINATION, runId: RUN };
  if (!ledger.messageId) {
    if (chat.pinned_message) throw new Error('A different destination message is pinned; inspect before publishing');
    await saveState(statePath, { ...ledger, phase: 'armed', contentHash: index.hash });
    try {
      const sent = await sendTextSafely({ chatId: DESTINATION, text: index.text, entities: index.entities });
      ledger.messageId = Number(sent.message_id);
      ledger.contentHash = index.hash;
      ledger.phase = 'sent';
      delete ledger.retryNotBefore;
      await saveState(statePath, ledger);
    } catch (error) {
      if (isKnownTelegramFailure(error)) {
        const retryNotBefore = error.retryAfter ? new Date(Date.now() + error.retryAfter * 1000).toISOString() : null;
        await saveState(statePath, { ...ledger, phase: 'known_failure', retryNotBefore });
      }
      throw error;
    }
  } else if (ledger.contentHash !== index.hash) {
    if (ledger.phase === 'editing') {
      if (!checkPinned(chat, index, ledger.messageId)) {
        throw new Error('Previous edit outcome is ambiguous; inspect the pinned TEST message before retrying');
      }
      ledger.contentHash = index.hash;
    } else {
      if (chat.pinned_message && Number(chat.pinned_message.message_id) !== ledger.messageId) {
        throw new Error('A different message is pinned; index edit blocked');
      }
      await saveState(statePath, { ...ledger, phase: 'editing' });
      try {
        await editTextSafely({ chatId: DESTINATION, messageId: ledger.messageId, text: index.text, entities: index.entities, disableLinkPreview: true });
      } catch (error) {
        if (isKnownTelegramFailure(error)) {
          const retryNotBefore = error.retryAfter ? new Date(Date.now() + error.retryAfter * 1000).toISOString() : null;
          await saveState(statePath, { ...ledger, phase: 'sent', retryNotBefore });
        }
        throw error;
      }
      ledger.contentHash = index.hash;
      delete ledger.retryNotBefore;
    }
    ledger.phase = 'sent';
    await saveState(statePath, ledger);
  }

  const beforePin = await getChatSafely({ chatId: DESTINATION });
  if (beforePin.pinned_message && Number(beforePin.pinned_message.message_id) !== ledger.messageId) {
    throw new Error('A different message is pinned; refusing to alter it');
  }
  if (!beforePin.pinned_message) {
    try { await pinMessageSafely({ chatId: DESTINATION, messageId: ledger.messageId }); }
    catch (error) {
      if (isKnownTelegramFailure(error) && error.retryAfter) {
        await saveState(statePath, { ...ledger, retryNotBefore: new Date(Date.now() + error.retryAfter * 1000).toISOString() });
      }
      throw error;
    }
  }
  const afterPin = await getChatSafely({ chatId: DESTINATION });
  if (!checkPinned(afterPin, index, ledger.messageId)) throw new Error('Index pin could not be independently verified');
  ledger.phase = 'published';
  delete ledger.retryNotBefore;
  await saveState(statePath, ledger);
  console.log(`E2E_COURSE_INDEX_PUBLISHED_PASS posts=53 entries=${index.groupCount} destination_message_id=${ledger.messageId} url=https://t.me/c/4492904064/${ledger.messageId}`);
} finally {
  await lock.close();
  await unlink(lockPath);
}
