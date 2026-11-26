import { isAuthenticated } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';
import { count, insert, select, selectAll } from '../../lib/supabase.js';
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

async function insertBatches(rows) {
  for (let i = 0; i < rows.length; i += 250) await insert(TABLES.cloneJobItems, rows.slice(i, i + 250), { returning: false });
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

  // Only another full clone blocks; live-mirror jobs for the pair are normal. A full clone untouched for
  // an hour is treated as stuck so the admin can start again (copy is idempotent through mappings).
  // shortcut: check-then-insert is not atomic; two simultaneous admin clicks can both pass. Needs a DB unique index (Phase 3).
  const staleBefore = encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString());
  const [active] = await select(TABLES.cloneJobs, `select=id,status&source_id=eq.${sourceId}&destination_id=eq.${destinationId}&mode=eq.full_clone&status=in.(queued,running,paused)&updated_at=gte.${staleBefore}&limit=1`);
  if (active) return json(res, 409, { ok: false, error: 'clone_job_already_active', job_id: active.id, status: active.status });

  const total = await count(TABLES.sourceMessages, `source_id=eq.${sourceId}`);
  if (total === 0) return json(res, 409, { ok: false, error: 'clone_source_empty' });
  if (total > CLONE_HARD_MAX_MESSAGES) {
    return json(res, 409, { ok: false, error: 'clone_exceeds_hard_limit', source_messages: total, hard_limit: CLONE_HARD_MAX_MESSAGES });
  }
  if (total > maxMessages) {
    return json(res, 409, { ok: false, error: 'clone_exceeds_confirmed_count', source_messages: total, max_messages: maxMessages });
  }

  const messages = await selectAll(TABLES.sourceMessages, `select=source_message_id,media_group_id,has_internal_links,is_pinned&source_id=eq.${sourceId}&order=source_message_id.asc`);
  if (messages.length !== total) {
    return json(res, 409, { ok: false, error: 'clone_source_changed', source_messages: total, read_messages: messages.length });
  }
  const [job] = await insert(TABLES.cloneJobs, { source_id: source.id, destination_id: destination.id, mode: 'full_clone', status: 'queued' });

  const copyItems = buildCopyItems(job.id, messages);
  await insertBatches(copyItems);

  const rewriteItems = messages.filter((m) => m.has_internal_links).map((m) => ({
    job_id: job.id, source_message_id: m.source_message_id, source_message_ids: [Number(m.source_message_id)], phase: 'rewrite', status: 'queued'
  }));
  await insertBatches(rewriteItems);

  const pinItems = messages.filter((m) => m.is_pinned).map((m) => ({
    job_id: job.id, source_message_id: m.source_message_id, source_message_ids: [Number(m.source_message_id)], phase: 'pin', status: 'queued'
  }));
  await insertBatches(pinItems);

  json(res, 200, {
    ok: true,
    job_id: job.id,
    source_messages: messages.length,
    copy_items: copyItems.length,
    rewrite_items: rewriteItems.length,
    pin_items: pinItems.length
  });
}
