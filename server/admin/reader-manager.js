import { isAuthenticated, isInternalSyncAuthorized } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';
import {
  adminUpdateReader,
  createReaderPairing,
  listReaderManagerState
} from '../../lib/reader-manager.js';
import { cloneConfig } from '../../lib/clone-config.js';

function readerManagerPublicUrl() {
  const explicit = String(process.env.READER_MANAGER_PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const previewHost = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  if (process.env.VERCEL_ENV === 'preview' && previewHost) {
    return `https://${String(previewHost).trim().replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  }
  return cloneConfig().clonerPublicUrl;
}

export default async function handler(req, res) {
  if (!isAuthenticated(req) && !isInternalSyncAuthorized(req)) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  if (!method(req, res, ['GET', 'POST'])) return;
  try {
    if (req.method === 'GET') {
      const state = await listReaderManagerState();
      return json(res, 200, { ok: true, ...state });
    }
    const body = await readJson(req, { maxBytes: 20_000 });
    if (body.operation === 'create_pairing') {
      const result = await createReaderPairing(body.display_name);
      return json(res, 201, {
        ok: true,
        pairing: {
          id: result.pairing.id,
          display_name: result.pairing.display_name,
          expires_at: result.pairing.expires_at,
          code: result.code,
          connection_code: `YNA1|${readerManagerPublicUrl()}|${result.code}`
        }
      });
    }
    const result = await adminUpdateReader(body);
    return json(res, 200, { ok: true, ...result });
  } catch (error) {
    return json(res, Number(error?.status || 500), {
      ok: false,
      error: String(error?.message || 'reader_manager_failed')
    });
  }
}
