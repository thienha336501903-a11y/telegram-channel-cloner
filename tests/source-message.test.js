import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBotChannelPost } from '../lib/source-message.js';

test('normalizes channel post without losing 64-bit-ish chat id as string', () => {
  const m = normalizeBotChannelPost({ message_id: 10, date: 1700000000, chat: { id: -1004296153365, type: 'channel', title: 'Master' }, text: 'Hello', entities: [] });
  assert.equal(m.source_chat_id, '-1004296153365');
  assert.equal(m.source_message_id, 10);
  assert.equal(m.message_type, 'text');
  assert.equal(m.source_private_link_id, '4296153365');
});
