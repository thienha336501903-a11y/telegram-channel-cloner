import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTelegramSourceRef } from '../lib/links.js';

test('normalizes public Telegram post links to a Bot API username', () => {
  assert.deepEqual(normalizeTelegramSourceRef('https://t.me/yeunauan_channel/123?single'), {
    chatId: '@yeunauan_channel', messageId: 123, kind: 'public_post'
  });
  assert.equal(normalizeTelegramSourceRef('t.me/s/yeunauan_channel/456').chatId, '@yeunauan_channel');
});

test('normalizes private Telegram post links to a Bot API channel id', () => {
  assert.deepEqual(normalizeTelegramSourceRef('https://t.me/c/2043800547/89'), {
    chatId: '-1002043800547', messageId: 89, kind: 'private_post'
  });
});

test('keeps legacy username and numeric chat id inputs compatible', () => {
  assert.equal(normalizeTelegramSourceRef('@yeunauan_channel').chatId, '@yeunauan_channel');
  assert.equal(normalizeTelegramSourceRef('-1002043800547').chatId, '-1002043800547');
});

test('rejects invite links, foreign hosts and malformed post links', () => {
  for (const value of ['https://t.me/+invite', 'https://example.com/channel/12', 'https://t.me/channel', 'not a channel']) {
    assert.throws(() => normalizeTelegramSourceRef(value), /telegram_source_invalid/);
  }
});
