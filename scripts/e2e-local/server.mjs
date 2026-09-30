import http from 'node:http';
import { URL } from 'node:url';
import registerSource from '../../api/reader/register-source.js';
import ingest from '../../api/reader/ingest.js';
import complete from '../../api/reader/complete.js';
import webhook from '../../api/telegram/webhook.js';

const port = Number(process.env.E2E_LOCAL_PORT || 8787);
const routes = new Map([
  ['/api/reader/register-source', registerSource],
  ['/api/reader/ingest', ingest],
  ['/api/reader/complete', complete],
  ['/api/telegram/webhook', webhook]
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${port}`}`);
  const handler = routes.get(url.pathname);
  if (!handler) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    return;
  }
  req.query = Object.fromEntries(url.searchParams.entries());
  try {
    await handler(req, res);
  } catch (error) {
    console.error('[e2e-local-server]', url.pathname, error?.stack || error);
    if (!res.headersSent) {
      res.statusCode = Number(error?.statusCode || error?.status || 500);
      res.setHeader('Content-Type', 'application/json');
    }
    if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: String(error?.message || 'internal_error') }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`TGCLONER_E2E_LOCAL_SERVER_READY http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
