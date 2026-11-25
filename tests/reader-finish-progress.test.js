import test from 'node:test';
import assert from 'node:assert/strict';
import { finishReaderJob } from '../lib/reader-jobs.js';

// A done import must not keep the stale heartbeat pair (dashboard showed "0/37 · 0%" for a 35-message job, 25/11).
test('finishReaderJob writes the final count into the progress pair only on success', async (t) => {
  const old = { fetch: global.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY, legacy: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = ['sb', 'secret', 'finish_progress_test_key'].join('_');
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    global.fetch = old.fetch;
    for (const [name, value] of [['SUPABASE_URL', old.url], ['SUPABASE_SECRET_KEY', old.key], ['SUPABASE_SERVICE_ROLE_KEY', old.legacy]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  const bodies = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ url: String(url), body });
    return new Response(JSON.stringify([{ id: 'job-1', ...body }]), { status: 200 });
  };

  await finishReaderJob({ jobId: 'job-1', agentId: 'agent-1', ok: true, messageCount: 35 });
  assert.match(bodies[0].url, /status=eq\.processing/);
  assert.equal(bodies[0].body.status, 'done');
  assert.equal(bodies[0].body.message_count, 35);
  assert.equal(bodies[0].body.progress_current, 35);
  assert.equal(bodies[0].body.progress_total, 35);

  await finishReaderJob({ jobId: 'job-2', agentId: 'agent-1', ok: false, messageCount: 12, error: 'import_exit_1' });
  assert.equal(bodies[1].body.status, 'failed');
  assert.equal('progress_current' in bodies[1].body, false, 'a failed job keeps its last measured progress');
  assert.equal('progress_total' in bodies[1].body, false);

  await finishReaderJob({ jobId: 'job-3', agentId: 'agent-1', ok: true });
  assert.equal(bodies[2].body.message_count, null);
  assert.equal('progress_current' in bodies[2].body, false, 'no count reported: keep the heartbeat pair');
});
