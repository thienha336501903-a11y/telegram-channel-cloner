import { requireEnv } from '../../lib/env.js';
import { json, method, readJson } from '../../lib/http.js';
import { heartbeatReaderJob } from '../../lib/reader-jobs.js';

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (req.headers.authorization !== `Bearer ${requireEnv('READER_INGEST_SECRET')}`) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  const body = await readJson(req, { maxBytes: 20_000 });
  const job = await heartbeatReaderJob({ jobId: body.job_id, agentId: body.agent_id });
  if (!job) return json(res, 409, { ok: false, error: 'reader_job_not_owned' });
  return json(res, 200, { ok: true, job });
}
