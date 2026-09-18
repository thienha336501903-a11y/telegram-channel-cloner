import { db } from './supabase.js';
import { finishV5MirrorJob, oneRpcRow, safeProgress } from './v5-mirror-jobs.js';

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

function safeBytes(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function one(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
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

function objectKeyFor(job, asset) {
  const fileName = safeFileName(asset?.original_filename || `telegram-${asset?.id || 'media'}`);
  return `media/v5/${job.course_id}/${asset.id}/${fileName}`;
}

function isPhotoOrThumbnail(asset) {
  return (
    Boolean(asset?.mime_type?.startsWith('image/')) ||
    asset?.metadata?.telegram?.variant === 'thumbnail' ||
    /\.(jpe?g|png|webp|gif)$/i.test(asset?.original_filename || '')
  );
}

function isBenchmarkJob(job) {
  const payload = job?.payload;
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload) && payload.benchmark === true);
}

async function selectOne(path) {
  return one(await db(path));
}

async function loadPhase4CanaryContext(jobId, agentId) {
  if (!phase4CanaryEnabled()) return null;
  const id = clean(jobId);
  const owner = clean(agentId);
  if (!id || !owner) return null;

  const job = await selectOne(
    `v5_jobs?select=id,course_id,asset_id,status,locked_by,attempts,max_attempts,payload,result&id=eq.${encodeURIComponent(id)}&job_type=eq.telegram_mirror&status=eq.running&locked_by=eq.${encodeURIComponent(owner)}&limit=1`
  );
  if (!job || isBenchmarkJob(job) || clean(job.course_id) !== PHASE4_CANARY_COURSE_ID || !clean(job.asset_id)) return null;

  const asset = await selectOne(
    `v5_media_assets?select=id,origin,telegram_source_id,telegram_message_row_id,mime_type,original_filename,bytes,status,metadata&id=eq.${encodeURIComponent(job.asset_id)}&limit=1`
  );
  if (!asset || asset.origin !== 'telegram') return null;
  if (clean(asset.telegram_source_id) !== PHASE4_CANARY_SOURCE_ID) return null;
  if (!PHASE4_CANARY_MESSAGE_ROWS.has(clean(asset.telegram_message_row_id))) return null;
  return { job, asset };
}

function validatePhase4ReportedMirror({ job, asset, objectKey, bytes }) {
  const expectedObjectKey = objectKeyFor(job, asset);
  const reportedBytes = safeBytes(bytes);
  if (clean(objectKey) !== expectedObjectKey) throw new Error('v5_mirror_object_key_mismatch');
  if (reportedBytes === null || reportedBytes <= 0) throw new Error('v5_mirror_bytes_required');

  const expectedBytes = safeBytes(asset.bytes);
  if (!isPhotoOrThumbnail(asset) && expectedBytes !== null && expectedBytes > 0) {
    const maxFaststartDrift = Math.max(1024 * 1024, Math.ceil(expectedBytes * 0.01));
    if (Math.abs(reportedBytes - expectedBytes) > maxFaststartDrift) {
      throw new Error(`v5_mirror_phase4_size_drift_excessive:${reportedBytes}/${expectedBytes}`);
    }
  }

  return { expectedObjectKey, reportedBytes, expectedBytes };
}

export async function finishPhase4CanaryMirrorJob({
  jobId,
  agentId,
  ok,
  objectKey = null,
  bytes = null,
  finalBytes = null,
  sourceBytes = null,
  transformVersion = null,
  checksumSha256 = null,
  attempt = null,
  etag = null,
  error = null,
  telemetry = null
}) {
  const context = await loadPhase4CanaryContext(jobId, agentId);
  if (!context || ok !== true) {
    return finishV5MirrorJob({
      jobId,
      agentId,
      ok,
      objectKey,
      bytes,
      finalBytes,
      sourceBytes,
      transformVersion,
      checksumSha256,
      attempt,
      etag,
      error,
      telemetry
    });
  }

  const { job, asset } = context;
  const parsedAttempt = safeProgress(attempt);
  if (parsedAttempt === null || parsedAttempt === undefined || parsedAttempt < 1) {
    throw new Error('v5_mirror_attempt_required');
  }

  if (job.attempts !== null && job.attempts !== undefined) {
    if (Number(parsedAttempt) !== Number(job.attempts)) {
      throw new Error(`v5_mirror_lease_fenced:expected_attempt_${job.attempts}_got_${parsedAttempt}`);
    }
  }

  const validated = validatePhase4ReportedMirror({ job, asset, objectKey, bytes: finalBytes || bytes });
  const rpcBody = {
    p_job_id: jobId,
    p_agent_id: agentId,
    p_ok: true,
    p_object_key: validated.expectedObjectKey,
    p_bytes: validated.reportedBytes,
    p_etag: clean(etag) || null,
    p_error: null,
    p_attempt: Number(parsedAttempt)
  };

  const rows = await db('rpc/finish_v5_telegram_mirror_job', {
    method: 'POST',
    body: rpcBody
  });
  const finished = oneRpcRow(rows);
  if (!finished) return null;

  const existingResult = finished.result && typeof finished.result === 'object' && !Array.isArray(finished.result)
    ? finished.result
    : {};
  const heartbeatTelemetry = job.result && typeof job.result === 'object' && !Array.isArray(job.result) && job.result.telemetry && typeof job.result.telemetry === 'object'
    ? job.result.telemetry
    : null;
  const finalTelemetry = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry)
    ? { ...(heartbeatTelemetry || {}), ...telemetry }
    : heartbeatTelemetry;

  const result = {
    ...existingResult,
    production_canary: true,
    source_expected_bytes: validated.expectedBytes,
    source_bytes: safeBytes(sourceBytes) ?? validated.expectedBytes,
    final_bytes: validated.reportedBytes,
    transform_version: clean(transformVersion) || 'ffmpeg-faststart-v1',
    checksum_sha256: clean(checksumSha256) || null,
    faststart_drift_bytes: validated.expectedBytes === null ? null : validated.reportedBytes - validated.expectedBytes,
    ...(finalTelemetry ? { telemetry: finalTelemetry } : {})
  };

  let jobPatchError = null;
  const patched = await db(`v5_jobs?id=eq.${encodeURIComponent(job.id)}&job_type=eq.telegram_mirror&status=eq.success`, {
    method: 'PATCH',
    body: { result, updated_at: new Date().toISOString() },
    headers: { Prefer: 'return=representation' }
  }).catch((err) => {
    jobPatchError = err;
    console.error(JSON.stringify({
      level: 'error',
      event: 'v5_phase4_canary_job_result_enrichment_failed',
      job_id: job.id,
      error: String(err?.message || err)
    }));
    return null;
  });

  let assetPatchError = null;
  if (job.asset_id) {
    const assetPatch = {
      bytes: validated.reportedBytes,
      updated_at: new Date().toISOString()
    };
    if (clean(checksumSha256)) {
      assetPatch.checksum_sha256 = clean(checksumSha256);
    }
    await db(`v5_media_assets?id=eq.${encodeURIComponent(job.asset_id)}`, {
      method: 'PATCH',
      body: assetPatch
    }).catch((err) => {
      assetPatchError = err;
      console.error(JSON.stringify({
        level: 'error',
        event: 'v5_phase4_canary_asset_enrichment_failed',
        job_id: job.id,
        asset_id: job.asset_id,
        error: String(err?.message || err)
      }));
      return null;
    });
  }

  const finishedJob = one(patched) || { ...finished, result };
  if (jobPatchError || assetPatchError) {
    finishedJob.metadata_enrichment_incomplete = true;
    finishedJob.enrichment_error = 'finish_committed_metadata_incomplete';
  }
  return finishedJob;
}
