import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import { createSessionCookie } from '../lib/auth.js';

// Fake PostgREST with the Production "Max rows" cap: a GET never returns more than CAP rows,
// whatever limit the caller asks for. Supports the filters these handlers use.
const CAP = 1000;
const SRC = '11111111-1111-1111-1111-111111111111';
const DST = '22222222-2222-2222-2222-222222222222';

function fakeDb(tables) {
  const calls = [];
  let nextId = 1;
  function filterRows(rows, params) {
    let out = rows;
    for (const [key, value] of params) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      const [op, ...rest] = value.split('.');
      const arg = rest.join('.');
      if (op === 'eq') out = out.filter(r => String(r[key]) === arg);
      else if (op === 'neq') out = out.filter(r => String(r[key]) !== arg);
      else if (op === 'gte') out = out.filter(r => String(r[key]) >= arg);
      else if (op === 'in') { const set = new Set(arg.replace(/^\(|\)$/g, '').split(',')); out = out.filter(r => set.has(String(r[key]))); }
      else throw new Error(`fake db: unsupported filter ${key}=${value}`);
    }
    const order = params.get('order');
    if (order) {
      const keys = order.split(',').map(k => k.split('.')[0]);
      out = [...out].sort((a, b) => { for (const k of keys) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; });
    }
    return out;
  }
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const table = u.pathname.split('/rest/v1/')[1];
    const method = init.method || 'GET';
    calls.push({ method, table, query: u.search });
    tables[table] ||= [];
    if (method === 'HEAD') {
      const n = filterRows(tables[table], u.searchParams).length;
      return new Response(null, { status: 200, headers: { 'content-range': `*/${n}` } });
    }
    if (method === 'GET') {
      const rows = filterRows(tables[table], u.searchParams);
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Math.min(Number(u.searchParams.get('limit') || CAP), CAP);
      return new Response(JSON.stringify(rows.slice(offset, offset + limit)), { status: 200 });
    }
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const rows = (Array.isArray(body) ? body : [body]).map(r => ({ id: `row-${nextId++}`, updated_at: new Date().toISOString(), ...r }));
      tables[table].push(...rows);
      return new Response(JSON.stringify(rows), { status: 201 });
    }
    if (method === 'PATCH') {
      const values = JSON.parse(init.body);
      const rows = filterRows(tables[table], u.searchParams);
      rows.forEach(r => Object.assign(r, values));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    throw new Error(`fake db: unsupported ${method}`);
  };
  return { fetch, calls, tables };
}

function withEnv(t, extra = {}) {
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'READER_CHANNEL_ALLOWLIST'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  const oldFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = ['sb', 'secret', 'clone_1a_test_key'].join('_');
  process.env.SESSION_SECRET = 'clone-1a-test-session-secret-0123456789';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.READER_CHANNEL_ALLOWLIST;
  Object.assign(process.env, extra);
  t.after(() => {
    global.fetch = oldFetch;
    for (const n of names) { if (old[n] === undefined) delete process.env[n]; else process.env[n] = old[n]; }
  });
}

function messages(n, sourceId = SRC) {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, source_id: sourceId, source_message_id: i + 1, media_group_id: null, has_internal_links: false, is_pinned: false }));
}

function baseTables(messageCount) {
  return {
    tgcloner_sources: [{ id: SRC, chat_id: '-1001', username: null }],
    tgcloner_destinations: [{ id: DST, chat_id: '-1002', source_id: null }],
    tgcloner_source_messages: messages(messageCount),
    tgcloner_clone_jobs: [],
    tgcloner_clone_job_items: []
  };
}

function post(handler, body, cookie = true) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.headers = cookie ? { cookie: createSessionCookie().split(';')[0] } : {};
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('selectAll reads past the 1000-row cap and refuses unordered queries', async (t) => {
  withEnv(t);
  const db = fakeDb({ tgcloner_source_messages: messages(2500) });
  global.fetch = db.fetch;
  const { selectAll, select } = await import('../lib/supabase.js');
  assert.equal((await select('tgcloner_source_messages', `source_id=eq.${SRC}&order=source_message_id.asc`)).length, CAP, 'plain select is capped');
  const all = await selectAll('tgcloner_source_messages', `source_id=eq.${SRC}&order=source_message_id.asc`);
  assert.equal(all.length, 2500);
  assert.equal(new Set(all.map(r => r.source_message_id)).size, 2500, 'no duplicates');
  // A server cap smaller than pageSize must not end the read early.
  assert.equal((await selectAll('tgcloner_source_messages', `source_id=eq.${SRC}&order=source_message_id.asc`, { pageSize: 5000 })).length, 2500);
  await assert.rejects(selectAll('tgcloner_source_messages', `source_id=eq.${SRC}`), /selectAll_requires_order/);
  await assert.rejects(selectAll('tgcloner_source_messages', `order=id.asc&limit=5`), /selectAll_manages_limit_offset/);
});

test('updateJobStatus sees items past the cap: failed or queued item at position 1200', async (t) => {
  withEnv(t);
  const items = Array.from({ length: 1500 }, (_, i) => ({ id: `i${i}`, job_id: 'J', status: 'done' }));
  const db = fakeDb({ tgcloner_clone_jobs: [{ id: 'J', status: 'running' }], tgcloner_clone_job_items: items });
  global.fetch = db.fetch;
  const { updateJobStatus } = await import('../lib/repository.js');
  await updateJobStatus('J');
  assert.equal(db.tables.tgcloner_clone_jobs[0].status, 'done');
  items[1200].status = 'queued';
  await updateJobStatus('J');
  assert.equal(db.tables.tgcloner_clone_jobs[0].status, 'running', 'a queued item past the cap keeps the job open');
  items[1200].status = 'failed';
  await updateJobStatus('J');
  assert.equal(db.tables.tgcloner_clone_jobs[0].status, 'failed');
  for (const open of ['processing', 'skipped']) {
    items[1200].status = open;
    await updateJobStatus('J');
    assert.equal(db.tables.tgcloner_clone_jobs[0].status, 'running', `an item ${open} keeps the job running`);
  }
  db.tables.tgcloner_clone_job_items = [];
  await updateJobStatus('J');
  assert.equal(db.tables.tgcloner_clone_jobs[0].status, 'queued', 'no items keeps the old empty-job meaning');
});

test('getMappings returns mappings past the cap', async (t) => {
  withEnv(t);
  const rows = Array.from({ length: 1500 }, (_, i) => ({ source_id: SRC, destination_id: DST, status: 'copied', source_message_id: i + 1, destination_message_id: 9000 + i + 1 }));
  global.fetch = fakeDb({ tgcloner_message_mappings: rows }).fetch;
  const { getMappings } = await import('../lib/repository.js');
  const map = await getMappings(DST);
  assert.equal(map.size, 1500);
  assert.equal(map.get(1200), 10200);
});

test('clone creates every item for a confirmed count and rejects unsafe requests', async (t) => {
  withEnv(t);
  const { default: handler, CLONE_HARD_MAX_MESSAGES } = await import('../server/admin/clone.js');
  assert.equal(CLONE_HARD_MAX_MESSAGES, 500);

  let db = fakeDb(baseTables(120));
  global.fetch = db.fetch;
  assert.equal((await post(handler, { source_id: SRC, destination_id: DST }, false)).status, 401);
  let r = await post(handler, { source_id: SRC, destination_id: DST });
  assert.equal(r.status, 409, 'default cap 50 < 120 messages');
  assert.equal(r.body.error, 'clone_exceeds_confirmed_count');
  assert.equal(db.tables.tgcloner_clone_jobs.length, 0, 'nothing created when rejected');

  r = await post(handler, { source_id: SRC, destination_id: DST, max_messages: 120 });
  assert.equal(r.status, 200);
  assert.equal(r.body.copy_items, 120);
  assert.equal(db.tables.tgcloner_clone_job_items.length, 120);

  r = await post(handler, { source_id: SRC, destination_id: DST, max_messages: 120 });
  assert.equal(r.body.error, 'clone_job_already_active', 'no second job for the same pair while one is open');

  for (const bad of [0, -1, 501, 1.5, 'abc']) {
    r = await post(handler, { source_id: SRC, destination_id: DST, max_messages: bad });
    assert.equal(r.status, 400, `max_messages ${bad}`);
  }
});

test('clone guard: hard limit, empty source, missing rows, same channel, other source, allowlist', async (t) => {
  withEnv(t);
  const { default: handler } = await import('../server/admin/clone.js');
  const ask = { source_id: SRC, destination_id: DST, max_messages: 500 };

  let db = fakeDb(baseTables(1500));
  global.fetch = db.fetch;
  let r = await post(handler, ask);
  assert.equal(r.body.error, 'clone_exceeds_hard_limit');
  assert.equal(r.body.source_messages, 1500, 'the count is exact, not the capped row count');

  global.fetch = fakeDb(baseTables(0)).fetch;
  assert.equal((await post(handler, ask)).body.error, 'clone_source_empty');

  const sameChat = baseTables(3); sameChat.tgcloner_destinations[0].chat_id = '-1001';
  global.fetch = fakeDb(sameChat).fetch;
  assert.equal((await post(handler, ask)).body.error, 'destination_is_source');

  const bound = baseTables(3); bound.tgcloner_destinations[0].source_id = 'other-source';
  global.fetch = fakeDb(bound).fetch;
  assert.equal((await post(handler, ask)).body.error, 'destination_bound_to_other_source');

  global.fetch = fakeDb(baseTables(3)).fetch;
  assert.equal((await post(handler, { ...ask, source_id: 'missing' })).status, 404);
  assert.equal((await post(handler, { ...ask, destination_id: 'missing' })).status, 404);

  process.env.READER_CHANNEL_ALLOWLIST = '-1009999';
  db = fakeDb(baseTables(3));
  global.fetch = db.fetch;
  r = await post(handler, ask);
  assert.equal(r.status, 403);
  assert.equal(db.calls.filter(c => c.method === 'POST').length, 0);
});

test('clone guard: live mirror does not block, stale full clone does not block, other source channels are refused', async (t) => {
  withEnv(t);
  const { default: handler } = await import('../server/admin/clone.js');
  const ask = { source_id: SRC, destination_id: DST, max_messages: 10 };
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  let tables = baseTables(3);
  tables.tgcloner_clone_jobs.push({ id: 'live', source_id: SRC, destination_id: DST, mode: 'live_mirror', status: 'queued', updated_at: recent });
  global.fetch = fakeDb(tables).fetch;
  assert.equal((await post(handler, ask)).status, 200, 'a queued live_mirror job is not a full clone');

  tables = baseTables(3);
  tables.tgcloner_clone_jobs.push({ id: 'stuck', source_id: SRC, destination_id: DST, mode: 'full_clone', status: 'running', updated_at: old });
  global.fetch = fakeDb(tables).fetch;
  assert.equal((await post(handler, ask)).status, 200, 'a full clone untouched for over an hour does not block forever');

  tables = baseTables(3);
  tables.tgcloner_sources.push({ id: 'other', chat_id: '-1002', username: null });
  global.fetch = fakeDb(tables).fetch;
  assert.equal((await post(handler, ask)).body.error, 'destination_is_source', 'destination is another registered source channel');

  tables = baseTables(3);
  tables.tgcloner_message_mappings = [{ id: 'mm', source_id: 'other', destination_id: DST, source_message_id: 1, status: 'copied' }];
  global.fetch = fakeDb(tables).fetch;
  assert.equal((await post(handler, ask)).body.error, 'destination_has_other_source_posts');
});

test('verify reads every message and mapping past the cap', async (t) => {
  withEnv(t);
  const tables = baseTables(1500);
  tables.tgcloner_destinations[0].source_id = SRC;
  tables.tgcloner_message_mappings = Array.from({ length: 1500 }, (_, i) => ({ source_id: SRC, destination_id: DST, source_message_id: i + 1, destination_message_id: 5000 + i, status: 'copied' }))
    .filter(m => m.source_message_id !== 1200);
  tables.tgcloner_internal_links = [];
  global.fetch = fakeDb(tables).fetch;
  const { default: handler } = await import('../server/admin/verify.js');
  const res = await new Promise((resolve) => {
    const out = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    handler({ method: 'GET', query: { destination_id: DST }, headers: { cookie: createSessionCookie().split(';')[0] } }, out);
  });
  assert.equal(res.status, 200);
  assert.match(JSON.stringify(res.body), /1200/, 'the missing message past the cap is reported');
});

test('dashboard clone button sends the count the admin confirmed', () => {
  const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /max_messages:Math\.min\(Number\(source\.indexed_message_count\)\|\|0,500\)/);
});
