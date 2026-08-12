import { isAuthenticated } from '../../lib/auth.js';
import { json, method } from '../../lib/http.js';
import { claimQueuedItems } from '../../lib/repository.js';
import { runTick } from '../../lib/engine.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['POST'])) return;
  const result = await runTick(claimQueuedItems);
  json(res, 200, { ok: true, ...result });
}
