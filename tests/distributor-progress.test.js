import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCookie } from '../lib/auth.js';
import handler from '../server/admin/distributor-progress.js';

function response() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; }
  };
}

test('progress endpoint requires an admin session, permits GET only, and reads only its scoped RPC', async (t) => {
  const oldFetch = global.fetch;
  const oldEnv = Object.fromEntries(['SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].map(k => [k, process.env[k]]));
  t.after(() => {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.SESSION_SECRET = 'progress-test-session';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_progress_test';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ overall: { destinations: 0 }, courses: [], runs: [] }), { status: 200 });
  };

  const denied = response();
  await handler({ method: 'GET', headers: {} }, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(calls.length, 0);

  const headers = { cookie: createSessionCookie().split(';')[0] };
  const rejected = response();
  await handler({ method: 'POST', headers }, rejected);
  assert.equal(rejected.statusCode, 405);
  assert.equal(calls.length, 0);

  const allowed = response();
  await handler({ method: 'GET', headers }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['Cache-Control'], 'private, no-store');
  assert.equal(JSON.parse(allowed.body).available, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/tgcloner_distributor_progress$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_limit: 50 });
});

test('progress endpoint reports a missing migration without masking other database failures', async (t) => {
  const oldFetch = global.fetch;
  const oldEnv = Object.fromEntries(['SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'].map(k => [k, process.env[k]]));
  t.after(() => {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.SESSION_SECRET = 'progress-test-session';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_progress_test';
  const headers = { cookie: createSessionCookie().split(';')[0] };
  global.fetch = async () => new Response(JSON.stringify({ code: 'PGRST202' }), { status: 404 });
  const missing = response();
  await handler({ method: 'GET', headers }, missing);
  assert.equal(missing.statusCode, 200);
  assert.equal(JSON.parse(missing.body).reason, 'migration_016_required');

  global.fetch = async () => new Response(JSON.stringify({ code: '42501', message: 'secret detail' }), { status: 403 });
  const failed = response();
  const oldError = console.error;
  console.error = () => {};
  try { await handler({ method: 'GET', headers }, failed); } finally { console.error = oldError; }
  assert.equal(failed.statusCode, 503);
  assert.equal(JSON.parse(failed.body).error, 'distributor_progress_unavailable');
  assert.doesNotMatch(failed.body, /secret detail/);
});
