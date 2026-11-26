import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

// 1B: every temporary post the bot makes in a source channel during hydration leaves a sync event,
// including when the clean-up delete fails, and recording never breaks the ingest.
const SRC = '11111111-1111-1111-1111-111111111111';

function withEnv(t, extra = {}) {
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_BOT_TOKEN', 'READER_INGEST_SECRET', 'READER_CHANNEL_ALLOWLIST', 'TGCLONER_READER_NO_SOURCE_MUTATION'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  const oldFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = ['sb', 'secret', 'ingest_1b_test_key'].join('_');
  process.env.TELEGRAM_BOT_TOKEN = '123:test';
  process.env.READER_INGEST_SECRET = 'ingest-1b-secret-0123456789abcdef';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.READER_CHANNEL_ALLOWLIST;
  delete process.env.TGCLONER_READER_NO_SOURCE_MUTATION;
  Object.assign(process.env, extra);
  t.after(() => {
    global.fetch = oldFetch;
    for (const n of names) { if (old[n] === undefined) delete process.env[n]; else process.env[n] = old[n]; }
  });
}

function fake({ deleteFails = false, eventFails = false } = {}) {
  const events = [];
  const telegramCalls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      const method = u.split('/').pop();
      telegramCalls.push(method);
      if (method === 'forwardMessage') return Response.json({ ok: true, result: { message_id: 777, chat: { id: -1001 }, photo: [{ file_id: 'x', file_size: 10 }] } });
      if (method === 'deleteMessage') return deleteFails ? Response.json({ ok: false, error_code: 400, description: 'message to delete not found' }, { status: 400 }) : Response.json({ ok: true, result: true });
      return Response.json({ ok: true, result: true });
    }
    const table = u.split('/rest/v1/')[1].split('?')[0];
    const method = init.method || 'GET';
    if (table === 'tgcloner_sync_events' && method === 'POST') {
      if (eventFails) return new Response('{"message":"down"}', { status: 500 });
      events.push(JSON.parse(init.body));
      return new Response(null, { status: 201 });
    }
    if (table === 'tgcloner_sources' && method === 'GET') return Response.json([{ id: SRC, chat_id: '-1001', username: null }]);
    if (table === 'tgcloner_source_messages' && method === 'POST') return Response.json([{ id: 'row-1' }], { status: 201 });
    if (method === 'GET') return Response.json([]);
    return new Response(method === 'PATCH' ? '[]' : null, { status: method === 'POST' ? 201 : 200 });
  };
  return { fetch, events, telegramCalls };
}

function postIngest(handler, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.headers = { authorization: `Bearer ${process.env.READER_INGEST_SECRET}` };
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const photoWithoutDescriptor = { source_id: SRC, messages: [{ source_message_id: 5, message_type: 'photo', raw_message: { from_reader: true } }] };

test('hydration records a removed temporary post', async (t) => {
  withEnv(t);
  const db = fake();
  global.fetch = db.fetch;
  const { default: handler } = await import('../api/reader/ingest.js');
  const r = await postIngest(handler, photoWithoutDescriptor);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(db.telegramCalls, ['forwardMessage', 'deleteMessage']);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, 'reader_source_temp_post_removed');
  assert.equal(db.events[0].source_message_id, 5);
  assert.equal(db.events[0].payload.temp_message_id, 777);
});

test('a failed clean-up records a left-over post', async (t) => {
  withEnv(t);
  const db = fake({ deleteFails: true });
  global.fetch = db.fetch;
  const { default: handler } = await import('../api/reader/ingest.js');
  const r = await postIngest(handler, photoWithoutDescriptor);
  assert.equal(r.status, 200);
  assert.equal(db.events[0].event_type, 'reader_source_temp_post_left');
  assert.ok(db.events[0].payload.delete_error);
});

test('event recording failure does not fail the ingest', async (t) => {
  withEnv(t);
  const db = fake({ eventFails: true });
  global.fetch = db.fetch;
  const { default: handler } = await import('../api/reader/ingest.js');
  const r = await postIngest(handler, photoWithoutDescriptor);
  assert.equal(r.status, 200);
  assert.equal(r.body.saved, 1);
});

test('no source mutation: no forward, no event', async (t) => {
  withEnv(t, { TGCLONER_READER_NO_SOURCE_MUTATION: 'true' });
  const db = fake();
  global.fetch = db.fetch;
  const { default: handler } = await import('../api/reader/ingest.js');
  const r = await postIngest(handler, photoWithoutDescriptor);
  assert.equal(r.status, 409);
  assert.deepEqual(db.telegramCalls, []);
  assert.equal(db.events.length, 0);
});
