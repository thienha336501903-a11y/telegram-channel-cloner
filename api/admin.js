import cloneHandler from '../server/admin/clone.js';
import destinationsHandler from '../server/admin/destinations.js';
import distributorProgressHandler from '../server/admin/distributor-progress.js';
import readerJobHandler from '../server/admin/reader-job.js';
import readerManagerHandler from '../server/admin/reader-manager.js';
import publicConfigHandler from '../server/admin/public-config.js';
import runTickHandler from '../server/admin/run-tick.js';
import sourceHandler from '../server/admin/source.js';
import sourceDetailHandler from '../server/admin/source-detail.js';
import summaryHandler from '../server/admin/summary.js';
import v4SourceHandler from '../server/admin/v4-source.js';
import verifyHandler from '../server/admin/verify.js';
import webhookHandler from '../server/admin/webhook.js';
import { json } from '../lib/http.js';

const handlers = {
  clone: cloneHandler,
  destinations: destinationsHandler,
  'distributor-progress': distributorProgressHandler,
  'reader-job': readerJobHandler,
  'reader-manager': readerManagerHandler,
  'public-config': publicConfigHandler,
  'run-tick': runTickHandler,
  source: sourceHandler,
  'source-detail': sourceDetailHandler,
  summary: summaryHandler,
  'v4-source': v4SourceHandler,
  verify: verifyHandler,
  webhook: webhookHandler
};

export default async function handler(req, res) {
  const action = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  const target = handlers[String(action || '')];
  if (!target) return json(res, 404, { ok: false, error: 'admin_route_not_found' });
  try {
    return await target(req, res);
  } catch (error) {
    // Channel outside READER_CHANNEL_ALLOWLIST (lib/channel-allowlist.js): a clear 403, not a 500.
    if (error?.code === 'reader_channel_not_allowlisted') return json(res, 403, { ok: false, error: error.code });
    throw error;
  }
}
