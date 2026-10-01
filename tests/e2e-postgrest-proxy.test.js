import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { createPostgrestProxy } from '../scripts/e2e-local/postgrest-proxy.mjs';

const servers = [];
after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test('local E2E proxy maps Supabase REST reads and writes to root PostgREST routes', async () => {
  const apiKey = 'sb_secret_run_specific_test_key';
  const received = [];
  const upstream = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, apiKey: req.headers.apikey, body });
    res.writeHead(req.method === 'PATCH' ? 204 : 200, { 'Content-Type': 'application/json' });
    res.end(req.method === 'PATCH' ? undefined : '[{"distributor_v2_enabled":false}]');
  });
  const proxy = await listen(createPostgrestProxy(upstream, apiKey));

  const denied = await fetch(`${proxy}/rest/v1/tgcloner_settings?select=*`);
  assert.equal(denied.status, 401);
  assert.equal(received.length, 0);

  const read = await fetch(`${proxy}/rest/v1/tgcloner_settings?select=distributor_v2_enabled&limit=1`, {
    headers: { apikey: apiKey }
  });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), [{ distributor_v2_enabled: false }]);

  const write = await fetch(`${proxy}/rest/v1/tgcloner_settings?singleton=eq.true`, {
    method: 'PATCH',
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributor_v2_enabled: true })
  });
  assert.equal(write.status, 204);
  assert.deepEqual(received, [
    { method: 'GET', url: '/tgcloner_settings?select=distributor_v2_enabled&limit=1', apiKey, body: '' },
    { method: 'PATCH', url: '/tgcloner_settings?singleton=eq.true', apiKey, body: '{"distributor_v2_enabled":true}' }
  ]);
});
