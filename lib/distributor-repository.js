import { rpc } from './supabase.js';

export const DISTRIBUTOR_RPCS = Object.freeze({
  progress: 'tgcloner_distributor_progress',
  createRun: 'tgcloner_distributor_create_run',
  closeManifest: 'tgcloner_distributor_close_manifest',
  recordEvent: 'tgcloner_distributor_record_event',
  claimWork: 'tgcloner_distributor_claim_work',
  armWork: 'tgcloner_distributor_arm_work',
  finishWork: 'tgcloner_distributor_finish_work',
  finishCopy: 'tgcloner_distributor_finish_copy',
  finishEdit: 'tgcloner_distributor_finish_edit',
  prepareCatchup: 'tgcloner_distributor_prepare_catchup',
  promoteLinkDependencies: 'tgcloner_distributor_promote_link_dependencies',
  prepareFidelity: 'tgcloner_distributor_prepare_fidelity',
  blockDependency: 'tgcloner_distributor_block_dependency',
  finishRewrite: 'tgcloner_distributor_finish_rewrite',
  finishPin: 'tgcloner_distributor_finish_pin',
  prepareVerification: 'tgcloner_distributor_prepare_verification',
  finishVerify: 'tgcloner_distributor_finish_verify',
  setRunControl: 'tgcloner_distributor_set_run_control',
  resolveAmbiguousCopy: 'tgcloner_distributor_resolve_ambiguous_copy'
});

export async function getDistributorProgress({ limit = 50 } = {}) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.progress, { p_limit: limit }));
}

export function oneRpcRow(value) {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

export async function createDistributorRun({ sourceId, destinationId, mode = 'initial_backfill' }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.createRun, {
    p_source_id: sourceId,
    p_destination_id: destinationId,
    p_mode: mode
  }));
}

export async function closeDistributorManifest({ runId, highWatermark, expectedMessageIds }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.closeManifest, {
    p_run_id: runId,
    p_high_watermark: highWatermark,
    p_expected_message_ids: Array.isArray(expectedMessageIds) ? expectedMessageIds : []
  }));
}

export async function recordDistributorEvent({ eventKey, sourceId, telegramUpdateId = null, origin, eventKind, sourceMessageId = null, sourceFingerprint = null, payload = {}, observedAt = null }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.recordEvent, {
    p_event_key: eventKey,
    p_source_id: sourceId,
    p_telegram_update_id: telegramUpdateId,
    p_origin: origin,
    p_event_kind: eventKind,
    p_source_message_id: sourceMessageId,
    p_source_fingerprint: sourceFingerprint,
    p_payload: payload ?? {},
    p_observed_at: observedAt
  }));
}

export async function claimDistributorWork({ workerId, limit = 1, leaseSeconds = 120 }) {
  const rows = await rpc(DISTRIBUTOR_RPCS.claimWork, { p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds });
  return Array.isArray(rows) ? rows : rows ? [rows] : [];
}

export async function armDistributorWork({ workId, workerId, leaseGeneration }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.armWork, { p_work_id: workId, p_worker_id: workerId, p_lease_generation: leaseGeneration }));
}

export async function finishDistributorWork({ workId, workerId, leaseGeneration, outcome, retryable = false, retryAfterSeconds = 30, errorCode = null, error = null, result = {} }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.finishWork, {
    p_work_id: workId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration,
    p_outcome: outcome,
    p_retryable: retryable,
    p_retry_after_seconds: retryAfterSeconds,
    p_error_code: errorCode,
    p_error: error,
    p_result: result ?? {}
  }));
}

export async function finishDistributorCopy({ workId, workerId, leaseGeneration, destinationMessageIds, result = {} }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.finishCopy, {
    p_work_id: workId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration,
    p_destination_message_ids: Array.isArray(destinationMessageIds) ? destinationMessageIds : [],
    p_result: result ?? {}
  }));
}

export async function finishDistributorEdit({ workId, workerId, leaseGeneration, result = {} }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.finishEdit, {
    p_work_id: workId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration,
    p_result: result ?? {}
  }));
}

export async function prepareDistributorCatchup({ runId, albumSettleSeconds = 5, quietSeconds = 2 }) {
  const args = { p_run_id: runId, p_album_settle_seconds: albumSettleSeconds, p_quiet_seconds: quietSeconds };
  let run = oneRpcRow(await rpc(DISTRIBUTOR_RPCS.prepareCatchup, args));
  await rpc(DISTRIBUTOR_RPCS.promoteLinkDependencies, { p_run_id: runId });
  run = oneRpcRow(await rpc(DISTRIBUTOR_RPCS.prepareCatchup, args));
  return run;
}

export async function prepareDistributorFidelity({ runId, pinnedSourceMessageId = null }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.prepareFidelity, {
    p_run_id: runId,
    p_pinned_source_message_id: pinnedSourceMessageId
  }));
}

export async function blockDistributorDependency({ workId, workerId, leaseGeneration, errorCode, error, result = {} }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.blockDependency, {
    p_work_id: workId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration,
    p_error_code: errorCode,
    p_error: error,
    p_result: result ?? {}
  }));
}

export async function finishDistributorRewrite({ workId, workerId, leaseGeneration, result = {} }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.finishRewrite, {
    p_work_id: workId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration,
    p_result: result ?? {}
  }));
}

export async function finishDistributorPin({ workId, workerId, leaseGeneration, result = {} }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.finishPin, {
    p_work_id: workId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration,
    p_result: result ?? {}
  }));
}

export async function prepareDistributorVerification({ runId }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.prepareVerification, { p_run_id: runId }));
}

export async function finishDistributorVerify({ workId, workerId, leaseGeneration, actualPinnedDestinationMessageId = null, summary = {} }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.finishVerify, {
    p_work_id: workId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration,
    p_actual_pinned_destination_message_id: actualPinnedDestinationMessageId,
    p_summary: summary ?? {}
  }));
}

export async function setDistributorRunControl({ runId, action }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.setRunControl, { p_run_id: runId, p_action: action }));
}

export async function resolveAmbiguousDistributorCopy({ workId, resolution, destinationMessageIds = null }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.resolveAmbiguousCopy, {
    p_work_id: workId,
    p_resolution: resolution,
    p_destination_message_ids: Array.isArray(destinationMessageIds) ? destinationMessageIds : null
  }));
}
