import { isAuthenticated } from '../../lib/auth.js';
import { json, method } from '../../lib/http.js';
import { evaluateConsistency } from '../../lib/consistency.js';
import { getActiveSource, listDestinations } from '../../lib/repository.js';
import { select } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['GET'])) return;

  const destinationId = String(req.query?.destination_id || '').trim();
  if (!destinationId) return json(res, 400, { ok: false, error: 'destination_id_required' });

  const destinations = await listDestinations();
  const destination = destinations.find((d) => d.id === destinationId);
  if (!destination) return json(res, 404, { ok: false, error: 'destination_not_found' });

  const activeSource = await getActiveSource();
  const sourceId = destination.source_id || activeSource?.id;
  if (!sourceId) return json(res, 409, { ok: false, error: 'source_not_configured' });

  const [messages, mappings, internalLinks] = await Promise.all([
    select(TABLES.sourceMessages, `select=source_message_id,media_group_id,is_pinned&source_id=eq.${encodeURIComponent(sourceId)}&order=source_message_id.asc`),
    select(TABLES.messageMappings, `select=source_message_id,destination_message_id,status&source_id=eq.${encodeURIComponent(sourceId)}&destination_id=eq.${encodeURIComponent(destinationId)}`),
    select(TABLES.internalLinks, `select=source_message_id&source_id=eq.${encodeURIComponent(sourceId)}`)
  ]);

  const report = evaluateConsistency({ messages, mappings, internalLinks });
  json(res, 200, { ok: true, source_id: sourceId, destination_id: destinationId, ...report });
}
