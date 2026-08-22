import { isAuthenticated } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';
import { queueReaderJob } from '../../lib/reader-jobs.js';
import { select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['POST'])) return;

  const body = await readJson(req, { maxBytes: 20_000 });
  if (!body.source_id) return json(res, 400, { ok: false, error: 'source_id_required' });

  const rows = await select(TABLES.sources, `select=*&id=eq.${encodeURIComponent(body.source_id)}&limit=1`);
  const source = rows?.[0];
  if (!source) return json(res, 404, { ok: false, error: 'source_not_found' });

  const jobType = body.job_type === 'reconcile' ? 'reconcile' : 'import';
  const queued = await queueReaderJob(source, { jobType });
  return json(res, 200, { ok: true, reader_job: queued.job, created: queued.created });
}
