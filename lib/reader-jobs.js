import { insert, patch, select } from './supabase.js';
import { TABLES } from './tables.js';
import { chooseReaderProfile, touchReaderAssignment } from './reader-manager.js';
import { chooseReaderProfileForSource } from './reader-source-routing.js';

const STALE_PROCESSING_MS = 10 * 60 * 1000;
const RECONCILE_CAPABILITY = 'reconcile_v1';
const CLAIM_CANDIDATE_LIMIT = 50;
const PROGRESS_STAGES = new Set([
  'claimed',
  'verifying_source',
  'reading_history',
  'processing_media',
  'reconciling',
  'completed',
  'failed'
]);

function cleanAgentId(value) {
  return String(value || '').trim().slice(0, 160);
}

function channelRefForSource(source) {
  if (source?.username) return `@${String(source.username).replace(/^@/, '')}`;
  return String(source?.chat_id || '').trim();
}

function normalizeJobType(value) {
  return value === 'reconcile' ? 'reconcile' : 'import';
}

function supportsReconcile(capabilities) {
  return Array.isArray(capabilities) && capabilities.map(String).includes(RECONCILE_CAPABILITY);
}

async function profileForQueuedJob(source, type, readerProfileId) {
  const requested = String(readerProfileId || '').trim();
  if (requested) return chooseReaderProfile(requested);
  if (type === 'reconcile') return chooseReaderProfileForSource(source.id);
  return chooseReaderProfile('auto');
}

export async function queueReaderJob(source, { jobType = 'import', readerProfileId = '' } = {}) {
  if (!source?.id) throw new Error('reader_source_required');
  const type = normalizeJobType(jobType);
  const managedRequested = Boolean(readerProfileId);
  const profile = await profileForQueuedJob(source, type, readerProfileId);
  if (managedRequested && !profile) throw Object.assign(new Error('reader_profile_unavailable'), { status: 409 });
  const active = await select(
    TABLES.readerJobs,
    `select=*&source_id=eq.${encodeURIComponent(source.id)}&status=in.(queued,processing)&order=created_at.desc&limit=1`
  );
  if (active?.[0]) {
    const existing = active[0];
    if (profile?.id && existing.status === 'queued' && !existing.assigned_reader_profile_id) {
      const assigned = await patch(
        TABLES.readerJobs,
        `id=eq.${encodeURIComponent(existing.id)}&status=eq.queued&assigned_reader_profile_id=is.null`,
        { assigned_reader_profile_id: profile.id, updated_at: new Date().toISOString() }
      );
      if (assigned?.[0]) {
        await touchReaderAssignment(profile.id);
        return { job: assigned[0], created: false };
      }
    }
    if (managedRequested && profile?.id && existing.assigned_reader_profile_id && existing.assigned_reader_profile_id !== profile.id) {
      throw Object.assign(new Error('reader_job_already_assigned'), { status: 409 });
    }
    return { job: existing, created: false };
  }

  const channelRef = channelRefForSource(source);
  if (!channelRef) throw new Error('reader_source_channel_missing');

  try {
    const rows = await insert(TABLES.readerJobs, {
      source_id: source.id,
      channel_ref: channelRef,
      job_type: type,
      assigned_reader_profile_id: profile?.id || null,
      status: 'queued',
      requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    if (profile?.id) await touchReaderAssignment(profile.id);
    return { job: rows[0], created: true };
  } catch (error) {
    const retry = await select(
      TABLES.readerJobs,
      `select=*&source_id=eq.${encodeURIComponent(source.id)}&status=in.(queued,processing)&order=created_at.desc&limit=1`
    );
    if (retry?.[0]) return { job: retry[0], created: false };
    throw error;
  }
}

export async function listRecentReaderJobs(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  return select(TABLES.readerJobs, `select=*&order=created_at.desc&limit=${safeLimit}`);
}

async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  const stale = await select(
    TABLES.readerJobs,
    `select=id,status,heartbeat_at,claimed_at&status=eq.processing&or=(heartbeat_at.lt.${encodeURIComponent(cutoff)},and(heartbeat_at.is.null,claimed_at.lt.${encodeURIComponent(cutoff)}))&limit=20`
  );
  for (const job of stale || []) {
    await patch(
      TABLES.readerJobs,
      `id=eq.${encodeURIComponent(job.id)}&status=eq.processing`,
      {
        status: 'queued',
        claimed_at: null,
        claimed_by: null,
        heartbeat_at: null,
        updated_at: new Date().toISOString(),
        last_error: 'reader_agent_stale_requeued'
      },
      { returning: false }
    );
  }
}

async function claimFirstQueued(agent, { canReconcile = false, managed = false, profileIds = [] } = {}) {
  if (managed && !profileIds.length) return null;
  const typeFilter = canReconcile ? '' : '&job_type=eq.import';
  const assignmentFilter = managed
    ? `&or=(assigned_reader_profile_id.is.null,assigned_reader_profile_id.in.(${profileIds.map(encodeURIComponent).join(',')}))`
    : '&assigned_reader_profile_id=is.null';
  const candidates = await select(
    TABLES.readerJobs,
    `select=*&status=eq.queued${typeFilter}${assignmentFilter}&order=requested_at.asc&limit=${CLAIM_CANDIDATE_LIMIT}`
  );
  for (const candidate of candidates || []) {
    const now = new Date().toISOString();
    let claimedProfileId = candidate.assigned_reader_profile_id || null;

    if (managed && !claimedProfileId) {
      if (candidate.job_type === 'reconcile') {
        const routed = await chooseReaderProfileForSource(candidate.source_id, { allowedProfileIds: profileIds });
        if (!routed?.id) continue;
        claimedProfileId = routed.id;
      } else {
        claimedProfileId = profileIds[0] || null;
      }
    }

    const updated = await patch(
      TABLES.readerJobs,
      `id=eq.${encodeURIComponent(candidate.id)}&status=eq.queued`,
      {
        status: 'processing',
        claimed_at: now,
        claimed_by: agent,
        assigned_reader_profile_id: candidate.assigned_reader_profile_id || claimedProfileId,
        claimed_reader_profile_id: claimedProfileId,
        heartbeat_at: now,
        progress_stage: 'claimed',
        progress_detail: null,
        attempts: Number(candidate.attempts || 0) + 1,
        last_error: null,
        updated_at: now
      }
    );
    if (updated?.length) return updated[0];
  }
  return null;
}

export async function claimReaderJob(agentId, capabilities = [], { managed = false, profileIds = [] } = {}) {
  const agent = cleanAgentId(agentId);
  if (!agent) throw new Error('reader_agent_id_required');
  const canReconcile = supportsReconcile(capabilities);

  // Claim only jobs that were explicitly queued by an admin/workflow. Reader
  // polling must never synthesize time-based reconcile work by itself.
  await recoverStaleJobs();
  return claimFirstQueued(agent, { canReconcile, managed, profileIds });
}

export async function heartbeatReaderJob({ jobId, agentId, progressCurrent, progressTotal, progressStage, progressDetail }) {
  const agent = cleanAgentId(agentId);
  if (!jobId || !agent) return null;
  const values = { heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const current = Number(progressCurrent);
  const total = Number(progressTotal);
  if (Number.isSafeInteger(current) && current >= 0) values.progress_current = current;
  if (Number.isSafeInteger(total) && total >= 0) values.progress_total = total;
  const stage = String(progressStage || '').trim();
  if (PROGRESS_STAGES.has(stage)) values.progress_stage = stage;
  if (progressDetail !== undefined) values.progress_detail = String(progressDetail || '').trim().slice(0, 240) || null;
  const updated = await patch(
    TABLES.readerJobs,
    `id=eq.${encodeURIComponent(jobId)}&status=eq.processing&claimed_by=eq.${encodeURIComponent(agent)}`,
    values
  );
  return updated?.[0] || null;
}

export async function finishReaderJob({ jobId, agentId, ok, messageCount, deletedCount, error }) {
  const agent = cleanAgentId(agentId);
  if (!jobId || !agent) throw new Error('reader_job_and_agent_required');
  const now = new Date().toISOString();
  const count = Number(messageCount);
  const deleted = Number(deletedCount);
  const updated = await patch(
    TABLES.readerJobs,
    `id=eq.${encodeURIComponent(jobId)}&status=eq.processing&claimed_by=eq.${encodeURIComponent(agent)}`,
    {
      status: ok ? 'done' : 'failed',
      completed_at: now,
      heartbeat_at: now,
      message_count: Number.isSafeInteger(count) && count >= 0 ? count : null,
      deleted_count: Number.isSafeInteger(deleted) && deleted >= 0 ? deleted : null,
      last_error: ok ? null : String(error || 'reader_import_failed').slice(0, 1000),
      error_code: ok ? null : String(error || 'reader_import_failed').slice(0, 120),
      progress_stage: ok ? 'completed' : 'failed',
      progress_detail: ok ? null : String(error || 'reader_import_failed').slice(0, 240),
      updated_at: now
    }
  );
  return updated?.[0] || null;
}
