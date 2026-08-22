import { isAuthenticated } from '../../lib/auth.js';
import { json } from '../../lib/http.js';
import { select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  const [sources, destinations, jobs, readerJobs, messages, mappings, broken] = await Promise.all([
    select(TABLES.sources, 'select=*'),
    select(TABLES.destinations, 'select=*'),
    select(TABLES.cloneJobs, 'select=*&order=created_at.desc&limit=50'),
    select(TABLES.readerJobs, 'select=*&order=created_at.desc&limit=50'),
    select(TABLES.sourceMessages, 'select=id,source_id,source_message_id,has_internal_links'),
    select(TABLES.messageMappings, 'select=id,status'),
    select(TABLES.cloneJobItems, 'select=id,last_error,status&status=in.(failed,queued)&last_error=not.is.null&limit=50')
  ]);

  const liveCounts = new Map();
  for (const message of messages || []) {
    if (!message?.source_id) continue;
    liveCounts.set(message.source_id, (liveCounts.get(message.source_id) || 0) + 1);
  }
  const latestReaderJobBySource = new Map();
  for (const job of readerJobs || []) {
    if (job?.source_id && !latestReaderJobBySource.has(job.source_id)) {
      latestReaderJobBySource.set(job.source_id, job);
    }
  }
  const sourceRows = (sources || []).map(source => ({
    ...source,
    indexed_message_count: liveCounts.get(source.id) || 0,
    reader_job: latestReaderJobBySource.get(source.id) || null
  }));

  json(res, 200, {
    ok: true,
    counts: {
      sources: sourceRows.length,
      destinations: destinations.length,
      active_destinations: destinations.filter((x) => x.active).length,
      source_messages: messages.length,
      internal_link_messages: messages.filter((x) => x.has_internal_links).length,
      mappings: mappings.length
    },
    sources: sourceRows,
    destinations,
    jobs,
    reader_jobs: readerJobs,
    warnings: broken
  });
}
