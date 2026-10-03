import test from 'node:test';
import assert from 'node:assert/strict';
import { distributorEventFromUpdate } from '../lib/distributor-webhook.js';

test('Distributor webhook event uses Telegram update_id as durable dedupe key', () => {
  const source = { id: '11111111-1111-1111-1111-111111111111', chat_id: '-1001234567890' };
  const normalized = {
    source_chat_id: '-1001234567890',
    source_message_id: 77,
    source_date: '2026-09-30T12:00:00.000Z',
    media_group_id: null,
    has_internal_links: true,
    raw_message: { date: 1790769600 }
  };
  const event = distributorEventFromUpdate({ update_id: 456, channel_post: { date: 1790769600 } }, source, normalized);
  assert.equal(event.eventKey, 'bot_webhook:update:456');
  assert.equal(event.telegramUpdateId, 456);
  assert.equal(event.origin, 'bot_webhook');
  assert.equal(event.eventKind, 'message_new');
  assert.equal(event.sourceMessageId, 77);
  assert.equal(event.payload.has_internal_links, true);
});

test('Distributor webhook event distinguishes edits without update_id', () => {
  const source = { id: '22222222-2222-2222-2222-222222222222', chat_id: '-1001234567890' };
  const normalized = { source_message_id: 88, raw_message: { edit_date: 1790769660 } };
  const event = distributorEventFromUpdate({ edited_channel_post: { edit_date: 1790769660 } }, source, normalized);
  assert.equal(event.telegramUpdateId, null);
  assert.equal(event.eventKind, 'message_edit');
  assert.equal(event.eventKey, 'bot_webhook:22222222-2222-2222-2222-222222222222:88:message_edit:1790769660');
});
