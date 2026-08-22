import { requireEnv } from '../../lib/env.js';
import { json, method, readJson } from '../../lib/http.js';
import { claimReaderJob } from '../../lib/reader-jobs.js';

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (req.headers.authorization !== `Bearer ${requireEnv('READER_INGEST_SECRET')}`) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  const body = await readJson(req, { maxBytes: 20_000 });
  const job = await claimReaderJob(body.agent_id);
  return json(res, 200, { ok: true, job });
}
