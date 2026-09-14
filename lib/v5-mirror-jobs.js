import { db } from './supabase.js';

const BENCHMARK_PREFIX = 'benchmarks/reader-phase1/20260914/message-13/';

function clean(value) {
  return String(value || '').trim();
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
    `v5_jobs?select=id,course_id,asset_id,status,locked_by,attempts,max_attempts,payload&id=eq.${encodeURIComponent(id)}&job_type=eq.telegram_mirror&status=eq.running&locked_by=eq.${encodeURIComponent(owner)}&limit=1`
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

async function finishBenchmarkJob({ job, ok, objectKey, bytes, etag, error }) {
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
    values.result = {
      benchmark: true,
      object_key: benchmarkObjectKey,
      bytes: reportedBytes,
      source_expected_bytes: sourceExpectedBytes,
      etag: clean(etag) || null
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

async function finishOwnedJob({ jobId, agentId, ok, objectKey = null, bytes = null, etag = null, error = null }) {
  const job = await loadOwnedMirrorJob(jobId, agentId);

  if (benchmarkPayload(job)) {
    return finishBenchmarkJob({ job, ok, objectKey, bytes, etag, error });
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
  return one(rows);
}

export async function claimV5MirrorJob(agentId) {
  const owner = clean(agentId);
  if (!owner) throw new Error('agent_id_required');
  const claimed = one(await db('rpc/claim_v5_telegram_mirror_job', {
    method: 'POST',
    body: { p_agent_id: owner }
  }));
  if (!claimed) return null;

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
      benchmark: Boolean(benchmarkObjectKey)
    };
  } catch (error) {
    await finishOwnedJob({ jobId: claimed.id, agentId: owner, ok: false, error: error?.message || String(error) }).catch(() => {});
    throw error;
  }
}

export async function heartbeatV5MirrorJob({ jobId, agentId, progressCurrent = null, progressTotal = null }) {
  const id = clean(jobId);
  const owner = clean(agentId);
  if (!id || !owner) return null;
  const values = {
    locked_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const current = safeBytes(progressCurrent);
  const total = safeBytes(progressTotal);
  if (current !== null) values.progress_current = current;
  if (total !== null) values.progress_total = total;
  const rows = await db(`v5_jobs?id=eq.${encodeURIComponent(id)}&job_type=eq.telegram_mirror&status=eq.running&locked_by=eq.${encodeURIComponent(owner)}`, {
    method: 'PATCH',
    body: values,
    headers: { Prefer: 'return=representation' }
  });
  return one(rows);
}

export async function finishV5MirrorJob({ jobId, agentId, ok, objectKey, bytes, etag, error }) {
  return finishOwnedJob({ jobId, agentId, ok, objectKey, bytes, etag, error });
}
