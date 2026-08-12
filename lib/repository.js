import { insert, patch, select, upsert } from './supabase.js';
import { TABLES } from './tables.js';

export async function getActiveSource() {
  const rows = await select(TABLES.sources, 'select=*&active=eq.true&limit=1');
  return rows?.[0] || null;
}

export async function listSources() {
  return select(TABLES.sources, 'select=*&order=created_at.desc');
}

export async function listDestinations({ activeOnly = false } = {}) {
  const filter = activeOnly ? '&active=eq.true' : '';
  return select(TABLES.destinations, `select=*${filter}&order=created_at.asc`);
}

export async function upsertSource(source) {
  return upsert(TABLES.sources, source, { onConflict: 'chat_id' });
}

export async function upsertDestination(destination) {
  return upsert(TABLES.destinations, destination, { onConflict: 'chat_id' });
}

export async function upsertSourceMessage(message) {
  return upsert(TABLES.sourceMessages, message, { onConflict: 'source_id,source_message_id' });
}

export async function getSourceMessage(sourceId, sourceMessageId) {
  const rows = await select(TABLES.sourceMessages, `select=*&source_id=eq.${encodeURIComponent(sourceId)}&source_message_id=eq.${sourceMessageId}&limit=1`);
  return rows?.[0] || null;
}

export async function getMappings(destinationId) {
  const rows = await select(TABLES.messageMappings, `select=source_message_id,destination_message_id&destination_id=eq.${encodeURIComponent(destinationId)}&status=eq.copied&order=source_message_id.asc`);
  return new Map((rows || []).map((r) => [Number(r.source_message_id), Number(r.destination_message_id)]));
}

export async function upsertMapping(row) {
  return upsert(TABLES.messageMappings, row, { onConflict: 'source_id,source_message_id,destination_id' });
}

export async function recordInternalLinks(sourceId, sourceMessageDbId, links) {
  if (!links.length) return [];
  return upsert(TABLES.internalLinks, links.map((l) => ({
    source_id: sourceId,
    source_message_db_id: sourceMessageDbId,
    source_message_id: l.source_message_id,
    location: l.location,
    original_url: l.full
  })), { onConflict: 'source_message_db_id,location,original_url' });
}

export async function enqueueForDestinations({ sourceId, sourceMessageId, destinationIds, reason = 'new_message' }) {
  if (!destinationIds.length) return [];
  const jobs = [];
  for (const destinationId of destinationIds) {
    const [job] = await insert(TABLES.cloneJobs, {
      source_id: sourceId,
      destination_id: destinationId,
      mode: reason,
      status: 'queued'
    });
    await insert(TABLES.cloneJobItems, {
      job_id: job.id,
      source_message_id: sourceMessageId,
      phase: 'copy',
      status: 'queued'
    });
    jobs.push(job);
  }
  return jobs;
}

export async function claimQueuedItems(limit) {
  // REST-only claim is intentionally conservative. Concurrent cron executions are serialized
  // by selecting old items and immediately switching them to processing. DB-level SKIP LOCKED
  // can replace this when the SQL RPC is enabled.
  const now = encodeURIComponent(new Date().toISOString());
  const items = await select(TABLES.cloneJobItems, `select=*,${TABLES.cloneJobs}!inner(id,source_id,destination_id,status)&status=eq.queued&or=(retry_after.is.null,retry_after.lte.${now})&order=created_at.asc&limit=${limit}`);
  const claimed = [];
  for (const item of items || []) {
    const updated = await patch(TABLES.cloneJobItems, `id=eq.${item.id}&status=eq.queued`, { status: 'processing', attempts: Number(item.attempts || 0) + 1, started_at: new Date().toISOString() });
    if (updated?.length) claimed.push({ ...item, ...updated[0] });
  }
  return claimed;
}

export async function finishItem(itemId, values) {
  return patch(TABLES.cloneJobItems, `id=eq.${itemId}`, { ...values, finished_at: new Date().toISOString() });
}

export async function updateJobStatus(jobId) {
  const items = await select(TABLES.cloneJobItems, `select=status&job_id=eq.${jobId}`);
  const statuses = (items || []).map((x) => x.status);
  let status = 'running';
  if (statuses.some((x) => x === 'failed')) status = 'failed';
  else if (statuses.length && statuses.every((x) => x === 'done')) status = 'done';
  else if (statuses.every((x) => x === 'queued')) status = 'queued';
  return patch(TABLES.cloneJobs, `id=eq.${jobId}`, { status, updated_at: new Date().toISOString() });
}

export async function logEvent(event) {
  return insert(TABLES.syncEvents, event, { returning: false });
}
