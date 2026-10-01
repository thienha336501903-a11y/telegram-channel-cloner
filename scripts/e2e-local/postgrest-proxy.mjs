import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

// Supabase exposes PostgREST under /rest/v1. The disposable local PostgREST
// container serves the same resources directly at the root instead.
export function createPostgrestProxy(upstreamOrigin, apiKey) {
  if (!apiKey) throw new Error('Local E2E REST proxy requires a run-specific API key');
  const upstream = new URL(upstreamOrigin);
  const expected = Buffer.from(apiKey);
  return function proxyPostgrest(req, res) {
    const supplied = Buffer.from(String(req.headers.apikey || ''));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'E2E_REST_UNAUTHORIZED' }));
      return;
    }
    const path = (req.url || '').slice('/rest/v1'.length);
    const target = new URL(path, upstream);
    const request = http.request(target, {
      method: req.method,
      headers: { ...req.headers, host: target.host }
    }, (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    });
    request.on('error', (error) => {
      console.error('[e2e-local-postgrest]', error.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      if (!res.writableEnded) res.end(JSON.stringify({ code: 'E2E_POSTGREST_UNAVAILABLE' }));
    });
    req.on('aborted', () => request.destroy());
    req.pipe(request);
  };
}
