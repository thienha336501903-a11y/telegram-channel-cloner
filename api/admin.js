import cloneHandler from '../server/admin/clone.js';
import destinationsHandler from '../server/admin/destinations.js';
import runTickHandler from '../server/admin/run-tick.js';
import sourceHandler from '../server/admin/source.js';
import summaryHandler from '../server/admin/summary.js';
import v4SourceHandler from '../server/admin/v4-source.js';
import verifyHandler from '../server/admin/verify.js';
import webhookHandler from '../server/admin/webhook.js';
import { json } from '../lib/http.js';

const handlers = {
  clone: cloneHandler,
  destinations: destinationsHandler,
  'run-tick': runTickHandler,
  source: sourceHandler,
  summary: summaryHandler,
  'v4-source': v4SourceHandler,
  verify: verifyHandler,
  webhook: webhookHandler
};

export default async function handler(req, res) {
  const action = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  const target = handlers[String(action || '')];
  if (!target) return json(res, 404, { ok: false, error: 'admin_route_not_found' });
  return target(req, res);
}
