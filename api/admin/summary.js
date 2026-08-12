import { isAuthenticated } from '../../lib/auth.js';
import { json } from '../../lib/http.js';
import { select } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  const [sources, destinations, jobs, messages, mappings, broken] = await Promise.all([
    select('telegram_sources', 'select=*'),
    select('telegram_destinations', 'select=*'),
    select('clone_jobs', 'select=*&order=created_at.desc&limit=50'),
    select('source_messages', 'select=id,source_message_id,has_internal_links'),
    select('message_mappings', 'select=id,status'),
    select('clone_job_items', 'select=id,last_error,status&status=in.(failed,queued)&last_error=not.is.null&limit=50')
  ]);
  json(res, 200, {
    ok: true,
    counts: {
      sources: sources.length,
      destinations: destinations.length,
      active_destinations: destinations.filter((x) => x.active).length,
      source_messages: messages.length,
      internal_link_messages: messages.filter((x) => x.has_internal_links).length,
      mappings: mappings.length
    },
    sources,
    destinations,
    jobs,
    warnings: broken
  });
}
