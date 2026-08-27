import { db } from './supabase.js';

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

async function loadOwnedMirrorContext(jobId, agentId) {
  const id = clean(jobId);
  const owner = clean(agentId);
  if (!id || !owner) throw new Error('v5_mirror_job_identity_required');
  const job = await selectOne(`v5_jobs?select=id,course_id,asset_id,status,locked_by,attempts,max_attempts&id=eq.${encodeURIComponent(id)}&job_type=eq.telegram_mirror&status=eq.running&locked_by=eq.${encodeURIComponent(owner)}&limit=1`);
  if (!job) throw new Error('v5_mirror_job_not_owned');
  const asset = await selectOne(`v5_media_assets?select=id,origin,telegram_source_id,telegram_message_row_id,original_filename,bytes,status&id=eq.${encodeURIComponent(job.asset_id)}&limit=1`);
  if (!asset) throw new Error('v5_mirror_asset_missing');
  if (asset.origin !== 'telegram') throw new Error('v5_mirror_asset_not_telegram');
  return { job, asset };
}

async function finishOwnedJob({ jobId, agentId, ok, objectKey = null, bytes = null, etag = null, error = null }) {
  let finalObjectKey = null;
  if (ok === true) {
    const { job, asset } = await loadOwnedMirrorContext(jobId, agentId);
    finalObjectKey = objectKeyFor(job, asset);
    if (clean(objectKey) !== finalObjectKey) throw new Error('v5_mirror_object_key_mismatch');
  }
  const rows = await db('rpc/finish_v5_telegram_mirror_job', {
    method: 'POST',
    body: {
      p_job_id: jobId,
      p_agent_id: agentId,
      p_ok: ok === true,
      p_object_key: finalObjectKey,
      p_bytes: safeBytes(bytes),
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
    const asset = await selectOne(`v5_media_assets?select=id,type,provider,origin,telegram_source_id,telegram_message_row_id,mime_type,original_filename,bytes,status,metadata&id=eq.${encodeURIComponent(claimed.asset_id)}&limit=1`);
    if (!asset) throw new Error('v5_mirror_asset_missing');
    if (asset.origin !== 'telegram') throw new Error('v5_mirror_asset_not_telegram');
    if (!asset.telegram_source_id || !asset.telegram_message_row_id) throw new Error('v5_mirror_asset_source_missing');

    const message = await selectOne(`tgcloner_source_messages?select=id,source_id,source_message_id,message_type,raw_message&id=eq.${encodeURIComponent(asset.telegram_message_row_id)}&source_id=eq.${encodeURIComponent(asset.telegram_source_id)}&limit=1`);
    if (!message) throw new Error('v5_mirror_message_missing');

    const source = await selectOne(`tgcloner_sources?select=id,chat_id,title,username&id=eq.${encodeURIComponent(asset.telegram_source_id)}&limit=1`);
    if (!source) throw new Error('v5_mirror_source_missing');

    const fileName = safeFileName(asset.original_filename || `telegram-${message.source_message_id}`);
    const objectKey = objectKeyFor(claimed, { ...asset, original_filename: fileName }, message.source_message_id);
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
      object_key: objectKey,
      original_filename: fileName,
      mime_type: asset.mime_type || 'application/octet-stream',
      expected_bytes: safeBytes(asset.bytes),
      attempt: Number(claimed.attempts || 0),
      max_attempts: Number(claimed.max_attempts || 0)
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
