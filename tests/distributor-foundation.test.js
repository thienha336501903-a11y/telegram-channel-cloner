import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TABLES } from '../lib/tables.js';
import { rpc } from '../lib/supabase.js';
import {
  DISTRIBUTOR_RPCS,
  createDistributorRun,
  closeDistributorManifest,
  recordDistributorEvent,
  claimDistributorWork,
  armDistributorWork,
  finishDistributorWork
} from '../lib/distributor-repository.js';

test('Distributor V2 tables stay inside tgcloner namespace', () => {
  assert.equal(TABLES.cloneRuns, 'tgcloner_clone_runs');
  assert.equal(TABLES.cloneManifest, 'tgcloner_clone_manifest');
  assert.equal(TABLES.sourceEvents, 'tgcloner_source_events');
  assert.equal(TABLES.cloneWork, 'tgcloner_clone_work');
  for (const name of [TABLES.cloneRuns, TABLES.cloneManifest, TABLES.sourceEvents, TABLES.cloneWork]) {
    assert.match(name, /^tgcloner_/);
  }
});

test('Supabase RPC helper refuses non-tgcloner functions', async () => {
  await assert.rejects(() => rpc('finish_v5_telegram_mirror_job', {}), /Refusing non-tgcloner RPC/);
  await assert.rejects(() => rpc('courses', {}), /Refusing non-tgcloner RPC/);
});

test('Distributor repository uses explicit durable RPC contracts', async (t) => {
  const oldFetch = global.fetch;
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SECRET_KEY;
  const oldLegacy = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const calls = [];

  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = ['sb', 'secret', 'distributor_foundation_test_key'].join('_');
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const fn = String(url).split('/rpc/')[1] || '';
    const body = options.body ? JSON.parse(options.body) : {};
    if (fn === DISTRIBUTOR_RPCS.claimWork) {
      return new Response(JSON.stringify([{ id: 'work-1', lease_generation: 2 }]), { status: 200 });
    }
    return new Response(JSON.stringify({ id: body.p_work_id || body.p_run_id || 'row-1' }), { status: 200 });
  };

  t.after(() => {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = oldKey;
    if (oldLegacy === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldLegacy;
  });

  await createDistributorRun({ sourceId: 'source-1', destinationId: 'dest-1' });
  await closeDistributorManifest({ runId: 'run-1', highWatermark: 500, expectedMessageIds: [1, 2, 5] });
  await recordDistributorEvent({
    eventKey: 'bot:42', sourceId: 'source-1', telegramUpdateId: 42,
    origin: 'bot_webhook', eventKind: 'message_new', sourceMessageId: 501
  });
  const claimed = await claimDistributorWork({ workerId: 'worker-a', limit: 1, leaseSeconds: 120 });
  await armDistributorWork({ workId: 'work-1', workerId: 'worker-a', leaseGeneration: 2 });
  await finishDistributorWork({
    workId: 'work-1', workerId: 'worker-a', leaseGeneration: 2,
    outcome: 'ambiguous', errorCode: 'network_timeout'
  });

  assert.equal(claimed.length, 1);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.match(call.url, /\/rest\/v1\/rpc\/tgcloner_distributor_/);
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers.Authorization, undefined, 'sb_secret keys must not be sent as bearer JWTs');
  }

  const closeCall = calls.find((x) => x.url.endsWith(`/rpc/${DISTRIBUTOR_RPCS.closeManifest}`));
  assert.deepEqual(JSON.parse(closeCall.options.body).p_expected_message_ids, [1, 2, 5]);

  const finishCall = calls.find((x) => x.url.endsWith(`/rpc/${DISTRIBUTOR_RPCS.finishWork}`));
  const finishBody = JSON.parse(finishCall.options.body);
  assert.equal(finishBody.p_outcome, 'ambiguous');
  assert.equal(finishBody.p_retryable, false);
});

test('Distributor migration encodes fail-closed foundation invariants', () => {
  const sql = fs.readFileSync(new URL('../sql/010_distributor_v2_durable_foundation.sql', import.meta.url), 'utf8');
  assert.match(sql, /distributor_v2_enabled boolean not null default false/i);
  assert.match(sql, /for update of w skip locked/i);
  assert.match(sql, /blocked_ambiguous/i);
  assert.match(sql, /side_effect_state = 'armed'/i);
  assert.match(sql, /security invoker/gi);
  assert.doesNotMatch(sql, /security definer/i);
  assert.match(sql, /enable row level security/gi);
  assert.match(sql, /revoke all on function public\.tgcloner_distributor_/i);
  assert.match(sql, /tgcloner_clone_runs_one_live_per_destination_idx/i);
  assert.match(sql, /tgcloner_mappings_destination_message_unique_idx/i);
});

test('Destination registration and legacy webhook are fail-closed for unverified V2 channels', () => {
  const destinations = fs.readFileSync(new URL('../server/admin/destinations.js', import.meta.url), 'utf8');
  const webhook = fs.readFileSync(new URL('../api/telegram/webhook.js', import.meta.url), 'utf8');
  assert.match(destinations, /active:\s*false/);
  assert.doesNotMatch(webhook, /\|\|\s*!d\.source_id/);
  assert.match(webhook, /filter\(\(d\) => d\.source_id === source\.id\)/);
});
