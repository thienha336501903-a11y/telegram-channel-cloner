import { isAuthenticated } from '../../lib/auth.js';
import { json } from '../../lib/http.js';
import { count, select, selectAll } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { ONLINE_WINDOW_MS } from '../../lib/reader-manager.js';
import { isReaderChannelAllowed } from '../../lib/channel-allowlist.js';

const STALE_QUEUED_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  const [sources, destinations, jobs, readerJobs, messages, mappings, broken, agents] = await Promise.all([
    // Paged: a plain select stops at Max rows (1000), which would drop channels and undercount posts.
    selectAll(TABLES.sources, 'select=*&order=created_at.asc,id.asc'),
    selectAll(TABLES.destinations, 'select=*&order=created_at.asc,id.asc'),
    select(TABLES.cloneJobs, 'select=*&order=created_at.desc&limit=50'),
    select(TABLES.readerJobs, 'select=*&order=created_at.desc&limit=50'),
    // shortcut: per-source post counts still read one narrow row per post; a GROUP BY RPC (migration) replaces this past ~50k posts.
    selectAll(TABLES.sourceMessages, 'select=source_id,has_internal_links&order=id.asc', { maxRows: 500_000 }),
    count(TABLES.messageMappings),
    select(TABLES.cloneJobItems, 'select=id,last_error,status&status=in.(failed,queued)&last_error=not.is.null&limit=50'),
    // Never select token_hash: the dashboard only needs who is connected and when.
    select(TABLES.readerAgents, 'select=id,display_name,platform,app_version,status,last_seen_at,revoked_at&order=last_seen_at.desc.nullslast&limit=20').catch(() => null)
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
    reader_job: latestReaderJobBySource.get(source.id) || null,
    allowlisted: isReaderChannelAllowed(source)
  }));

  const now = Date.now();
  // null = could not read the agents table: the dashboard says so instead of reporting every agent offline.
  const agentRows = agents === null ? null : agents.map(agent => ({
    ...agent,
    online: !agent.revoked_at && agent.status !== 'revoked' && Date.parse(agent.last_seen_at || 0) >= now - ONLINE_WINDOW_MS
  }));
  // Import problems the clone-only warning list never showed: failed jobs and jobs left waiting.
  const sourceTitle = new Map(sourceRows.map(s => [s.id, s.title || s.chat_id]));
  // Only the latest job per source: an old failure followed by a successful re-import is not a warning.
  const readerWarnings = [...latestReaderJobBySource.values()].filter(job =>
    job.status === 'failed' || (job.status === 'queued' && now - Date.parse(job.requested_at || job.created_at || 0) > STALE_QUEUED_MS)
  ).slice(0, 20).map(job => ({
    job_id: job.id,
    source: sourceTitle.get(job.source_id) || job.source_id,
    status: job.status,
    error: job.status === 'failed' ? (job.error_code || job.last_error || 'reader_import_failed') : 'queued_over_10_minutes',
    at: job.completed_at || job.updated_at || job.requested_at || job.created_at
  }));

  json(res, 200, {
    ok: true,
    counts: {
      sources: sourceRows.length,
      master_sources: sourceRows.filter((x) => x.active).length,
      agents_online: agentRows ? agentRows.filter((x) => x.online).length : null,
      destinations: destinations.length,
      active_destinations: destinations.filter((x) => x.active).length,
      source_messages: messages.length,
      internal_link_messages: messages.filter((x) => x.has_internal_links).length,
      mappings
    },
    sources: sourceRows,
    destinations,
    jobs,
    reader_jobs: readerJobs,
    agents: agentRows,
    warnings: broken,
    reader_warnings: readerWarnings
  });
}
