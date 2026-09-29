import test from 'node:test';
import assert from 'node:assert/strict';
import { linksForNormalizedMessage, normalizeBotChannelPost } from '../lib/source-message.js';

test('normalizes channel post without losing 64-bit-ish chat id as string', () => {
  const m = normalizeBotChannelPost({ message_id: 10, date: 1700000000, chat: { id: -1004296153365, type: 'channel', title: 'Master' }, text: 'Hello', entities: [] });
  assert.equal(m.source_chat_id, '-1004296153365');
  assert.equal(m.source_message_id, 10);
  assert.equal(m.message_type, 'text');
  assert.equal(m.source_private_link_id, '4296153365');
});

test('detects hidden text_link as an internal source link', () => {
  const m = normalizeBotChannelPost({
    message_id: 11,
    date: 1700000000,
    chat: { id: -1004296153365, type: 'channel', title: 'Master' },
    text: 'Bài 1',
    entities: [{ type: 'text_link', offset: 0, length: 5, url: 'https://t.me/c/4296153365/10' }]
  });
  const links = linksForNormalizedMessage(m, { private_link_id: '4296153365' });
  assert.equal(links.length, 1);
  assert.equal(links[0].source_message_id, 10);
  assert.equal(links[0].location, 'text');
});
