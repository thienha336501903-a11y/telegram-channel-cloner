import { count, patch, select, upsert } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { linksForNormalizedMessage } from '../../lib/source-message.js';
import {
  claimDistributorWork,
  closeDistributorManifest,
  createDistributorRun,
  getDistributorProgress,
  prepareDistributorCatchup,
  prepareDistributorFidelity
} from '../../lib/distributor-repository.js';
import { advanceDistributorRun, processDistributorWork } from '../../lib/distributor-engine.js';
import { getChatSafely } from '../../lib/distributor-telegram.js';
import { execFileSync } from 'node:child_process';
import { COURSE_SOURCE, COURSE_DESTINATION, PREFIX_SOURCE_IDS, validateResumeMappings } from './resume-course-core.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const workerId = `local-e2e-${process.pid}`;
const sourceChatId = String(process.env.E2E_SOURCE_CHAT_ID || '').trim();
const destinationChatIds = String(process.env.E2E_DESTINATION_CHAT_IDS || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const waitForLatePost = String(process.env.E2E_WAIT_FOR_LATE_POST || '').toLowerCase() === 'true';
const smokeOnly = String(process.env.E2E_SMOKE_ONLY || '').toLowerCase() === 'true';
const existingCopyOnly = String(process.env.E2E_EXISTING_COPY_ONLY || '').toLowerCase() === 'true';
const coursePrefix = String(process.env.E2E_EXISTING_COURSE_PREFIX || '').toLowerCase() === 'true';
const resumeFull = String(process.env.E2E_RESUME_COURSE_FULL || '').toLowerCase() === 'true';
const twoDestinationPilot = String(process.env.E2E_TWO_DESTINATION_PILOT || '').toLowerCase() === 'true';
const resumeTwo = String(process.env.E2E_RESUME_TWO_DESTINATION || '').toLowerCase() === 'true';
const recoverTwoAfterLate = String(process.env.E2E_RECOVER_TWO_AFTER_LATE || '').toLowerCase() === 'true';
const continueTwoOnePost = String(process.env.E2E_CONTINUE_TWO_ONE_POST || '').toLowerCase() === 'true';
const maxExistingCopies = Number(process.env.E2E_EXISTING_MAX_COPIES || 1);
const excludedSourceId = Number(process.env.E2E_EXISTING_EXCLUDED_SOURCE_ID || 0);

if (!sourceChatId) throw new Error('E2E_SOURCE_CHAT_ID is required');
if (![1, 2, 3].includes(destinationChatIds.length)) throw new Error('E2E_DESTINATION_CHAT_IDS must contain exactly 1, 2 or 3 chat ids');
if (smokeOnly && destinationChatIds.length !== 1) throw new Error('E2E smoke mode supports exactly one destination');
if (existingCopyOnly && !smokeOnly) throw new Error('Existing copy requires isolated smoke mode');
if (existingCopyOnly && (!Number.isSafeInteger(maxExistingCopies) || maxExistingCopies < 1 || maxExistingCopies > (resumeFull ? 100000 : coursePrefix ? 5 : 1))) throw new Error('Existing copy cap is invalid');
if (coursePrefix && (!existingCopyOnly || excludedSourceId)) throw new Error('Chronological course copy cannot skip any source post');
if (resumeFull && (coursePrefix || !existingCopyOnly || !smokeOnly || destinationChatIds.length !== 1 || sourceChatId !== COURSE_SOURCE || destinationChatIds[0] !== COURSE_DESTINATION)) throw new Error('Full course resume is restricted to the confirmed TEST pair');
if (destinationChatIds.length === 2 && !twoDestinationPilot) throw new Error('Two destinations require the isolated 1to2 pilot');
if (twoDestinationPilot && (smokeOnly || existingCopyOnly || (!waitForLatePost && !recoverTwoAfterLate && !continueTwoOnePost) || sourceChatId !== '-1004320185488' ||
  [...destinationChatIds].sort().join(',') !== '-1003933578709,-1004492904064')) throw new Error('Isolated 1to2 pilot identity mismatch');
if (resumeTwo && !twoDestinationPilot) throw new Error('1to2 resume requires the isolated pilot');
if (recoverTwoAfterLate && (!twoDestinationPilot || resumeTwo || waitForLatePost ||
  Number(process.env.E2E_EXPECTED_HIGH_WATERMARK) !== 60 || Number(process.env.E2E_EXPECTED_HISTORY_COUNT) !== 59 ||
  Number(process.env.E2E_EXPECTED_LATE_SOURCE_ID) !== 61)) throw new Error('Isolated 1to2 late-post recovery identity mismatch');
if (continueTwoOnePost && (!twoDestinationPilot || resumeTwo || recoverTwoAfterLate || waitForLatePost ||
  Number(process.env.E2E_EXPECTED_HIGH_WATERMARK) !== 61 || Number(process.env.E2E_EXPECTED_HISTORY_COUNT) !== 60 ||
  Number(process.env.E2E_EXPECTED_LATE_SOURCE_ID) !== 0)) throw new Error('Isolated 1to2 one-post continuation identity mismatch');
if (destinationChatIds.includes(sourceChatId)) throw new Error('Refusing to copy into the source channel');

async function one(table, query) {
  const rows = await select(table, query);
  return rows?.[0] || null;
}

async function allRows(table, query) {
  const rows = [];
  for (let offset = 0; offset <= 100000; offset += 500) {
    const page = await select(table, `${query}&limit=500&offset=${offset}`);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
  throw new Error(`Local ${table} result exceeds the full course safety cap`);
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
    if (twoDestinationPilot) {
      total += await count(TABLES.messageMappings, `run_id=eq.${encodeURIComponent(runId)}&status=eq.copied`);
    } else {
      const rows = await select(TABLES.messageMappings, `select=id&run_id=eq.${encodeURIComponent(runId)}`);
      total += rows?.length || 0;
    }
  }
  return total;
}

async function processClaimed(limit, { allowedPhase = null } = {}) {
  const claimed = await claimDistributorWork({ workerId, limit, leaseSeconds: 120 });
  for (const work of claimed) {
    if (allowedPhase && work.phase !== allowedPhase) throw new Error(`Course copy-only run refused unexpected ${work.phase} work before any Telegram side effect`);
    const result = await processDistributorWork(work, { workerId });
    if (!result?.ok && result?.work?.status === 'blocked_ambiguous') {
      throw new Error(`BLOCKED_AMBIGUOUS work=${work.id}; reconcile manually before any retry`);
    }
  }
  return claimed.length;
}

async function driveToReady(runIds) {
  for (let cycle = 0; cycle < (twoDestinationPilot ? 3600 : 360); cycle += 1) {
    const blockers = await unresolvedWork(runIds);
    if (blockers.length) throw new Error(`Distributor blocker: ${JSON.stringify(blockers)}`);

    const claimed = await processClaimed(Math.max(1, runIds.length));
    const current = await runRows(runIds);
    if (current.length === runIds.length && current.every((run) => run.phase === 'ready_for_new' && run.status === 'active' && run.last_verified_at)) {
      return current;
    }
    if (!claimed) {
      for (const run of current) await advanceDistributorRun(run.id);
      if (twoDestinationPilot && cycle % 20 === 0) {
        console.log('E2E_1TO2_READY_PROGRESS', JSON.stringify(current.map((run) => ({ id: run.id, phase: run.phase }))));
      }
      await sleep(500);
    }
  }
  throw new Error('Timed out waiting for READY_FOR_NEW');
}

const source = await one(TABLES.sources, `select=*&chat_id=eq.${encodeURIComponent(sourceChatId)}&limit=1`);
if (!source) throw new Error(smokeOnly ? 'Source not found in isolated DB. Smoke source capture must run first.' : 'Source not found in isolated DB. Run Reader import first.');
if ((resumeFull || twoDestinationPilot) && source.active) throw new Error('The local TEST source unexpectedly has MASTER status');
const messages = await allRows(TABLES.sourceMessages, `select=*&source_id=eq.${encodeURIComponent(source.id)}&order=source_message_id.asc`);
if (!messages?.length) throw new Error('Source manifest is empty');
const baselineMessages = (recoverTwoAfterLate || continueTwoOnePost)
  ? messages.filter((message) => Number(message.source_message_id) <= 60) : messages;
if (recoverTwoAfterLate && (baselineMessages.length !== 59 || Number(baselineMessages.at(-1)?.source_message_id) !== 60 ||
  messages.length !== 60 || Number(messages.at(-1)?.source_message_id) !== 61 ||
  messages.at(-1)?.message_type !== 'text' || messages.at(-1)?.media_group_id)) {
  throw new Error('Recovery source rows must be 59 baseline posts plus the webhook-captured text post #61');
}
if (continueTwoOnePost && (baselineMessages.length !== 59 || Number(baselineMessages.at(-1)?.source_message_id) !== 60 ||
  messages.length !== 60 || Number(messages.at(-1)?.source_message_id) !== 61 ||
  messages.at(-1)?.message_type !== 'text' || messages.at(-1)?.media_group_id)) {
  throw new Error('One-post continuation needs the verified 59-post manifest and already mapped text post #61');
}

if (!smokeOnly && !twoDestinationPilot) {
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
} else if (smokeOnly) {
  if (!existingCopyOnly && messages.some((message) => message.message_type !== 'text')) {
    throw new Error('Smoke source manifest must contain plain text only');
  }
  if (existingCopyOnly && (messages.length < 1 || messages.length > maxExistingCopies || resumeFull && messages.length !== maxExistingCopies)) {
    throw new Error(`Existing copy manifest exceeds the ${maxExistingCopies}-post cap`);
  }
  if (resumeFull) {
    const ids = new Set(messages.map((message) => Number(message.source_message_id)));
    if (Number(process.env.E2E_EXPECTED_HIGH_WATERMARK) !== Number(messages.at(-1).source_message_id)) throw new Error('Source high watermark changed after inventory');
    for (const message of messages) {
      const sourceLinks = linksForNormalizedMessage(message, { private_link_id: source.private_link_id, username: source.username });
      if (sourceLinks.some((link) => !ids.has(Number(link.source_message_id)))) throw new Error(`Course post ${message.source_message_id} links outside the full manifest`);
    }
  }
  if (existingCopyOnly && coursePrefix) {
    const ids = new Set(messages.map((message) => Number(message.source_message_id)));
    const groups = new Map();
    for (const [index, message] of messages.entries()) {
      if (message.media_group_id) {
        const positions = groups.get(message.media_group_id) || [];
        positions.push(index);
        groups.set(message.media_group_id, positions);
      }
      const sourceLinks = linksForNormalizedMessage(message, { private_link_id: source.private_link_id, username: source.username });
      if (sourceLinks.some((link) => !ids.has(Number(link.source_message_id)))) {
        throw new Error(`Course post ${message.source_message_id} links to an uncopied source post; refusing to leave a source link in the destination`);
      }
    }
    if ([...groups.values()].some((positions) => positions.length < 2 || positions.some((position, i) => i && position !== positions[i - 1] + 1))) {
      throw new Error('Course manifest contains an incomplete album');
    }
  }
}
if (smokeOnly || twoDestinationPilot) {
  console.log(`${twoDestinationPilot ? 'E2E_1TO2_MANIFEST' : existingCopyOnly ? 'E2E_EXISTING_MANIFEST' : 'E2E_SMOKE_MANIFEST'} source=${source.chat_id} messages=${baselineMessages.length}`);
}

await patch(TABLES.settings, 'singleton=eq.true', { distributor_v2_enabled: true, scheduler_enabled: false }, { returning: false });

const destinations = [];
for (const chatId of destinationChatIds) {
  const chat = await getChatSafely({ chatId });
  if (chat?.type !== 'channel') throw new Error(`Destination is not a channel: ${chatId}`);
  const destination = continueTwoOnePost
    ? await one(TABLES.destinations, `select=*&chat_id=eq.${encodeURIComponent(chatId)}&limit=1`)
    : (await upsert(TABLES.destinations, {
      source_id: source.id,
      chat_id: String(chat.id),
      title: chat.title || `E2E ${chat.id}`,
      username: chat.username || null,
      active: false,
      updated_at: new Date().toISOString()
    }, { onConflict: 'chat_id' }))[0];
  if (!destination || destination.source_id !== source.id || destination.active !== false) {
    throw new Error(`TEST destination identity changed: ${chatId}`);
  }
  destinations.push(destination);
}

const expectedMessageIds = baselineMessages.map((message) => Number(message.source_message_id));
const highWatermark = Math.max(...expectedMessageIds);
const runs = [];
for (const destination of destinations) {
  let run = null;
  if (recoverTwoAfterLate || continueTwoOnePost) {
    const prior = await allRows(TABLES.cloneRuns, `select=*&destination_id=eq.${encodeURIComponent(destination.id)}&order=created_at.asc`);
    if (prior.length !== 1 || prior[0].status !== 'active' || prior[0].source_id !== source.id ||
        !prior[0].manifest_closed_at || Number(prior[0].snapshot_high_watermark) !== highWatermark ||
        !(continueTwoOnePost ? prior[0].phase === 'ready_for_new' && prior[0].last_verified_at :
          ['catching_up', 'rewriting', 'verifying', 'ready_for_new'].includes(prior[0].phase))) {
      throw new Error(`Retained isolated 1to2 run cannot be recovered for ${destination.chat_id}`);
    }
    const manifest = await allRows(TABLES.cloneManifest, `select=source_message_id&run_id=eq.${encodeURIComponent(prior[0].id)}&order=source_message_id.asc`);
    if (JSON.stringify(manifest.map((item) => Number(item.source_message_id))) !== JSON.stringify(expectedMessageIds)) {
      throw new Error(`Retained isolated 1to2 manifest drift for ${destination.chat_id}`);
    }
    run = prior[0];
    console.log(`${continueTwoOnePost ? 'E2E_1TO2_ONE_POST_RUN' : 'E2E_1TO2_RECOVERY_RUN'} run=${run.id} destination=${destination.chat_id} phase=${run.phase}`);
  } else if (resumeFull) {
    const allRuns = await select(TABLES.cloneRuns, `select=*&destination_id=eq.${encodeURIComponent(destination.id)}&order=created_at.asc`);
    const old = allRuns.filter((item) => Number(item.snapshot_high_watermark) === 7);
    const activeFull = allRuns.filter((item) => item.status === 'active' && Number(item.snapshot_high_watermark) === highWatermark && item.manifest_closed_at);
    const pendingFull = allRuns.filter((item) => item.status === 'active' && !item.manifest_closed_at && item.phase === 'registered');
    if (old.length !== 1 || activeFull.length + pendingFull.length > 1 || allRuns.some((item) => ![old[0].id, activeFull[0]?.id, pendingFull[0]?.id].includes(item.id) && !['failed', 'cancelled', 'superseded'].includes(item.status))) throw new Error('Unexpected local TEST run state; no Telegram copy started');
    const oldManifest = await allRows(TABLES.cloneManifest, `select=source_message_id&run_id=eq.${encodeURIComponent(old[0].id)}&order=source_message_id.asc`);
    if (JSON.stringify(oldManifest.map((item) => Number(item.source_message_id))) !== JSON.stringify(PREFIX_SOURCE_IDS)) throw new Error('Old five-post manifest changed');
    const oldBlockers = await select(TABLES.cloneWork, `select=id,status,phase,side_effect_state&run_id=eq.${encodeURIComponent(old[0].id)}&status=in.(blocked_ambiguous,blocked_dependency,failed,leased)&limit=1`);
    if (oldBlockers.length) throw new Error('Prior TEST run has unresolved or leased work; reconcile first');
    const sourceRows = await allRows(TABLES.sourceMessages, `select=source_message_id&source_id=eq.${encodeURIComponent(source.id)}&order=source_message_id.asc`);
    if (JSON.stringify(sourceRows.map((item) => Number(item.source_message_id))) !== JSON.stringify(expectedMessageIds)) throw new Error('Local source rows differ from the inventoried course');
    const mapped = await allRows(TABLES.messageMappings, `select=source_message_id,destination_message_id,status&destination_id=eq.${encodeURIComponent(destination.id)}&order=source_message_id.asc`);
    validateResumeMappings(mapped, messages);
    if (activeFull.length || pendingFull.length) {
      const restarted = activeFull[0] || pendingFull[0];
      if (old[0].status !== 'superseded' || activeFull.length && Number(restarted.snapshot_high_watermark) !== highWatermark) throw new Error('Full restart run has an invalid predecessor');
      if (activeFull.length) {
        const manifest = await allRows(TABLES.cloneManifest, `select=source_message_id&run_id=eq.${encodeURIComponent(restarted.id)}&order=source_message_id.asc`);
        if (JSON.stringify(manifest.map((item) => Number(item.source_message_id))) !== JSON.stringify(expectedMessageIds)) throw new Error('Full restart manifest changed');
      }
      run = restarted;
      console.log(`E2E_FULL_COURSE_RESTART run=${run.id} mapped=${mapped.length}`);
    } else {
      if (!['active','paused','superseded'].includes(old[0].status)) throw new Error('Prior five-post run cannot be superseded');
      if (old[0].status !== 'superseded') {
        const oldCopyWork = await select(TABLES.cloneWork, `select=id,status&run_id=eq.${encodeURIComponent(old[0].id)}&phase=eq.copy`);
        if (oldCopyWork.some((item) => item.status !== 'done')) throw new Error('Prior five-post copy work is not fully committed');
        const id = String(old[0].id);
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Malformed local run ID');
        const sql = `begin; do $$ begin if not exists (select 1 from public.tgcloner_clone_runs where id='${id}' and snapshot_high_watermark=7 and status in ('active','paused') for update) or exists (select 1 from public.tgcloner_clone_work where run_id='${id}' and status in ('leased','blocked_ambiguous','blocked_dependency','failed')) then raise exception 'local_five_post_run_changed'; end if; update public.tgcloner_clone_runs set status='superseded', status_reason='local_full_course_resume', updated_at=clock_timestamp(), version=version+1 where id='${id}'; update public.tgcloner_clone_work set status='cancelled', updated_at=clock_timestamp() where run_id='${id}' and status in ('queued','retry_wait'); end $$; commit;`;
        execFileSync('docker', ['exec', 'tgcloner-e2e-db', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], { timeout: 30_000, stdio: 'pipe' });
      }
      run = await createDistributorRun({ sourceId: source.id, destinationId: destination.id });
      console.log(`E2E_FULL_COURSE_NEW_RUN run=${run.id} preserved_mappings=${mapped.length}`);
    }
  } else if (resumeTwo) {
    const prior = await allRows(TABLES.cloneRuns, `select=*&destination_id=eq.${encodeURIComponent(destination.id)}&order=created_at.asc`);
    if (prior.length !== 1 || prior[0].status !== 'active' || prior[0].source_id !== source.id ||
        prior[0].phase === 'ready_for_new' || !prior[0].manifest_closed_at ||
        Number(prior[0].snapshot_high_watermark) !== highWatermark) {
      throw new Error(`Isolated 1to2 run cannot be resumed for ${destination.chat_id}; no Telegram copy started`);
    }
    const manifest = await allRows(TABLES.cloneManifest, `select=source_message_id&run_id=eq.${encodeURIComponent(prior[0].id)}&order=source_message_id.asc`);
    if (JSON.stringify(manifest.map((item) => Number(item.source_message_id))) !== JSON.stringify(expectedMessageIds)) {
      throw new Error(`Isolated 1to2 manifest drift for ${destination.chat_id}`);
    }
    run = prior[0];
    console.log(`E2E_1TO2_RESUME run=${run.id} destination=${destination.chat_id}`);
  } else {
    run = await createDistributorRun({ sourceId: source.id, destinationId: destination.id });
  }
  runs.push(recoverTwoAfterLate || continueTwoOnePost ? run : await closeDistributorManifest({ runId: run.id, highWatermark, expectedMessageIds }));
}
const runIds = runs.map((run) => run.id);
console.log(`E2E_MANIFEST_CLOSED source=${source.chat_id} messages=${baselineMessages.length} destinations=${runIds.length} H=${highWatermark}`);

if (existingCopyOnly) {
  const expectedSourceIds = new Set(messages.map((message) => Number(message.source_message_id)));
  let mappings = [];
  let idleCycles = 0;
  for (let cycle = 0; cycle < maxExistingCopies * 60; cycle += 1) {
    if (resumeFull) {
      const copied = await count(TABLES.messageMappings, `run_id=eq.${encodeURIComponent(runIds[0])}&status=eq.copied`);
      if (copied === messages.length) {
        const rows = await allRows(TABLES.messageMappings, `select=source_message_id,destination_message_id&run_id=eq.${encodeURIComponent(runIds[0])}&status=eq.copied&order=source_message_id.asc`);
        if (rows.every((row) => expectedSourceIds.has(Number(row.source_message_id)))) { mappings = rows; break; }
      }
    } else {
      const rows = await select(TABLES.messageMappings, `select=source_message_id,destination_message_id&run_id=eq.${encodeURIComponent(runIds[0])}&status=eq.copied`);
      if (rows?.length === messages.length && rows.every((row) => expectedSourceIds.has(Number(row.source_message_id)))) { mappings = rows; break; }
    }
    const blockers = await unresolvedWork(runIds);
    if (blockers.length) throw new Error(`Existing copy blocker: ${JSON.stringify(blockers)}`);
    const claimed = await processClaimed(1, { allowedPhase: 'copy' });
    if (resumeFull && claimed && cycle % 10 === 0) console.log(`E2E_FULL_COURSE_PROGRESS copied_work_units=${cycle + 1} target_posts=${messages.length}`);
    if (claimed) idleCycles = 0;
    if (!claimed) {
      await advanceDistributorRun(runIds[0]);
      idleCycles += 1;
      if (resumeFull && idleCycles >= 40) {
        const waiting = await select(TABLES.cloneWork, `select=source_message_id,status,next_attempt_at,last_error_code&run_id=eq.${encodeURIComponent(runIds[0])}&phase=eq.copy&status=in.(queued,retry_wait,leased)&limit=5`);
        throw new Error(`Full course paused with no claimable copy work: ${JSON.stringify(waiting)}. Keep the DB; rerun the same command only after reconciliation or retry time.`);
      }
      await sleep(250);
    }
  }
  if (mappings.length !== messages.length || mappings.some((row) => !Number.isSafeInteger(Number(row.destination_message_id)) || Number(row.destination_message_id) <= 0)) {
    throw new Error('Existing source posts were not all durably mapped to the destination');
  }
  mappings.sort((a, b) => Number(a.source_message_id) - Number(b.source_message_id));
  if ((coursePrefix || resumeFull) && mappings.some((mapping, index) => index > 0 && Number(mapping.destination_message_id) <= Number(mappings[index - 1].destination_message_id))) {
    throw new Error('Copied course posts are not in chronological destination order; reconcile before any retry');
  }
  if (coursePrefix || resumeFull) {
    const linkPosts = messages.filter((message) => message.has_internal_links);
    if (linkPosts.length) {
      let rewriting = false;
      for (let cycle = 0; cycle < 40; cycle += 1) {
        const run = await one(TABLES.cloneRuns, `select=phase,status&id=eq.${encodeURIComponent(runIds[0])}&limit=1`);
        if (run?.phase === 'rewriting' && run.status === 'active') { rewriting = true; break; }
        if (!run || run.status !== 'active') throw new Error('Course run was blocked before link rewrite');
        await prepareDistributorCatchup({ runId: runIds[0], albumSettleSeconds: 0, quietSeconds: 0 });
        await sleep(100);
      }
      if (!rewriting) throw new Error('Course link rewrite phase did not become ready');
      await prepareDistributorFidelity({ runId: runIds[0], pinnedSourceMessageId: null });
      for (let cycle = 0; cycle < linkPosts.length * 10; cycle += 1) {
        const rewrites = resumeFull
          ? await allRows(TABLES.cloneWork, `select=id,status,source_message_id,result&run_id=eq.${encodeURIComponent(runIds[0])}&phase=eq.rewrite&order=source_message_id.asc`)
          : await select(TABLES.cloneWork, `select=id,status,source_message_id,result&run_id=eq.${encodeURIComponent(runIds[0])}&phase=eq.rewrite`);
        if (rewrites?.length === linkPosts.length && rewrites.every((work) => work.status === 'done' && work.result?.actual_verified === true)) {
          console.log(`E2E_COURSE_LINK_REWRITE_PASS posts=${rewrites.length}`);
          break;
        }
        const blockers = await unresolvedWork(runIds);
        if (blockers.length) throw new Error(`Course rewrite blocker: ${JSON.stringify(blockers)}`);
        const claimed = await processClaimed(1, { allowedPhase: 'rewrite' });
        if (!claimed) await sleep(100);
        if (cycle === linkPosts.length * 10 - 1) throw new Error('Course links were not all rewritten');
      }
    }
  }
  if (resumeFull) console.log(`E2E_FULL_COURSE_COPY_PASS posts=${mappings.length} H=${highWatermark} destination=${destinationChatIds[0]}`);
  for (const mapping of resumeFull ? mappings.slice(0, 5) : mappings) {
    console.log(`E2E_EXISTING_POST_COPY_PASS source_message_id=${mapping.source_message_id} destination_message_id=${mapping.destination_message_id} destination=${destinationChatIds[0]}`);
  }
  if (coursePrefix) console.log(`E2E_COURSE_PREFIX_COPY_PASS posts=${mappings.length} max_posts=${maxExistingCopies}`);
  if (resumeFull) console.log('E2E_FULL_COURSE_COPY_AUTOMATED_PASS; verify media, appendix, album and links manually in the TEST channel');
  process.exit(0);
}

if (waitForLatePost || continueTwoOnePost) {
  const expectedBaselineMappings = messages.length * runIds.length;
  let baselineComplete = continueTwoOnePost && await mappingCount(runIds) === expectedBaselineMappings;
  if (continueTwoOnePost && !baselineComplete) throw new Error('One-post continuation refused incomplete 60-post mappings');
  if (!continueTwoOnePost) {
    for (let cycle = 0; cycle < (twoDestinationPilot ? 7200 : 240); cycle += 1) {
      const copied = await mappingCount(runIds);
      if (copied >= expectedBaselineMappings) { baselineComplete = true; break; }
      if (twoDestinationPilot && cycle % 40 === 0) console.log(`E2E_1TO2_BASELINE_PROGRESS copied=${copied} target=${expectedBaselineMappings}`);
      const blockers = await unresolvedWork(runIds);
      if (blockers.length) throw new Error(`Distributor blocker before late post: ${JSON.stringify(blockers)}`);
      const claimed = await processClaimed(Math.max(1, runIds.length));
      if (!claimed) await sleep(300);
    }
  }
  if (!baselineComplete) throw new Error('Timed out copying initial manifest before catch-up checkpoint; preserve the isolated DB for reconciliation');
  console.log(continueTwoOnePost ? 'E2E_POST_ONE_NEW_MESSAGE_NOW' : 'E2E_POST_LATE_MESSAGE_NOW');
  console.log('Đăng đúng 1 bài chữ mới vào kênh nguồn test. Không sửa/xóa bài cũ. Harness đang chờ webhook test.');
  let observed = null;
  for (let i = 0; i < (twoDestinationPilot ? 1200 : 240); i += 1) {
    const newThreshold = continueTwoOnePost ? 61 : highWatermark;
    const rows = await select(TABLES.sourceMessages, `select=source_message_id,message_type,media_group_id,has_internal_links,text&source_id=eq.${encodeURIComponent(source.id)}&source_message_id=gt.${newThreshold}&order=source_message_id.asc&limit=2`);
    if (rows?.[0]) {
      if (continueTwoOnePost && (rows.length !== 1 || Number(rows[0].source_message_id) !== 62 ||
          rows[0].message_type !== 'text' || rows[0].media_group_id || rows[0].has_internal_links ||
          !String(rows[0].text || '').trim())) throw new Error('Unexpected TEST source post; no new copy worker started');
      const event = await one(TABLES.sourceEvents, `select=id,event_kind,source_message_id&source_id=eq.${encodeURIComponent(source.id)}&source_message_id=eq.${Number(rows[0].source_message_id)}&origin=eq.bot_webhook&limit=1`);
      if (event?.event_kind === 'message_new') { observed = event; break; }
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
else if (continueTwoOnePost) console.log('E2E_1TO2_ONE_POST_DB_AND_BOT_WORKER_PASS');
else console.log('E2E_DB_AND_BOT_WORKER_PASS');
