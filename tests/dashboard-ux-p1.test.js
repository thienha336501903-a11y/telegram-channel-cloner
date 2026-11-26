import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSessionCookie } from '../lib/auth.js';

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('P1 labels: source count is not called MASTER; role is MASTER or Nguồn', () => {
  assert.match(page, /<div class="label">Kênh nguồn<\/div><div class="metric" id="mSources">/);
  assert.match(page, /id="mMaster"/);
  assert.doesNotMatch(page, /<div class="label">Nguồn MASTER<\/div>/);
  assert.match(page, /'<span class="pill">Nguồn<\/span>'/);
  assert.doesNotMatch(page, /'<span class="pill">Nguồn V4<\/span>'/);
});

test('P1 done import shows what was saved, not a progress percentage', () => {
  assert.match(page, /if\(j\.status==='done'\)return `<span>Đã đọc xong · lưu \$\{amount\(j\.message_count\?\?0\)\} bài/);
  assert.match(page, /Math\.min\(99,/);
  assert.doesNotMatch(page, /j\.status==='done'\?100:99/);
});

test('P1 Clone never falls back to the first source and asks for the destination chat id', () => {
  assert.doesNotMatch(page, /find\(s=>s\.active\)\|\|state\?\.sources\?\.\[0\]/);
  assert.match(page, /masters\.length!==1/);
  assert.match(page, /window\.prompt\(`Clone toàn bộ sẽ ĐĂNG/);
});

test('P1 dangerous actions ask first: MASTER switch, run tick, webhook', () => {
  assert.match(page, /window\.prompt\(`Đổi MASTER:/);
  assert.match(page, /confirm\('Chạy 1 nhịp queue sẽ ĐĂNG BÀI THẬT/);
  assert.match(page, /confirm\('Kết nối lại Webhook/);
  assert.match(page, /<details class="advanced"><summary>Nâng cao: đổi kênh MASTER<\/summary>/);
});

test('P1 summary returns agents without token_hash and reader warnings', async (t) => {
  const old = { fetch: global.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY, legacy: process.env.SUPABASE_SERVICE_ROLE_KEY, session: process.env.SESSION_SECRET };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = ['sb', 'secret', 'summary_p1_test_key'].join('_');
  process.env.SESSION_SECRET = 'p1-test-session-secret-0123456789abcdef';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    global.fetch = old.fetch;
    for (const [name, value] of [['SUPABASE_URL', old.url], ['SUPABASE_SECRET_KEY', old.key], ['SUPABASE_SERVICE_ROLE_KEY', old.legacy], ['SESSION_SECRET', old.session]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const now = Date.now();
  const urls = [];
  global.fetch = async (url, init) => {
    // Paged reads: later pages are empty; exact counts come from HEAD + content-range.
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': '*/0' } });
    if (/[?&]offset=[1-9]/.test(String(url))) return new Response('[]', { status: 200 });
    const u = String(url); urls.push(u);
    const table = u.split('/rest/v1/')[1].split('?')[0];
    const rows = {
      tgcloner_sources: [{ id: 's1', title: 'A', chat_id: '-1001', active: true }, { id: 's2', title: 'B', chat_id: '-1002', active: false }],
      tgcloner_reader_jobs: [
        { id: 'j1', source_id: 's2', status: 'failed', error_code: 'flood_wait', created_at: new Date(now).toISOString() },
        { id: 'j2', source_id: 's1', status: 'queued', requested_at: new Date(now - 20 * 60 * 1000).toISOString() },
        { id: 'j3', source_id: 's1', status: 'queued', requested_at: new Date(now - 60 * 1000).toISOString() }
      ],
      tgcloner_reader_agents: [{ id: 'a1', display_name: 'PC', status: 'online', last_seen_at: new Date(now - 30 * 1000).toISOString(), revoked_at: null }]
    }[table] || [];
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const { default: handler } = await import('../server/admin/summary.js');
  let body;
  const res = { statusCode: 0, setHeader() {}, end(text) { body = JSON.parse(text); }, status(code) { this.statusCode = code; return this; } };
  await handler({ headers: { cookie: createSessionCookie().split(';')[0] }, method: 'GET' }, res);
  assert.ok(body, 'handler replied');
  assert.equal(body.counts.master_sources, 1);
  assert.equal(body.counts.agents_online, 1);
  assert.equal(body.agents[0].online, true);
  assert.ok(urls.some(u => u.includes('tgcloner_reader_agents') && !u.includes('token_hash')), 'agents query never selects token_hash');
  assert.deepEqual(body.reader_warnings.map(w => w.job_id).sort(), ['j1', 'j2']);
  assert.equal(body.reader_warnings.find(w => w.job_id === 'j1').error, 'flood_wait');
});

test('P1 summary survives an unreadable agents table and ignores superseded import failures', async (t) => {
  const old = { fetch: global.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY, legacy: process.env.SUPABASE_SERVICE_ROLE_KEY, session: process.env.SESSION_SECRET };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = ['sb', 'secret', 'summary_p1_test_key'].join('_');
  process.env.SESSION_SECRET = 'p1-test-session-secret-0123456789abcdef';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    global.fetch = old.fetch;
    for (const [name, value] of [['SUPABASE_URL', old.url], ['SUPABASE_SECRET_KEY', old.key], ['SUPABASE_SERVICE_ROLE_KEY', old.legacy], ['SESSION_SECRET', old.session]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  global.fetch = async (url, init) => {
    // Paged reads: later pages are empty; exact counts come from HEAD + content-range.
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': '*/0' } });
    if (/[?&]offset=[1-9]/.test(String(url))) return new Response('[]', { status: 200 });
    const table = String(url).split('/rest/v1/')[1].split('?')[0];
    if (table === 'tgcloner_reader_agents') return new Response(JSON.stringify({ message: 'relation does not exist' }), { status: 404 });
    const rows = {
      tgcloner_sources: [{ id: 's1', title: 'A', chat_id: '-1001', active: true }],
      // newest first: a successful re-import after an older failure
      tgcloner_reader_jobs: [{ id: 'new', source_id: 's1', status: 'done', message_count: 5 }, { id: 'old', source_id: 's1', status: 'failed', error_code: 'x' }]
    }[table] || [];
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const { default: handler } = await import('../server/admin/summary.js');
  let body;
  const res = { statusCode: 0, setHeader() {}, end(text) { body = JSON.parse(text); } };
  await handler({ headers: { cookie: createSessionCookie().split(';')[0] }, method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(body.agents, null);
  assert.equal(body.counts.agents_online, null);
  assert.deepEqual(body.reader_warnings, []);
});
