import { insert, patch, select } from './supabase.js';
import { TABLES } from './tables.js';

const STALE_PROCESSING_MS = 10 * 60 * 1000;

function cleanAgentId(value) {
  return String(value || '').trim().slice(0, 160);
}

function channelRefForSource(source) {
  if (source?.username) return `@${String(source.username).replace(/^@/, '')}`;
  return String(source?.chat_id || '').trim();
}

export async function queueReaderJob(source) {
  if (!source?.id) throw new Error('reader_source_required');
  const active = await select(
    TABLES.readerJobs,
    `select=*&source_id=eq.${encodeURIComponent(source.id)}&status=in.(queued,processing)&order=created_at.desc&limit=1`
  );
  if (active?.[0]) return { job: active[0], created: false };

  const channelRef = channelRefForSource(source);
  if (!channelRef) throw new Error('reader_source_channel_missing');

  try {
    const rows = await insert(TABLES.readerJobs, {
      source_id: source.id,
      channel_ref: channelRef,
      status: 'queued',
      requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
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

export async function claimReaderJob(agentId) {
  const agent = cleanAgentId(agentId);
  if (!agent) throw new Error('reader_agent_id_required');

  await recoverStaleJobs();
  const candidates = await select(
    TABLES.readerJobs,
    'select=*&status=eq.queued&order=requested_at.asc&limit=5'
  );
  for (const candidate of candidates || []) {
    const now = new Date().toISOString();
    const updated = await patch(
      TABLES.readerJobs,
      `id=eq.${encodeURIComponent(candidate.id)}&status=eq.queued`,
      {
        status: 'processing',
        claimed_at: now,
        claimed_by: agent,
        heartbeat_at: now,
        attempts: Number(candidate.attempts || 0) + 1,
        last_error: null,
        updated_at: now
      }
    );
    if (updated?.length) return updated[0];
  }
  return null;
}

export async function heartbeatReaderJob({ jobId, agentId }) {
  const agent = cleanAgentId(agentId);
  if (!jobId || !agent) return null;
  const updated = await patch(
    TABLES.readerJobs,
    `id=eq.${encodeURIComponent(jobId)}&status=eq.processing&claimed_by=eq.${encodeURIComponent(agent)}`,
    { heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  );
  return updated?.[0] || null;
}

export async function finishReaderJob({ jobId, agentId, ok, messageCount, error }) {
  const agent = cleanAgentId(agentId);
  if (!jobId || !agent) throw new Error('reader_job_and_agent_required');
  const now = new Date().toISOString();
  const count = Number(messageCount);
  const updated = await patch(
    TABLES.readerJobs,
    `id=eq.${encodeURIComponent(jobId)}&status=eq.processing&claimed_by=eq.${encodeURIComponent(agent)}`,
    {
      status: ok ? 'done' : 'failed',
      completed_at: now,
      heartbeat_at: now,
      message_count: Number.isSafeInteger(count) && count >= 0 ? count : null,
      last_error: ok ? null : String(error || 'reader_import_failed').slice(0, 1000),
      updated_at: now
    }
  );
  return updated?.[0] || null;
}
