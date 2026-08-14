import { isAuthenticated } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';
import { insert, select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

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

  const messages = await select(TABLES.sourceMessages, `select=source_message_id,media_group_id,has_internal_links,is_pinned&source_id=eq.${encodeURIComponent(body.source_id)}&order=source_message_id.asc`);
  const [job] = await insert(TABLES.cloneJobs, { source_id: body.source_id, destination_id: body.destination_id, mode: 'full_clone', status: 'queued' });

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
