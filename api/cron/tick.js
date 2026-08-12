import { json } from '../../lib/http.js';
import { claimQueuedItems } from '../../lib/repository.js';
import { runTick } from '../../lib/engine.js';

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (expected && auth !== `Bearer ${expected}`) return json(res, 401, { ok: false, error: 'unauthorized' });
  const result = await runTick(claimQueuedItems);
  json(res, 200, { ok: true, ...result });
}
