// S1 (Owner 26/11): read-only detail of one source for the dashboard: message stats, recent import jobs and
// allowlist state. No write, no Telegram call.
import { isAuthenticated } from '../../lib/auth.js';
import { json, method } from '../../lib/http.js';
import { count, select, selectAll } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { isReaderChannelAllowed, readerChannelAllowlist } from '../../lib/channel-allowlist.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 20000; // shortcut: stats are computed in Node from every row (paged); move to an RPC past ~20k posts per channel

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['GET'])) return;
  const id = String((Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id) || '');
  if (!UUID.test(id)) return json(res, 400, { ok: false, error: 'source_id_invalid' });

  const [sources, messages, total, jobs] = await Promise.all([
    select(TABLES.sources, `select=id,chat_id,title,username,active,created_at,indexed_at,last_reconciled_at&id=eq.${id}&limit=1`),
    // Paged read of every post (PostgREST caps one select at Max rows = 1000); a channel past MAX_MESSAGES falls back to the newest 1000 and says so.
    selectAll(TABLES.sourceMessages, `select=message_type,has_internal_links,is_pinned,media_group_id,source_date&source_id=eq.${id}&order=source_message_id.asc`, { maxRows: MAX_MESSAGES })
      .catch(() => select(TABLES.sourceMessages, `select=message_type,has_internal_links,is_pinned,media_group_id,source_date&source_id=eq.${id}&order=source_date.desc.nullslast&limit=1000`)),
    count(TABLES.sourceMessages, `source_id=eq.${id}`).catch(() => null),
    select(TABLES.readerJobs, `select=id,job_type,status,attempts,message_count,deleted_count,error_code,last_error,progress_stage,requested_at,claimed_at,completed_at,created_at&source_id=eq.${id}&order=created_at.desc&limit=20`)
  ]);
  const source = sources?.[0];
  if (!source) return json(res, 404, { ok: false, error: 'source_not_found' });

  const byType = {};
  const albums = new Set();
  let first = null, last = null, links = 0, pinned = 0;
  for (const m of messages || []) {
    byType[m.message_type || 'other'] = (byType[m.message_type || 'other'] || 0) + 1;
    if (m.media_group_id) albums.add(m.media_group_id);
    if (m.has_internal_links) links += 1;
    if (m.is_pinned) pinned += 1;
    if (m.source_date && (!first || m.source_date < first)) first = m.source_date;
    if (m.source_date && (!last || m.source_date > last)) last = m.source_date;
  }

  return json(res, 200, {
    ok: true,
    source,
    allowlist: { enabled: Boolean(readerChannelAllowlist()), allowed: isReaderChannelAllowed(source) },
    messages: {
      // count failed -> fall back to the rows we have and do not claim completeness either way
      total: total ?? (messages || []).length,
      sampled: (messages || []).length,
      truncated: total === null ? null : (messages || []).length < total,
      by_type: byType,
      albums: albums.size,
      internal_links: links,
      pinned,
      first_post_at: first,
      last_post_at: last
    },
    jobs: jobs || []
  });
}
