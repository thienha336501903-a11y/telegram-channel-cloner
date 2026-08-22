// Regression scope: V4 source registration must never switch the clone/mirror MASTER.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const router = fs.readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');
const handler = fs.readFileSync(new URL('../server/admin/v4-source.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const links = fs.readFileSync(new URL('../lib/links.js', import.meta.url), 'utf8');

test('admin router exposes dedicated V4 source registration', () => {
  assert.match(router, /v4-source\.js/);
  assert.match(router, /'v4-source': v4SourceHandler/);
});

test('V4 source registration is authenticated and validates a Telegram channel', () => {
  assert.match(handler, /isAuthenticated\(req\)/);
  assert.match(handler, /normalizeTelegramSourceRef\(body\.source_ref \|\| body\.chat_id\)/);
  assert.match(handler, /getChat\(sourceRef\.chatId\)/);
  assert.match(handler, /source_must_be_channel/);
  assert.match(handler, /getSourceByChatId\(chat\.id\)/);
});

test('V4 source registration accepts one public or private Telegram post link', () => {
  assert.match(links, /export function normalizeTelegramSourceRef/);
  assert.match(links, /`-100\$\{parts\[1\]\}`/);
  assert.match(links, /kind: 'public_post'/);
  assert.match(handler, /source_message_id: sourceRef\.messageId/);
  assert.match(page, /source_ref:sourceRef/);
  assert.match(page, /sourceRef/);
});

test('V4 registration never switches clone mirror MASTER', () => {
  assert.match(handler, /active: Boolean\(existing\?\.active\)/);
  assert.doesNotMatch(handler, /patch\(TABLES\.sources/);
  assert.match(handler, /mirror_master: Boolean\(existing\?\.active\)/);
});

test('Cloner admin exposes a separate V4 source form', () => {
  assert.match(page, /id="registerV4Source"/);
  assert.match(page, /id="v4SourceChatId"/);
  assert.match(page, /\/api\/admin\/v4-source/);
  assert.match(page, /Đăng ký nguồn V4/);
  assert.match(page, /Nguồn V4/);
  assert.match(page, /mode.*v4-source/);
});
