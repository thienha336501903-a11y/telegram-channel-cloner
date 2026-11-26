import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { createSessionCookie } from '../lib/auth.js';
import { fakeDb, withSupabaseEnv } from './helpers/fake-postgrest.js';

const SRC = '11111111-1111-1111-1111-111111111111';
const DST = '22222222-2222-2222-2222-222222222222';
const cookie = () => createSessionCookie().split(';')[0];

function baseTables(n) {
  return {
    tgcloner_sources: [{ id: SRC, chat_id: '-1001', username: null, created_at: '2026-01-01T00:00:00Z' }],
    tgcloner_destinations: [{ id: DST, chat_id: '-1002', source_id: null, created_at: '2026-01-01T00:00:00Z' }],
    tgcloner_source_messages: Array.from({ length: n }, (_, i) => ({ id: `m${String(i).padStart(6, '0')}`, source_id: SRC, source_message_id: i + 1, media_group_id: null, has_internal_links: false, is_pinned: false, message_type: 'text' })),
    tgcloner_clone_jobs: [],
    tgcloner_clone_job_items: []
  };
}

function call(handler, { method = 'GET', body, query } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, query, headers: { cookie: cookie() } });
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const ask = { source_id: SRC, destination_id: DST, max_messages: 10 };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test('race: a request that finds an earlier full clone still being created withdraws before creating items', async (t) => {
  withSupabaseEnv(t);
  const { default: handler } = await import('../server/admin/clone.js');
  const tables = baseTables(3);
  // Another request inserted its job a moment ago and has not inserted its items yet.
  tables.tgcloner_clone_jobs.push({ id: 'aaa-other', source_id: SRC, destination_id: DST, mode: 'full_clone', status: 'queued', created_at: '2000-01-01T00:00:00.000Z' });
  const db = fakeDb(tables);
  global.fetch = db.fetch;
  // The fake stamps new rows in 2026; make the other job "recent" relative to ours.
  tables.tgcloner_clone_jobs[0].created_at = '2026-11-25T23:59:59.000Z';
  const r = await call(handler, { method: 'POST', body: ask });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'clone_job_already_active');
  assert.equal(r.body.concurrent, true);
  const mine = tables.tgcloner_clone_jobs.find(j => j.id !== 'aaa-other');
  assert.equal(mine.status, 'failed', 'the later job withdraws');
  assert.equal(tables.tgcloner_clone_job_items.length, 0, 'no items for the withdrawn job');
});

test('race: withdrawn, failed-insert and long-dead item-less jobs do not block', async (t) => {
  withSupabaseEnv(t);
  const { default: handler } = await import('../server/admin/clone.js');
  for (const [label, job] of [
    ['withdrawn/failed', { status: 'failed', created_at: '2026-11-25T23:59:59.000Z' }],
    ['dead > 5 min', { status: 'queued', created_at: '2026-11-25T23:50:00.000Z' }],
    ['finished', { status: 'done', created_at: '2026-11-25T23:59:59.000Z', item: 'done' }]
  ]) {
    const tables = baseTables(3);
    tables.tgcloner_clone_jobs.push({ id: 'aaa-other', source_id: SRC, destination_id: DST, mode: 'full_clone', status: job.status, created_at: job.created_at });
    if (job.item) tables.tgcloner_clone_job_items.push({ id: 'x', job_id: 'aaa-other', status: job.item });
    global.fetch = fakeDb(tables).fetch;
    const r = await call(handler, { method: 'POST', body: ask });
    assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
  }
});

test('engine: items of a paused job are not claimed; stuck processing items are requeued', async (t) => {
  withSupabaseEnv(t);
  const { claimQueuedItems, recoverStuckItems } = await import('../lib/repository.js');
  const tables = {
    tgcloner_clone_jobs: [{ id: 'J1', status: 'queued' }, { id: 'J2', status: 'paused' }],
    tgcloner_clone_job_items: [
      { id: 'a', job_id: 'J1', status: 'queued', created_at: '1', attempts: 0 },
      { id: 'b', job_id: 'J2', status: 'queued', created_at: '2', attempts: 0 },
      { id: 'c', job_id: 'J1', status: 'processing', started_at: iso(11 * 60 * 1000) },
      { id: 'd', job_id: 'J1', status: 'processing', started_at: iso(60 * 1000) }
    ]
  };
  global.fetch = fakeDb(tables).fetch;
  const claimed = await claimQueuedItems(10);
  assert.deepEqual(claimed.map(i => i.id), ['a'], 'paused job item skipped');
  assert.equal(await recoverStuckItems(), 1);
  const byId = Object.fromEntries(tables.tgcloner_clone_job_items.map(i => [i.id, i.status]));
  assert.equal(byId.c, 'queued', 'stuck > 10 min requeued');
  assert.equal(byId.d, 'processing', 'a recent item is left alone');
});

test('engine: looks up source and destination by id, never lists whole tables', async (t) => {
  const engine = fs.readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /listSources\(|listDestinations\(/);
  withSupabaseEnv(t);
  const tables = { tgcloner_sources: Array.from({ length: 1500 }, (_, i) => ({ id: `s${i}`, chat_id: `-100${i}` })) };
  global.fetch = fakeDb(tables).fetch;
  const { getSourceById } = await import('../lib/repository.js');
  assert.equal((await getSourceById('s1400')).chat_id, '-1001400', 'a source past the 1000-row cap is found');
});

test('summary counts posts, sources and mappings past the cap', async (t) => {
  withSupabaseEnv(t);
  const tables = baseTables(1500);
  tables.tgcloner_sources = Array.from({ length: 1200 }, (_, i) => ({ id: i === 0 ? SRC : `s${i}`, chat_id: `-100${i}`, created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, active: i === 0 }));
  tables.tgcloner_message_mappings = Array.from({ length: 1300 }, (_, i) => ({ id: `mm${i}`, status: 'copied' }));
  global.fetch = fakeDb(tables).fetch;
  const { default: handler } = await import('../server/admin/summary.js');
  const r = await call(handler);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.counts.sources, 1200);
  assert.equal(r.body.counts.source_messages, 1500);
  assert.equal(r.body.counts.mappings, 1300);
  assert.equal(r.body.sources.find(s => s.id === SRC).indexed_message_count, 1500);
});

test('source-detail computes stats from every post past the cap', async (t) => {
  withSupabaseEnv(t);
  const tables = baseTables(1500);
  tables.tgcloner_reader_jobs = [];
  global.fetch = fakeDb(tables).fetch;
  const { default: handler } = await import('../server/admin/source-detail.js');
  const r = await call(handler, { query: { id: SRC } });
  assert.equal(r.status, 200);
  assert.equal(r.body.messages.total, 1500);
  assert.equal(r.body.messages.sampled, 1500);
  assert.equal(r.body.messages.truncated, false);
});
