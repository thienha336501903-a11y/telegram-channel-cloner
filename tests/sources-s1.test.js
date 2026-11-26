import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSessionCookie } from '../lib/auth.js';

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');

function withEnv(t, extra = {}) {
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'READER_CHANNEL_ALLOWLIST'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  const oldFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = ['sb', 'secret', 's1_test_key'].join('_');
  process.env.SESSION_SECRET = 's1-test-session-secret-0123456789abcdef';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.READER_CHANNEL_ALLOWLIST;
  Object.assign(process.env, extra);
  t.after(() => {
    global.fetch = oldFetch;
    for (const n of names) { if (old[n] === undefined) delete process.env[n]; else process.env[n] = old[n]; }
  });
}
function call(handler, query, cookie = true) {
  return new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    handler({ method: 'GET', query, headers: cookie ? { cookie: createSessionCookie().split(';')[0] } : {} }, res);
  });
}
const ID = '11111111-2222-3333-4444-555555555555';

test('S1 router exposes source-detail', () => {
  assert.match(admin, /'source-detail': sourceDetailHandler/);
});

test('S1 source-detail: auth, id validation, not found', async (t) => {
  withEnv(t);
  const urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return new Response('[]', { status: 200 }); };
  const { default: handler } = await import('../server/admin/source-detail.js');
  assert.equal((await call(handler, { id: ID }, false)).status, 401);
  assert.equal((await call(handler, { id: "x' or 1=1" })).status, 400);
  assert.equal(urls.length, 0, 'an invalid id never reaches the database');
  assert.equal((await call(handler, { id: ID })).status, 404);
});

test('S1 source-detail: stats, jobs and allowlist from read-only selects', async (t) => {
  withEnv(t, { READER_CHANNEL_ALLOWLIST: '-1009999' });
  const methods = [];
  global.fetch = async (url, init = {}) => {
    methods.push(init.method || 'GET');
    const table = String(url).split('/rest/v1/')[1].split('?')[0];
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': '0-2/1200' } });
    const rows = {
      tgcloner_sources: [{ id: ID, chat_id: '-1001234', title: 'Kênh A', active: false }],
      tgcloner_source_messages: [
        { message_type: 'photo', media_group_id: 'g1', has_internal_links: false, is_pinned: true, source_date: '2026-01-02T00:00:00Z' },
        { message_type: 'photo', media_group_id: 'g1', has_internal_links: true, is_pinned: false, source_date: '2026-01-01T00:00:00Z' },
        { message_type: 'text', media_group_id: null, has_internal_links: false, is_pinned: false, source_date: '2026-03-01T00:00:00Z' }
      ],
      tgcloner_reader_jobs: [{ id: 'j1', status: 'failed', error_code: 'reader_source_access_denied' }]
    }[table] || [];
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const { default: handler } = await import('../server/admin/source-detail.js');
  const { status, body } = await call(handler, { id: ID });
  assert.equal(status, 200);
  assert.deepEqual(methods.filter(m => m !== 'GET' && m !== 'HEAD'), [], 'only reads (GET + HEAD count)');
  assert.equal(body.messages.total, 1200, 'total comes from the exact count, not the returned rows');
  assert.equal(body.messages.sampled, 3);
  assert.equal(body.messages.truncated, true);
  assert.deepEqual(body.messages.by_type, { photo: 2, text: 1 });
  assert.equal(body.messages.albums, 1);
  assert.equal(body.messages.internal_links, 1);
  assert.equal(body.messages.pinned, 1);
  assert.equal(body.messages.first_post_at, '2026-01-01T00:00:00Z');
  assert.equal(body.messages.last_post_at, '2026-03-01T00:00:00Z');
  assert.deepEqual(body.allowlist, { enabled: true, allowed: false });
  assert.equal(body.jobs[0].error_code, 'reader_source_access_denied');
});

test('S1 UI: search, filter, detail panel, error help, escaped output', () => {
  assert.match(page, /id="sourceSearch"/);
  assert.match(page, /id="sourceFilter"/);
  assert.match(page, /<option value="blocked">Ngoài allowlist<\/option>/);
  assert.match(page, /api\('\/api\/admin\/source-detail\?id='\+encodeURIComponent\(id\)\)/);
  assert.match(page, /reader_source_access_denied:'Tài khoản Telegram của Reader chưa vào được kênh/);
  assert.match(page, /data-detail="\$\{esc\(s\.id\)\}">\$\{esc\(s\.title\|\|'—'\)\}/);
  assert.match(page, /#sources td\[data-label\]::before/);
});
