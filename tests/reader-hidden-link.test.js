import test from 'node:test';
import assert from 'node:assert/strict';
import { linksForNormalizedMessage } from '../lib/source-message.js';

test('Reader-shaped hidden text_link is indexed as an internal Telegram link', () => {
  const source = { private_link_id: '1234567890', username: null };
  const message = {
    text: 'Bấm vào đây để xem video',
    text_entities: [
      { type: 'text_link', offset: 0, length: 11, url: 'https://t.me/c/1234567890/42' }
    ],
    caption: null,
    caption_entities: []
  };
  assert.deepEqual(linksForNormalizedMessage(message, source), [
    {
      source_message_id: 42,
      kind: 'private',
      entity_index: 0,
      full: 'https://t.me/c/1234567890/42',
      location: 'text'
    }
  ]);
});

test('Reader-shaped hidden external text_link is not treated as internal', () => {
  const source = { private_link_id: '1234567890', username: null };
  const message = {
    text: 'Website ngoài',
    text_entities: [
      { type: 'text_link', offset: 0, length: 12, url: 'https://example.com/video' }
    ],
    caption: null,
    caption_entities: []
  };
  assert.deepEqual(linksForNormalizedMessage(message, source), []);
});
