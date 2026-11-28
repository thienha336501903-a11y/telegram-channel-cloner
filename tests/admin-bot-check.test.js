import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCookie } from '../lib/auth.js';
import handler from '../server/admin/bot-check.js';
import router from '../api/admin.js';

const TOKEN = '123456789:AAFakeTokenForBotCheckTestOnly_abcdefghij';

function response() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; }
  };
}

function setup(t, replies) {
  const oldFetch = global.fetch;
  const oldEnv = { SESSION_SECRET: process.env.SESSION_SECRET, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN };
  process.env.SESSION_SECRET = 'bot-check-test-session';
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  const calls = [];
  global.fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    calls.push({ method, body: JSON.parse(init.body) });
    const payload = replies[method];
    return { ok: payload.ok, json: async () => payload };
  };
  t.after(() => {
    global.fetch = oldFetch;
    for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  return { calls, headers: { cookie: createSessionCookie().split(';')[0] } };
}

const ME = { ok: true, result: { id: 42, is_bot: true, username: 'some_bot', first_name: 'Bot', can_join_groups: true } };

test('bot-check needs an admin session and GET', async (t) => {
  const { calls, headers } = setup(t, { getMe: ME });
  const anon = response();
  await handler({ method: 'GET', headers: {}, query: {} }, anon);
  assert.equal(anon.statusCode, 401);
  const post = response();
  await handler({ method: 'POST', headers, query: {} }, post);
  assert.equal(post.statusCode, 405);
  const bad = response();
  await handler({ method: 'GET', headers, query: { chat_id: '123' } }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('bot-check returns only bot identity and chat rights, never the token', async (t) => {
  const member = { ok: true, result: { status: 'administrator', user: { id: 42 }, can_post_messages: true, can_edit_messages: true, can_pin_messages: false, can_invite_users: true } };
  const { calls, headers } = setup(t, { getMe: ME, getChatMember: member });

  const only = response();
  await router({ method: 'GET', headers, query: { action: 'bot-check' } }, only);
  assert.equal(only.statusCode, 200);
  assert.deepEqual(JSON.parse(only.body), { ok: true, bot: { id: 42, username: 'some_bot', first_name: 'Bot' } });

  const res = response();
  await handler({ method: 'GET', headers, query: { chat_id: '-1004492904064' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).member, {
    status: 'administrator', can_post_messages: true, can_edit_messages: true, can_pin_messages: false, can_delete_messages: false, can_manage_chat: false
  });
  assert.deepEqual(calls.map((c) => c.method), ['getMe', 'getMe', 'getChatMember']);
  assert.deepEqual(calls[2].body, { chat_id: '-1004492904064', user_id: 42 });
  assert.ok(![only.body, res.body].some((b) => b.includes(TOKEN.split(':')[1])));
});

test('bot-check reports a Telegram error as 502 without the token', async (t) => {
  const { headers } = setup(t, { getMe: ME, getChatMember: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });
  const res = response();
  await handler({ method: 'GET', headers, query: { chat_id: '-1004492904064' } }, res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'telegram_error', method: 'getChatMember', description: 'Bad Request: chat not found' });
});
