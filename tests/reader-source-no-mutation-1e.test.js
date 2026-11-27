import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSessionCookie } from '../lib/auth.js';

// 1E: the bot never posts into a source channel unless TGCLONER_READER_ALLOW_SOURCE_MUTATION=true,
// a message without a usable descriptor is skipped (not the whole batch), an earlier hydrated copy
// is kept, and no registered source channel can be registered as a destination.
const SRC = '11111111-1111-1111-1111-111111111111';
const NAMES = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_BOT_TOKEN', 'READER_INGEST_SECRET',
  'READER_CHANNEL_ALLOWLIST', 'SESSION_SECRET', 'TGCLONER_READER_NO_SOURCE_MUTATION', 'TGCLONER_READER_ALLOW_SOURCE_MUTATION'];

function withEnv(t, extra = {}) {
  const old = Object.fromEntries(NAMES.map(n => [n, process.env[n]]));
  const oldFetch = global.fetch;
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: ['sb', 'secret', 'ingest_1e_test_key'].join('_'),
    TELEGRAM_BOT_TOKEN: '123:test',
    READER_INGEST_SECRET: 'ingest-1e-secret-0123456789abcdef',
    SESSION_SECRET: '1e-test-session-secret-0123456789abcdef'
  }, extra);
  t.after(() => {
    global.fetch = oldFetch;
    for (const n of NAMES) { if (old[n] === undefined) delete process.env[n]; else process.env[n] = old[n]; }
  });
}

function fake({ existingRaw = null, sourceChatIds = [], chat = null } = {}) {
  const telegramCalls = [];
  const savedRaw = [];
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    if (u.hostname === 'api.telegram.org') {
      const tgMethod = u.pathname.split('/').pop();
      telegramCalls.push(tgMethod);
      if (tgMethod === 'getChat') return Response.json({ ok: true, result: chat });
      return Response.json({ ok: true, result: { message_id: 777 } });
    }
    const table = u.pathname.split('/rest/v1/')[1];
    if (table === 'tgcloner_sources' && method === 'GET') {
      const chatFilter = u.searchParams.get('chat_id');
      if (u.searchParams.get('active') === 'eq.true') return Response.json([{ id: SRC, chat_id: '-1001' }]);
      if (chatFilter) return Response.json(sourceChatIds.includes(chatFilter.replace('eq.', '')) ? [{ id: 'other' }] : []);
      return Response.json([{ id: SRC, chat_id: '-1001', username: null }]);
    }
    if (table === 'tgcloner_source_messages' && method === 'GET') return Response.json(existingRaw ? [{ raw_message: existingRaw }] : []);
    if (table === 'tgcloner_source_messages' && method === 'POST') {
      savedRaw.push(JSON.parse(init.body).raw_message);
      return Response.json([{ id: 'row-1' }], { status: 201 });
    }
    if (table === 'tgcloner_destinations' && method === 'POST') return Response.json([{ id: 'dest-1' }], { status: 201 });
    if (method === 'GET') return Response.json([]);
    return new Response(method === 'PATCH' ? '[]' : null, { status: method === 'POST' ? 201 : 200 });
  };
  return { telegramCalls, savedRaw };
}

function post(handler, body, headers) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.headers = headers;
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const ingestHeaders = () => ({ authorization: `Bearer ${process.env.READER_INGEST_SECRET}` });
const batch = {
  source_id: SRC,
  messages: [
    { source_message_id: 5, message_type: 'photo', raw_message: { from_reader: true } },
    { source_message_id: 6, message_type: 'text', text: 'hi', raw_message: { from_reader: true } }
  ]
};

test('default: no Telegram call, whole batch saved, media counted as skipped', async (t) => {
  withEnv(t);
  const db = fake();
  const { default: handler } = await import('../api/reader/ingest.js');
  const r = await post(handler, batch, ingestHeaders());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(db.telegramCalls, []);
  assert.equal(r.body.saved, 2);
  assert.equal(r.body.hydration_attempts, 0);
  assert.equal(r.body.hydration_skipped_no_source_mutation, 1);
});

test('default: an earlier hydrated copy is kept, not overwritten', async (t) => {
  withEnv(t);
  const hydrated = { from_reader: true, from_history_self_forward: true, photo: [{ file_id: 'kept', file_size: 10 }] };
  const db = fake({ existingRaw: hydrated });
  const { default: handler } = await import('../api/reader/ingest.js');
  const r = await post(handler, batch, ingestHeaders());
  assert.equal(r.status, 200);
  assert.deepEqual(db.savedRaw[0], hydrated);
  assert.deepEqual(db.savedRaw[1], { from_reader: true });
});

test('ALLOW=true with NO_SOURCE_MUTATION=true stays fail-closed (409, no Telegram call)', async (t) => {
  withEnv(t, { TGCLONER_READER_ALLOW_SOURCE_MUTATION: 'true', TGCLONER_READER_NO_SOURCE_MUTATION: 'true' });
  const db = fake();
  const { default: handler } = await import('../api/reader/ingest.js');
  const r = await post(handler, batch, ingestHeaders());
  assert.equal(r.status, 409);
  assert.deepEqual(db.telegramCalls, []);
});

test('ALLOW=true keeps the legacy hydration path', async (t) => {
  withEnv(t, { TGCLONER_READER_ALLOW_SOURCE_MUTATION: 'true' });
  const db = fake();
  const { default: handler } = await import('../api/reader/ingest.js');
  const r = await post(handler, batch, ingestHeaders());
  assert.equal(r.status, 200);
  assert.deepEqual(db.telegramCalls, ['forwardMessage', 'deleteMessage']);
  assert.equal(r.body.hydration_skipped_no_source_mutation, 0);
});

test('destination registration rejects any registered source channel', async (t) => {
  withEnv(t);
  const cookie = createSessionCookie().split(';')[0];
  const { default: handler } = await import('../server/admin/destinations.js');
  fake({ sourceChatIds: ['-1002'], chat: { id: -1002, type: 'channel', title: 'Other source' } });
  const blocked = await post(handler, { chat_id: '-1002' }, { cookie });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error, 'destination_cannot_equal_source');
  fake({ sourceChatIds: ['-1002'], chat: { id: -1003, type: 'channel', title: 'New destination' } });
  const ok = await post(handler, { chat_id: '-1003' }, { cookie });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});
