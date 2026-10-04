import test from 'node:test';
import assert from 'node:assert/strict';
import { DISTRIBUTOR_RPCS, prepareDistributorCatchup } from '../lib/distributor-repository.js';

test('catch-up does not call its phase-limited RPC after entering rewriting', async (t) => {
  const oldFetch = global.fetch;
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SECRET_KEY;
  const oldLegacy = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = ['sb', 'secret', 'distributor_catchup_test_key'].join('_');
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = oldKey;
    if (oldLegacy === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldLegacy;
  });

  const calls = [];
  global.fetch = async (url) => {
    const fn = String(url).split('/rpc/')[1];
    calls.push(fn);
    if (fn !== DISTRIBUTOR_RPCS.prepareCatchup || calls.length > 1) {
      return new Response(JSON.stringify({ code: 'P0001', message: 'distributor_run_not_catchup_phase' }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: 'run-1', status: 'active', phase: 'rewriting' }), { status: 200 });
  };
  const run = await prepareDistributorCatchup({ runId: 'run-1' });
  assert.equal(run.phase, 'rewriting');
  assert.deepEqual(calls, [DISTRIBUTOR_RPCS.prepareCatchup]);

  calls.length = 0;
  global.fetch = async (url) => {
    const fn = String(url).split('/rpc/')[1];
    calls.push(fn);
    const phase = calls.length === 3 ? 'rewriting' : 'catching_up';
    return new Response(JSON.stringify({ id: 'run-1', status: 'active', phase }), { status: 200 });
  };
  const later = await prepareDistributorCatchup({ runId: 'run-1' });
  assert.equal(later.phase, 'rewriting');
  assert.deepEqual(calls, [
    DISTRIBUTOR_RPCS.prepareCatchup,
    DISTRIBUTOR_RPCS.promoteLinkDependencies,
    DISTRIBUTOR_RPCS.prepareCatchup
  ]);
});
