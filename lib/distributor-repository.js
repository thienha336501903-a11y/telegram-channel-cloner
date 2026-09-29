import { rpc } from './supabase.js';

export const DISTRIBUTOR_RPCS = Object.freeze({
  createRun: 'tgcloner_distributor_create_run',
  closeManifest: 'tgcloner_distributor_close_manifest',
  recordEvent: 'tgcloner_distributor_record_event',
  claimWork: 'tgcloner_distributor_claim_work',
  armWork: 'tgcloner_distributor_arm_work',
  finishWork: 'tgcloner_distributor_finish_work'
});

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

export async function recordDistributorEvent({
  eventKey,
  sourceId,
  telegramUpdateId = null,
  origin,
  eventKind,
  sourceMessageId = null,
  sourceFingerprint = null,
  payload = {},
  observedAt = null
}) {
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
  const rows = await rpc(DISTRIBUTOR_RPCS.claimWork, {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds
  });
  return Array.isArray(rows) ? rows : rows ? [rows] : [];
}

export async function armDistributorWork({ workId, workerId, leaseGeneration }) {
  return oneRpcRow(await rpc(DISTRIBUTOR_RPCS.armWork, {
    p_work_id: workId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration
  }));
}

export async function finishDistributorWork({
  workId,
  workerId,
  leaseGeneration,
  outcome,
  retryable = false,
  retryAfterSeconds = 30,
  errorCode = null,
  error = null,
  result = {}
}) {
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
