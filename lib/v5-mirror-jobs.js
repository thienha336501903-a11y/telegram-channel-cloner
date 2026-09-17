import { db } from './supabase.js';

const BENCHMARK_PREFIX = 'benchmarks/reader-phase1/20260914/message-13/';
const PHASE4_CANARY_COURSE_ID = 'a645f117-2320-452f-8538-154b80484218';
const PHASE4_CANARY_SOURCE_ID = '039eedf1-6d26-4d04-a152-27e4d29fc5c0';
const PHASE4_CANARY_MESSAGE_ROWS = new Set([
  'be7c377e-05ef-4dd3-8ea3-9b54361dcd2e',
  'df29f70c-fcc7-4985-8f58-03f432acb520'
]);
const PHASE4_CANARY_EXPIRES_AT = Date.parse('2026-09-23T00:00:00Z');

function clean(value) {
  return String(value || '').trim();
}

function phase4CanaryEnabled() {
  const disabled = clean(process.env.READER_PHASE4_PRODUCTION_CANARY_DISABLED).toLowerCase();
  return disabled !== '1' && disabled !== 'true' && Date.now() < PHASE4_CANARY_EXPIRES_AT;
}

function safeFileName(value) {
  const name = clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return (name || 'telegram-media')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 160) || 'telegram-media';
}

function safeBytes(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function one(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function selectOne(path) {
  return one(await db(path));
}

async function selectMany(path) {
  const rows = await db(path);
  return Array.isArray(rows) ? rows : [];
}

function objectKeyFor(job, asset, sourceMessageId = '') {
  const fileName = safeFileName(asset?.original_filename || `telegram-${sourceMessageId || asset?.id || 'media'}`);
  return `media/v5/${job.course_id}/${asset.id}/${fileName}`;
}

function benchmarkPayload(job) {
  const payload = job?.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload) && payload.benchmark === true
    ? payload
    : null;
}

function benchmarkObjectKeyFor(job) {
  const payload = benchmarkPayload(job);
  if (!payload) return null;
  const key = clean(payload.benchmark_object_key);
  if (
    !key ||
    !key.startsWith(BENCHMARK_PREFIX) ||
    key === BENCHMARK_PREFIX ||
    key.includes('..') ||
    key.includes('\\')
  ) {
    throw new Error('v5_mirror_benchmark_object_key_denied');
  }
  return key;
}

async function loadOwnedMirrorJob(jobId, agentId) {
  const id = clean(jobId);
  const owner = clean(agentId);
  if (!id || !owner) throw new Error('v5_mirror_job_identity_required');
  const job = await selectOne(
    `v5_jobs?select=id,course_id,asset_id,status,locked_by,attempts,max_attempts,payload,result&id=eq.${encodeURIComponent(id)}&job_type=eq.telegram_mirror&status=eq.running&locked_by=eq.${encodeURIComponent(owner)}&limit=1`
  );
  if (!job) throw new Error('v5_mirror_job_not_owned');
  return job;
}

async function loadMirrorAsset(assetId) {
  const asset = await selectOne(
    `v5_media_assets?select=id,origin,telegram_source_id,telegram_message_row_id,mime_type,original_filename,bytes,status,metadata&id=eq.${encodeURIComponent(assetId)}&limit=1`
  );
  if (!asset) throw new Error('v5_mirror_asset_missing');
  if (asset.origin !== 'telegram') throw new Error('v5_mirror_asset_not_telegram');
  return asset;
}

function isProductionCanaryAsset(asset) {
  return Boolean(
    phase4CanaryEnabled() &&
    clean(asset?.telegram_source_id) === PHASE4_CANARY_SOURCE_ID &&
    PHASE4_CANARY_MESSAGE_ROWS.has(clean(asset?.telegram_message_row_id))
  );
}

async function isProductionCanaryJob(job) {
  if (
    !phase4CanaryEnabled() ||
    benchmarkPayload(job) ||
    clean(job?.course_id) !== PHASE4_CANARY_COURSE_ID ||
    !clean(job?.asset_id)
  ) {
    return false;
  }
  const asset = await loadMirrorAsset(job.asset_id);
  return isProductionCanaryAsset(asset);
}

function isPhotoOrThumbnail(asset) {
  return (
    Boolean(asset.mime_type?.startsWith('image/')) ||
    asset.metadata?.telegram?.variant === 'thumbnail' ||
    /\.(jpe?g|png|webp|gif)$/i.test(asset.original_filename || '')
  );
}

function validateReportedMirror({ job, asset, objectKey, bytes, expectedObjectKey }) {
  const reportedBytes = safeBytes(bytes);
  if (clean(objectKey) !== expectedObjectKey) throw new Error('v5_mirror_object_key_mismatch');
  if (reportedBytes === null || reportedBytes <= 0) throw new Error('v5_mirror_bytes_required');
  const expectedBytes = safeBytes(asset.bytes);
  if (!isPhotoOrThumbnail(asset) && expectedBytes !== null && expectedBytes > 0 && reportedBytes !== expectedBytes) {
    throw new Error(`v5_mirror_size_mismatch:${reportedBytes}/${expectedBytes}`);
  }
  return reportedBytes;
}

function validateReportedBenchmark({ asset, objectKey, bytes, expectedObjectKey }) {
  const reportedBytes = safeBytes(bytes);
  if (clean(objectKey) !== expectedObjectKey) throw new Error('v5_mirror_object_key_mismatch');
  if (reportedBytes === null || reportedBytes <= 0) throw new Error('v5_mirror_bytes_required');

  const expectedBytes = safeBytes(asset.bytes);
  if (expectedBytes !== null && expectedBytes > 0) {
    if (isPhotoOrThumbnail(asset)) {
      if (reportedBytes !== expectedBytes) {
        throw new Error(`v5_mirror_benchmark_size_mismatch:${reportedBytes}/${expectedBytes}`);
      }
    } else {
      const maxFaststartDrift = Math.max(1024 * 1024, Math.ceil(expectedBytes * 0.01));
      if (Math.abs(reportedBytes - expectedBytes) > maxFaststartDrift) {
        throw new Error(`v5_mirror_benchmark_size_drift_excessive:${reportedBytes}/${expectedBytes}`);
      }
    }
  }

  return { reportedBytes, expectedBytes };
}

async function finishBenchmarkJob({ job, ok, objectKey, bytes, etag, error, telemetry = null }) {
  const now = new Date();
  const nowIso = now.toISOString();
  const benchmarkObjectKey = benchmarkObjectKeyFor(job);
  let reportedBytes = safeBytes(bytes);
  let sourceExpectedBytes = null;

  if (ok === true) {
    const asset = await loadMirrorAsset(job.asset_id);
    const validated = validateReportedBenchmark({
      asset,
      objectKey,
      bytes,
      expectedObjectKey: benchmarkObjectKey
    });
    reportedBytes = validated.reportedBytes;
    sourceExpectedBytes = validated.expectedBytes;
  }

  const values = {
    locked_at: null,
    locked_by: null,
    updated_at: nowIso
  };

  if (ok === true) {
    values.status = 'success';
    values.progress_current = reportedBytes;
    values.progress_total = reportedBytes;
    const existingTelemetry = (job.result && typeof job.result === 'object' && job.result.telemetry)
      ? job.result.telemetry
      : null;
    const finalTelemetry = (telemetry && typeof telemetry === 'object')
      ? { ...(existingTelemetry || {}), ...telemetry }
      : existingTelemetry;
    values.result = {
      benchmark: true,
      object_key: benchmarkObjectKey,
      bytes: reportedBytes,
      source_expected_bytes: sourceExpectedBytes,
      etag: clean(etag) || null,
      ...(finalTelemetry ? { telemetry: finalTelemetry } : {})
    };
    values.last_error = null;
    values.finished_at = nowIso;
  } else if (Number(job.attempts || 0) >= Number(job.max_attempts || 0)) {
    values.status = 'failed';
    values.last_error = clean(error || 'telegram_mirror_benchmark_failed').slice(0, 2000);
    values.finished_at = nowIso;
  } else {
    const retrySeconds = Math.min(300, Math.max(30, Number(job.attempts || 0) * 30));
    values.status = 'queued';
    values.available_at = new Date(now.getTime() + retrySeconds * 1000).toISOString();
    values.last_error = clean(error || 'telegram_mirror_benchmark_failed').slice(0, 2000);
  }

  const rows = await db(
    `v5_jobs?id=eq.${encodeURIComponent(job.id)}&job_type=eq.telegram_mirror&status=eq.running&locked_by=eq.${encodeURIComponent(job.locked_by)}`,
    {
      method: 'PATCH',
      body: values,
      headers: { Prefer: 'return=representation' }
    }
  );
  return one(rows);
}

export function sanitizeTelemetry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const safeKeys = [
    'claim_ms', 'telegram_connect_ms', 'telegram_download_ms', 'telegram_bytes',
    'telegram_mbps', 'prepare_ms', 'faststart_ms', 'verify_ms', 'r2_upload_ms',
    'r2_bytes', 'r2_mbps', 'finish_ms', 'total_ms', 'total_worker_time_ms',
    'cache_reused', 'transform_version', 'upload_method', 'faststart_remuxed',
    'attempt', 'timings_ms'
  ];
  const out = {};
  for (const k of safeKeys) {
    if (raw[k] !== undefined && raw[k] !== null) {
      if (typeof raw[k] === 'number' || typeof raw[k] === 'boolean') {
        out[k] = raw[k];
      } else if (typeof raw[k] === 'string') {
        out[k] = raw[k].slice(0, 100);
      } else if (k === 'timings_ms' && typeof raw[k] === 'object' && !Array.isArray(raw[k])) {
        const timings = {};
        for (const [tk, tv] of Object.entries(raw[k])) {
          if (typeof tv === 'number') timings[tk.slice(0, 50)] = tv;
        }
        out.timings_ms = timings;
      }
    }
  }
  return out;
}

async function finishOwnedJob({ jobId, agentId, ok, objectKey = null, bytes = null, etag = null, error = null, telemetry = null }) {
  const job = await loadOwnedMirrorJob(jobId, agentId);

  if (benchmarkPayload(job)) {
    return finishBenchmarkJob({ job, ok, objectKey, bytes, etag, error, telemetry });
  }

  let finalObjectKey = null;
  let reportedBytes = safeBytes(bytes);
  if (ok === true) {
    const asset = await loadMirrorAsset(job.asset_id);
    finalObjectKey = objectKeyFor(job, asset);
    reportedBytes = validateReportedMirror({
      job,
      asset,
      objectKey,
      bytes,
      expectedObjectKey: finalObjectKey
    });
  }

  const rows = await db('rpc/finish_v5_telegram_mirror_job', {
    method: 'POST',
    body: {
      p_job_id: jobId,
      p_agent_id: agentId,
      p_ok: ok === true,
      p_object_key: finalObjectKey,
      p_bytes: reportedBytes,
      p_etag: clean(etag) || null,
      p_error: clean(error) || null
    }
  });
  const finished = one(rows);
  if (!finished) return null;

  if (telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry)) {
    const existingResult = finished.result && typeof finished.result === 'object' && !Array.isArray(finished.result)
      ? finished.result
      : {};
    const sanitizedTelemetry = sanitizeTelemetry(telemetry);
    const patchedResult = {
      ...existingResult,
      telemetry: {
        ...((existingResult.telemetry && typeof existingResult.telemetry === 'object') ? existingResult.telemetry : {}),
        ...sanitizedTelemetry
      }
    };
    const patched = await db(`v5_jobs?id=eq.${encodeURIComponent(job.id)}&job_type=eq.telegram_mirror`, {
      method: 'PATCH',
      body: { result: patchedResult, updated_at: new Date().toISOString() },
      headers: { Prefer: 'return=representation' }
    }).catch(() => {});
    return one(patched) || { ...finished, result: patchedResult };
  }

  return finished;
}

async function requeueClaimedMirrorJob(claimed, owner) {
  await db(`v5_jobs?id=eq.${encodeURIComponent(claimed.id)}&status=eq.running&locked_by=eq.${encodeURIComponent(owner)}`, {
    method: 'PATCH',
    body: {
      status: 'queued',
      locked_at: null,
      locked_by: null,
      attempts: Math.max(0, Number(claimed.attempts || 1) - 1),
      updated_at: new Date().toISOString()
    }
  }).catch(() => {});
}

export async function claimV5MirrorJob(agentId) {
  const owner = clean(agentId);
  if (!owner) throw new Error('agent_id_required');

  // Concurrency guard: check currently running mirror jobs for this agent.
  // Benchmark jobs and the exact Phase 4 production canary pair may run at 2.
  const runningJobs = await selectMany(
    `v5_jobs?select=id,course_id,asset_id,payload&job_type=eq.telegram_mirror&status=eq.running&locked_by=eq.${encodeURIComponent(owner)}`
  );

  if (runningJobs && runningJobs.length >= 2) {
    return null;
  }

  let runningCanary = false;
  if (runningJobs && runningJobs.length === 1) {
    const isRunningBenchmark = Boolean(benchmarkPayload(runningJobs[0]));
    if (!isRunningBenchmark) {
      runningCanary = await isProductionCanaryJob(runningJobs[0]);
      if (!runningCanary) {
        // Normal production job is running: production concurrency remains strictly 1.
        return null;
      }
    }
  }

  const claimed = one(await db('rpc/claim_v5_telegram_mirror_job', {
    method: 'POST',
    body: { p_agent_id: owner }
  }));
  if (!claimed) return null;

  // When one job is already active, only another job in the SAME approved
  // concurrency class may run. Benchmark/canary mixing is denied.
  if (runningJobs && runningJobs.length === 1) {
    const isRunningBenchmark = Boolean(benchmarkPayload(runningJobs[0]));
    const isClaimedBenchmark = Boolean(benchmarkPayload(claimed));
    if (!isClaimedBenchmark) {
      const isClaimedCanary = runningCanary && await isProductionCanaryJob(claimed);
      if (!isClaimedCanary) {
        await requeueClaimedMirrorJob(claimed, owner);
        return null;
      }
    } else if (!isRunningBenchmark || runningCanary) {
      await requeueClaimedMirrorJob(claimed, owner);
      return null;
    }
  }

  try {
    const asset = await loadMirrorAsset(claimed.asset_id);
    if (!asset.telegram_source_id || !asset.telegram_message_row_id) throw new Error('v5_mirror_asset_source_missing');

    const message = await selectOne(`tgcloner_source_messages?select=id,source_id,source_message_id,message_type,raw_message&id=eq.${encodeURIComponent(asset.telegram_message_row_id)}&source_id=eq.${encodeURIComponent(asset.telegram_source_id)}&limit=1`);
    if (!message) throw new Error('v5_mirror_message_missing');

    const source = await selectOne(`tgcloner_sources?select=id,chat_id,title,username&id=eq.${encodeURIComponent(asset.telegram_source_id)}&limit=1`);
    if (!source) throw new Error('v5_mirror_source_missing');

    const fileName = safeFileName(asset.original_filename || `telegram-${message.source_message_id}`);
    const telegramMetadata = asset.metadata?.telegram && typeof asset.metadata.telegram === 'object' ? asset.metadata.telegram : {};
    const mediaVariant = telegramMetadata.variant === 'thumbnail' ? 'thumbnail' : 'media';
    const benchmarkObjectKey = benchmarkObjectKeyFor(claimed);
    const productionCanary = !benchmarkObjectKey &&
      clean(claimed.course_id) === PHASE4_CANARY_COURSE_ID &&
      isProductionCanaryAsset(asset);
    const objectKey = benchmarkObjectKey || objectKeyFor(claimed, { ...asset, original_filename: fileName }, message.source_message_id);
    const channelRef = clean(source.username) ? `@${clean(source.username).replace(/^@/, '')}` : clean(source.chat_id);
    if (!channelRef) throw new Error('v5_mirror_channel_ref_missing');

    return {
      id: claimed.id,
      job_type: 'v5_mirror',
      course_id: claimed.course_id,
      asset_id: asset.id,
      source_id: source.id,
      channel_ref: channelRef,
      source_message_id: Number(message.source_message_id),
      message_type: message.message_type,
      media_variant: mediaVariant,
      object_key: objectKey,
      original_filename: fileName,
      mime_type: asset.mime_type || 'application/octet-stream',
      expected_bytes: safeBytes(asset.bytes),
      attempt: Number(claimed.attempts || 0),
      max_attempts: Number(claimed.max_attempts || 0),
      // Reader 1.4.0 already has a proven two-worker path gated by this boolean.
      // For the exact server-authorized production canary pair only, reuse that
      // local scheduling path while keeping DB payload/finish semantics production.
      benchmark: Boolean(benchmarkObjectKey) || productionCanary,
      production_canary: productionCanary
    };
  } catch (error) {
    await finishOwnedJob({ jobId: claimed.id, agentId: owner, ok: false, error: error?.message || String(error) }).catch(() => {});
    throw error;
  }
}

export async function heartbeatV5MirrorJob({
  jobId,
  agentId,
  progressCurrent = null,
  progressTotal = null,
  progressStage = null,
  bytesPerSecond = null,
  etaSeconds = null
}) {
  const id = clean(jobId);
  const owner = clean(agentId);
  if (!id || !owner) return null;

  const stage = clean(progressStage) || null;
  const bps = safeBytes(bytesPerSecond);
  const eta = safeBytes(etaSeconds);
  const current = safeBytes(progressCurrent);
  const total = safeBytes(progressTotal);

  const values = {
    locked_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (current !== null) values.progress_current = current;
  if (total !== null) values.progress_total = total;

  if (stage || bps !== null || eta !== null) {
    const job = await selectOne(
      `v5_jobs?select=id,course_id,asset_id,payload,result&id=eq.${encodeURIComponent(id)}&job_type=eq.telegram_mirror&status=eq.running&locked_by=eq.${encodeURIComponent(owner)}&limit=1`
    );
    const persistTelemetry = job && (benchmarkPayload(job) || await isProductionCanaryJob(job));
    if (persistTelemetry) {
      const nowIso = values.updated_at;
      const mbPerSec = bps !== null ? Number((bps / 1048576).toFixed(3)) : null;
      const prevResult = (job.result && typeof job.result === 'object' && !Array.isArray(job.result)) ? job.result : {};
      const prevTelemetry = (prevResult.telemetry && typeof prevResult.telemetry === 'object') ? prevResult.telemetry : {};
      const samples = Array.isArray(prevTelemetry.samples) ? [...prevTelemetry.samples] : [];
      if (samples.length < 100) {
        samples.push({
          at: nowIso,
          stage,
          bytes_per_second: bps,
          mb_per_second: mbPerSec,
          eta_seconds: eta,
          current,
          total
        });
      }
      const stages = (prevTelemetry.stages && typeof prevTelemetry.stages === 'object') ? { ...prevTelemetry.stages } : {};
      if (stage) {
        if (!stages[stage]) {
          stages[stage] = { first_seen_at: nowIso, last_seen_at: nowIso, count: 1 };
        } else {
          stages[stage] = {
            ...stages[stage],
            last_seen_at: nowIso,
            count: (stages[stage].count || 1) + 1
          };
        }
      }
      values.result = {
        ...prevResult,
        ...(benchmarkPayload(job) ? {} : { production_canary: true }),
        telemetry: {
          ...prevTelemetry,
          last_heartbeat_at: nowIso,
          progress_stage: stage || prevTelemetry.progress_stage || null,
          bytes_per_second: bps !== null ? bps : prevTelemetry.bytes_per_second ?? null,
          mb_per_second: mbPerSec !== null ? mbPerSec : prevTelemetry.mb_per_second ?? null,
          eta_seconds: eta !== null ? eta : prevTelemetry.eta_seconds ?? null,
          progress_current: current !== null ? current : prevTelemetry.progress_current ?? null,
          progress_total: total !== null ? total : prevTelemetry.progress_total ?? null,
          samples,
          stages
        }
      };
    }
  }

  const rows = await db(`v5_jobs?id=eq.${encodeURIComponent(id)}&job_type=eq.telegram_mirror&status=eq.running&locked_by=eq.${encodeURIComponent(owner)}`, {
    method: 'PATCH',
    body: values,
    headers: { Prefer: 'return=representation' }
  });
  return one(rows);
}

export async function finishV5MirrorJob({ jobId, agentId, ok, objectKey, bytes, etag, error, telemetry = null }) {
  return finishOwnedJob({ jobId, agentId, ok, objectKey, bytes, etag, error, telemetry });
}
