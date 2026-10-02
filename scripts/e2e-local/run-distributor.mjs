import { patch, select, upsert } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { linksForNormalizedMessage } from '../../lib/source-message.js';
import {
  claimDistributorWork,
  closeDistributorManifest,
  createDistributorRun,
  getDistributorProgress
} from '../../lib/distributor-repository.js';
import { advanceDistributorRun, processDistributorWork } from '../../lib/distributor-engine.js';
import { getChatSafely } from '../../lib/distributor-telegram.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const workerId = `local-e2e-${process.pid}`;
const sourceChatId = String(process.env.E2E_SOURCE_CHAT_ID || '').trim();
const destinationChatIds = String(process.env.E2E_DESTINATION_CHAT_IDS || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const waitForLatePost = String(process.env.E2E_WAIT_FOR_LATE_POST || '').toLowerCase() === 'true';
const smokeOnly = String(process.env.E2E_SMOKE_ONLY || '').toLowerCase() === 'true';
const existingCopyOnly = String(process.env.E2E_EXISTING_COPY_ONLY || '').toLowerCase() === 'true';
const maxExistingCopies = Number(process.env.E2E_EXISTING_MAX_COPIES || 1);
const excludedSourceId = Number(process.env.E2E_EXISTING_EXCLUDED_SOURCE_ID || 0);

if (!sourceChatId) throw new Error('E2E_SOURCE_CHAT_ID is required');
if (![1, 3].includes(destinationChatIds.length)) throw new Error('E2E_DESTINATION_CHAT_IDS must contain exactly 1 or 3 chat ids');
if (smokeOnly && destinationChatIds.length !== 1) throw new Error('E2E smoke mode supports exactly one destination');
if (existingCopyOnly && !smokeOnly) throw new Error('Existing copy requires isolated smoke mode');
if (existingCopyOnly && (!Number.isSafeInteger(maxExistingCopies) || maxExistingCopies < 1 || maxExistingCopies > 4)) throw new Error('Existing copy is limited to four new destination posts');
if (destinationChatIds.includes(sourceChatId)) throw new Error('Refusing to copy into the source channel');

async function one(table, query) {
  const rows = await select(table, query);
  return rows?.[0] || null;
}

async function runRows(runIds) {
  const rows = [];
  for (const id of runIds) rows.push(await one(TABLES.cloneRuns, `select=*&id=eq.${encodeURIComponent(id)}&limit=1`));
  return rows.filter(Boolean);
}

async function unresolvedWork(runIds) {
  const rows = [];
  for (const runId of runIds) {
    const part = await select(TABLES.cloneWork, `select=id,run_id,phase,status,last_error_code,last_error&run_id=eq.${encodeURIComponent(runId)}&status=in.(blocked_dependency,blocked_ambiguous,failed)&limit=20`);
    rows.push(...(part || []));
  }
  return rows;
}

async function mappingCount(runIds) {
  let total = 0;
  for (const runId of runIds) {
    const rows = await select(TABLES.messageMappings, `select=id&run_id=eq.${encodeURIComponent(runId)}`);
    total += rows?.length || 0;
  }
  return total;
}

async function processClaimed(limit) {
  const claimed = await claimDistributorWork({ workerId, limit, leaseSeconds: 120 });
  for (const work of claimed) {
    const result = await processDistributorWork(work, { workerId });
    if (!result?.ok && result?.work?.status === 'blocked_ambiguous') {
      throw new Error(`BLOCKED_AMBIGUOUS work=${work.id}; reconcile manually before any retry`);
    }
  }
  return claimed.length;
}

async function driveToReady(runIds) {
  for (let cycle = 0; cycle < 360; cycle += 1) {
    const blockers = await unresolvedWork(runIds);
    if (blockers.length) throw new Error(`Distributor blocker: ${JSON.stringify(blockers)}`);

    const claimed = await processClaimed(Math.max(1, runIds.length));
    const current = await runRows(runIds);
    if (current.length === runIds.length && current.every((run) => run.phase === 'ready_for_new' && run.status === 'active' && run.last_verified_at)) {
      return current;
    }
    if (!claimed) {
      for (const run of current) await advanceDistributorRun(run.id);
      await sleep(500);
    }
  }
  throw new Error('Timed out waiting for READY_FOR_NEW');
}

const source = await one(TABLES.sources, `select=*&chat_id=eq.${encodeURIComponent(sourceChatId)}&limit=1`);
if (!source) throw new Error(smokeOnly ? 'Source not found in isolated DB. Smoke source capture must run first.' : 'Source not found in isolated DB. Run Reader import first.');
const messages = await select(TABLES.sourceMessages, `select=*&source_id=eq.${encodeURIComponent(source.id)}&order=source_message_id.asc`);
if (!messages?.length) throw new Error('Source manifest is empty');

if (!smokeOnly) {
  const sourceShape = { private_link_id: source.private_link_id, username: source.username };
  const hiddenInternal = messages.some((message) => {
    const entities = [...(message.text_entities || []), ...(message.caption_entities || [])];
    return entities.some((entity) => entity?.type === 'text_link') && linksForNormalizedMessage(message, sourceShape).length > 0;
  });
  const hasVideo = messages.some((message) => message.message_type === 'video');
  const albumGroups = new Map();
  for (const message of messages) {
    if (!message.media_group_id) continue;
    albumGroups.set(message.media_group_id, (albumGroups.get(message.media_group_id) || 0) + 1);
  }
  const hasAlbum = [...albumGroups.values()].some((count) => count >= 2);
  const pinned = messages.filter((message) => message.is_pinned);
  if (!hiddenInternal) throw new Error('Fixture missing indexed hidden internal text_link');
  if (!hasVideo) throw new Error('Fixture missing video');
  if (!hasAlbum) throw new Error('Fixture missing 2+ member album');
  if (pinned.length !== 1) throw new Error(`Fixture must have exactly one pinned message; found ${pinned.length}`);
} else {
  if (!existingCopyOnly && messages.some((message) => message.message_type !== 'text')) {
    throw new Error('Smoke source manifest must contain plain text only');
  }
  if (existingCopyOnly && (messages.length < 1 || messages.length > maxExistingCopies)) {
    throw new Error(`Existing copy manifest exceeds the ${maxExistingCopies}-post cap`);
  }
  if (existingCopyOnly && (maxExistingCopies > 1 || excludedSourceId > 0)) {
    if (messages.some((message) => message.media_group_id || message.has_internal_links || Number(message.source_message_id) === excludedSourceId)) {
      throw new Error('Limited copy cannot include an album member, source link or previously copied source post');
    }
  }
  console.log(`${existingCopyOnly ? 'E2E_EXISTING_MANIFEST' : 'E2E_SMOKE_MANIFEST'} source=${source.chat_id} messages=${messages.length}`);
}

await patch(TABLES.settings, 'singleton=eq.true', { distributor_v2_enabled: true, scheduler_enabled: false }, { returning: false });

const destinations = [];
for (const chatId of destinationChatIds) {
  const chat = await getChatSafely({ chatId });
  if (chat?.type !== 'channel') throw new Error(`Destination is not a channel: ${chatId}`);
  const [destination] = await upsert(TABLES.destinations, {
    source_id: source.id,
    chat_id: String(chat.id),
    title: chat.title || `E2E ${chat.id}`,
    username: chat.username || null,
    active: false,
    updated_at: new Date().toISOString()
  }, { onConflict: 'chat_id' });
  destinations.push(destination);
}

const expectedMessageIds = messages.map((message) => Number(message.source_message_id));
const highWatermark = Math.max(...expectedMessageIds);
const runs = [];
for (const destination of destinations) {
  const run = await createDistributorRun({ sourceId: source.id, destinationId: destination.id });
  runs.push(await closeDistributorManifest({ runId: run.id, highWatermark, expectedMessageIds }));
}
const runIds = runs.map((run) => run.id);
console.log(`E2E_MANIFEST_CLOSED source=${source.chat_id} messages=${messages.length} destinations=${runIds.length} H=${highWatermark}`);

if (existingCopyOnly) {
  const expectedSourceIds = new Set(messages.map((message) => Number(message.source_message_id)));
  let mappings = [];
  for (let cycle = 0; cycle < maxExistingCopies * 60; cycle += 1) {
    const rows = await select(TABLES.messageMappings, `select=source_message_id,destination_message_id&run_id=eq.${encodeURIComponent(runIds[0])}&status=eq.copied`);
    if (rows?.length === messages.length && rows.every((row) => expectedSourceIds.has(Number(row.source_message_id)))) {
      mappings = rows;
      break;
    }
    const blockers = await unresolvedWork(runIds);
    if (blockers.length) throw new Error(`Existing copy blocker: ${JSON.stringify(blockers)}`);
    const claimed = await processClaimed(1);
    if (!claimed) {
      await advanceDistributorRun(runIds[0]);
      await sleep(250);
    }
  }
  if (mappings.length !== messages.length || mappings.some((row) => !Number.isSafeInteger(Number(row.destination_message_id)) || Number(row.destination_message_id) <= 0)) {
    throw new Error('Existing source posts were not all durably mapped to the destination');
  }
  for (const mapping of mappings.sort((a, b) => Number(a.source_message_id) - Number(b.source_message_id))) {
    console.log(`E2E_EXISTING_POST_COPY_PASS source_message_id=${mapping.source_message_id} destination_message_id=${mapping.destination_message_id} destination=${destinationChatIds[0]}`);
  }
  if (maxExistingCopies > 1 || excludedSourceId > 0) console.log(`E2E_LIMITED_COPY_PASS new_posts=${mappings.length} max_new=${maxExistingCopies} excluded_source=${excludedSourceId}`);
  process.exit(0);
}

if (waitForLatePost) {
  const expectedBaselineMappings = messages.length * runIds.length;
  for (let cycle = 0; cycle < 240; cycle += 1) {
    if (await mappingCount(runIds) >= expectedBaselineMappings) break;
    const claimed = await processClaimed(Math.max(1, runIds.length));
    if (!claimed) await sleep(300);
    if (cycle === 239) throw new Error('Timed out copying initial manifest before catch-up checkpoint');
  }
  console.log('E2E_POST_LATE_MESSAGE_NOW');
  console.log('Đăng đúng 1 bài chữ mới vào kênh nguồn test. Không sửa/xóa bài cũ. Harness đang chờ webhook test.');
  let observed = null;
  for (let i = 0; i < 240; i += 1) {
    const rows = await select(TABLES.sourceMessages, `select=source_message_id&source_id=eq.${encodeURIComponent(source.id)}&source_message_id=gt.${highWatermark}&order=source_message_id.asc&limit=1`);
    if (rows?.[0]) {
      const event = await one(TABLES.sourceEvents, `select=id,event_kind,source_message_id&source_id=eq.${encodeURIComponent(source.id)}&source_message_id=eq.${Number(rows[0].source_message_id)}&origin=eq.bot_webhook&limit=1`);
      if (event) { observed = event; break; }
    }
    await sleep(500);
  }
  if (!observed) throw new Error('Late post was not indexed with a durable bot_webhook event');
  console.log(`E2E_LATE_EVENT_CAPTURED event=${observed.id} source_message_id=${observed.source_message_id}`);
}

const finalRuns = await driveToReady(runIds);
const progress = await getDistributorProgress({ limit: 50 });
console.log('E2E_READY', JSON.stringify(finalRuns.map((run) => ({ id: run.id, destination_id: run.destination_id, phase: run.phase, verified_at: run.last_verified_at }))));
console.log('E2E_PROGRESS', JSON.stringify(progress));
if (smokeOnly) console.log('E2E_SMOKE_DB_AND_BOT_WORKER_PASS');
else console.log('E2E_DB_AND_BOT_WORKER_PASS');
