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

function one(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function selectOne(path) {
  return one(await db(path));
}

async function finishOwnedJob({ jobId, agentId, ok, objectKey = null, bytes = null, etag = null, error = null }) {
  const rows = await db('rpc/finish_v5_telegram_mirror_job', {
    method: 'POST',
    body: {
      p_job_id: jobId,
      p_agent_id: agentId,
      p_ok: ok === true,
      p_object_key: objectKey,
      p_bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
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
    const objectKey = `media/v5/${claimed.course_id}/${asset.id}/${fileName}`;
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
      expected_bytes: Number(asset.bytes || 0),
      attempt: Number(claimed.attempts || 0),
      max_attempts: Number(claimed.max_attempts || 0)
    };
  } catch (error) {
    await finishOwnedJob({ jobId: claimed.id, agentId: owner, ok: false, error: error?.message || String(error) }).catch(() => {});
    throw error;
  }
}

export async function heartbeatV5MirrorJob({ jobId, agentId, progressCurrent = null, progressTotal = null, progressStage = null }) {
  const id = clean(jobId);
  const owner = clean(agentId);
  if (!id || !owner) return null;
  const values = {
    locked_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (Number.isSafeInteger(progressCurrent) && progressCurrent >= 0) values.progress_current = progressCurrent;
  if (Number.isSafeInteger(progressTotal) && progressTotal >= 0) values.progress_total = progressTotal;
  if (clean(progressStage)) values.payload = { progress_stage: clean(progressStage) };
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
