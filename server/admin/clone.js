import { isAuthenticated } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';
import { count, insert, patch, select, selectAll } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { isReaderChannelAllowed } from '../../lib/channel-allowlist.js';

// Owner decision D7: a clone posts at most 50 messages unless the admin confirms a larger count, never more than 500.
export const CLONE_DEFAULT_MAX_MESSAGES = 50;
export const CLONE_HARD_MAX_MESSAGES = 500;

function buildCopyItems(jobId, messages) {
  const items = [];
  const seenGroups = new Set();
  for (const m of messages) {
    if (m.media_group_id) {
      if (seenGroups.has(m.media_group_id)) continue;
      seenGroups.add(m.media_group_id);
      const group = messages.filter((x) => x.media_group_id === m.media_group_id).sort((a,b) => Number(a.source_message_id)-Number(b.source_message_id));
      items.push({ job_id: jobId, source_message_id: group[0].source_message_id, source_message_ids: group.map((x) => Number(x.source_message_id)), phase: 'copy', status: 'queued' });
    } else {
      items.push({ job_id: jobId, source_message_id: m.source_message_id, source_message_ids: [Number(m.source_message_id)], phase: 'copy', status: 'queued' });
    }
  }
  return items;
}

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!body.source_id || !body.destination_id) return json(res, 400, { ok: false, error: 'source_id_and_destination_id_required' });

  const maxMessages = body.max_messages === undefined || body.max_messages === null
    ? CLONE_DEFAULT_MAX_MESSAGES
    : Number(body.max_messages);
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > CLONE_HARD_MAX_MESSAGES) {
    return json(res, 400, { ok: false, error: 'max_messages_invalid', hard_limit: CLONE_HARD_MAX_MESSAGES });
  }

  const sourceId = encodeURIComponent(body.source_id);
  const destinationId = encodeURIComponent(body.destination_id);
  const [[source], [destination]] = await Promise.all([
    select(TABLES.sources, `select=id,chat_id,username&id=eq.${sourceId}&limit=1`),
    select(TABLES.destinations, `select=id,chat_id,source_id&id=eq.${destinationId}&limit=1`)
  ]);
  if (!source) return json(res, 404, { ok: false, error: 'source_not_found' });
  if (!isReaderChannelAllowed(source)) return json(res, 403, { ok: false, error: 'reader_channel_not_allowlisted' });
  if (!destination) return json(res, 404, { ok: false, error: 'destination_not_found' });
  // Never post into any registered source channel, not only this clone's own source.
  const [sourceChannel] = await select(TABLES.sources, `select=id&chat_id=eq.${encodeURIComponent(destination.chat_id)}&limit=1`);
  if (sourceChannel || String(destination.chat_id) === String(source.chat_id)) return json(res, 409, { ok: false, error: 'destination_is_source' });
  if (destination.source_id && destination.source_id !== source.id) {
    return json(res, 409, { ok: false, error: 'destination_bound_to_other_source' });
  }
  if (!destination.source_id) {
    // An unbound destination that already holds another source's posts would mix two sources in one
    // mapping table (getMappings keys by source_message_id), so link rewrites could point at the wrong post.
    const [foreign] = await select(TABLES.messageMappings, `select=id&destination_id=eq.${destinationId}&source_id=neq.${sourceId}&limit=1`);
    if (foreign) return json(res, 409, { ok: false, error: 'destination_has_other_source_posts' });
  }

  // One full clone per destination (from any source) while it still has work. Decided by open items, not
  // by job status: a job is marked "failed" as soon as one item fails, yet its other queued items are still
  // claimed and posted (claimQueuedItems does not filter on job status). A job with no open item cannot post.
  // Live-mirror jobs are not full clones and do not block.
  // shortcut: check-then-insert is not atomic; two simultaneous admin clicks can both pass. Needs a DB unique index (Phase 3).
  const [openItem] = await select(TABLES.cloneJobItems, `select=job_id,job:${TABLES.cloneJobs}!inner(id,status,destination_id,mode)&job.destination_id=eq.${destinationId}&job.mode=eq.full_clone&status=in.(queued,processing)&limit=1`);
  if (openItem) return json(res, 409, { ok: false, error: 'clone_job_already_active', job_id: openItem.job_id, status: openItem.job?.status || null });

  const total = await count(TABLES.sourceMessages, `source_id=eq.${sourceId}`);
  if (total === 0) return json(res, 409, { ok: false, error: 'clone_source_empty' });
  if (total > CLONE_HARD_MAX_MESSAGES) {
    return json(res, 409, { ok: false, error: 'clone_exceeds_hard_limit', source_messages: total, hard_limit: CLONE_HARD_MAX_MESSAGES });
  }
  if (total > maxMessages) {
    return json(res, 409, { ok: false, error: 'clone_exceeds_confirmed_count', source_messages: total, max_messages: maxMessages });
  }

  // Snapshot check: offset paging can repeat or skip a row if an Import adds or Reconcile removes messages
  // mid-read, so require unique rows equal to the count both before and after the read.
  const messages = await selectAll(TABLES.sourceMessages, `select=source_message_id,media_group_id,has_internal_links,is_pinned&source_id=eq.${sourceId}&order=source_message_id.asc`);
  const uniqueIds = new Set(messages.map((m) => Number(m.source_message_id))).size;
  const totalAfter = await count(TABLES.sourceMessages, `source_id=eq.${sourceId}`);
  if (messages.length !== total || uniqueIds !== total || totalAfter !== total) {
    return json(res, 409, { ok: false, error: 'clone_source_changed', source_messages: total, read_messages: messages.length, unique_messages: uniqueIds, source_messages_after: totalAfter });
  }
  const [job] = await insert(TABLES.cloneJobs, { source_id: source.id, destination_id: destination.id, mode: 'full_clone', status: 'queued' });

  const copyItems = buildCopyItems(job.id, messages);
  const rewriteItems = messages.filter((m) => m.has_internal_links).map((m) => ({
    job_id: job.id, source_message_id: m.source_message_id, source_message_ids: [Number(m.source_message_id)], phase: 'rewrite', status: 'queued'
  }));
  const pinItems = messages.filter((m) => m.is_pinned).map((m) => ({
    job_id: job.id, source_message_id: m.source_message_id, source_message_ids: [Number(m.source_message_id)], phase: 'pin', status: 'queued'
  }));
  // One insert = one transaction: a job never gets only part of its items (a partial job would finish
  // "done" with posts missing). Explicit created_at keeps the queue order: copies in source order, then
  // rewrites, then pins (rows inserted together would otherwise share one now()).
  const base = Date.now();
  const items = [...copyItems, ...rewriteItems, ...pinItems].map((item, i) => ({ ...item, created_at: new Date(base + i).toISOString() }));
  try {
    await insert(TABLES.cloneJobItems, items, { returning: false });
  } catch (error) {
    await patch(TABLES.cloneJobs, `id=eq.${encodeURIComponent(job.id)}`, { status: 'failed', updated_at: new Date().toISOString() }, { returning: false }).catch(() => {});
    return json(res, 500, { ok: false, error: 'clone_items_insert_failed', job_id: job.id });
  }

  json(res, 200, {
    ok: true,
    job_id: job.id,
    snapshot_max_source_message_id: Number(messages[messages.length - 1].source_message_id),
    source_messages: messages.length,
    copy_items: copyItems.length,
    rewrite_items: rewriteItems.length,
    pin_items: pinItems.length
  });
}
