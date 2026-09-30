import { isAuthenticated } from '../../lib/auth.js';
import { getDistributorProgress } from '../../lib/distributor-repository.js';
import { json, method } from '../../lib/http.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const progress = await getDistributorProgress();
    json(res, 200, { ok: true, available: true, progress });
  } catch (error) {
    // Existing environments may deploy the read-only UI before migration 016.
    if (error.status === 404 && error.details?.code === 'PGRST202') {
      return json(res, 200, { ok: true, available: false, reason: 'migration_016_required' });
    }
    console.error('Distributor progress query failed', error);
    return json(res, 503, { ok: false, error: 'distributor_progress_unavailable' });
  }
}
