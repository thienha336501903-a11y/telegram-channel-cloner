import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishRows, pinMatches, pinnedIndexHash, validateState } from '../scripts/e2e-local/publish-two-course-index.mjs';

function fixture() {
  const source = { id: 'source-test', chat_id: '-1004320185488', title: 'TEST course', active: false };
  const messages = Array.from({ length: 60 }, (_, index) => ({
    source_message_id: index + 2, message_type: 'text', text: `Bài ${index + 1}`,
    media_group_id: index < 20 ? `album-${Math.floor(index / 2)}` : null
  }));
  messages.push({ source_message_id: 62, message_type: 'text', text: 'TEST DISTRIBUTOR V2 ONE POST', media_group_id: null });
  const destinations = ['-1003933578709', '-1004492904064'].map((chat_id, destIndex) => {
    const id = `dest-${destIndex}`;
    return {
      destination: {
        id, source_id: source.id, chat_id, active: false,
        course_index_message_id: null, course_index_content_hash: null, course_index_high_watermark: null
      },
      runs: [{
        id: `run-${destIndex}`, source_id: source.id, destination_id: id,
        status: 'active', phase: 'ready_for_new', verified_at: '2026-10-04T03:26:24Z',
        manifest_closed_at: '2026-10-03T04:09:36Z', high_watermark: 60, unsafe_work: 0,
        manifest_ids: messages.filter((m) => m.source_message_id <= 60).map((m) => m.source_message_id)
      }],
      mappings: messages.map((m, i) => ({
        source_message_id: m.source_message_id, destination_message_id: i + (destIndex ? 70 : 8), status: 'copied'
      }))
    };
  });
  return { source, messages, destinations };
}

test('builds separate first-publish rows for the verified 61-post destinations', () => {
  const rows = buildPublishRows(fixture());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.index.postCount), [61, 61]);
  assert.deepEqual(rows.map((row) => row.index.highWatermark), [62, 62]);
  assert.notEqual(rows[0].index.hash, rows[1].index.hash);
});

test('ledger validation blocks ambiguous send and content drift', () => {
  const row = buildPublishRows(fixture())[0];
  assert.equal(validateState(null, row), null);
  assert.throws(() => validateState({
    version: 1, sourceChatId: '-1004320185488', destinationChatId: row.destination,
    runId: row.runId, phase: 'armed', contentHash: row.index.hash
  }, row), /ambiguous/);
  assert.throws(() => validateState({
    version: 1, sourceChatId: '-1004320185488', destinationChatId: row.destination,
    runId: row.runId, phase: 'published', messageId: 999, contentHash: '0'.repeat(64)
  }, row), /content changed/);
});

test('pinned-message verification requires exact text-link entities', () => {
  const row = buildPublishRows(fixture())[0];
  const messageId = 999;
  const pinned = {
    message_id: messageId, text: row.index.text,
    entities: row.index.entities.map((entity) => ({ ...entity }))
  };
  assert.equal(pinMatches({ pinned_message: pinned }, row.index, messageId), true);
  pinned.entities[0].url += '-wrong';
  assert.equal(pinMatches({ pinned_message: pinned }, row.index, messageId), false);
});


test('explicit TEST update mode accepts only a published ledger with content drift', () => {
  const row = buildPublishRows(fixture())[0];
  const state = {
    version: 1, sourceChatId: '-1004320185488', destinationChatId: row.destination,
    runId: row.runId, phase: 'published', messageId: 69, highWatermark: 62,
    contentHash: '8fb4d444dadb850945e8b0bfbd7fe0ff64419a98b9a436ad752ed845e077549f'
  };
  assert.equal(validateState(state, row, { allowContentUpdate: true }), state);
  assert.throws(() => validateState({ ...state, phase: 'known_failure' }, row, { allowContentUpdate: true }), /unsafe/);
});

test('pinned index hash normalizes Bot API text-link entities', () => {
  const row = buildPublishRows(fixture())[0];
  const pinned = {
    message_id: 69,
    text: row.index.text,
    entities: row.index.entities.map((entity) => ({ ...entity }))
  };
  assert.equal(pinnedIndexHash({ pinned_message: pinned }, 69), row.index.hash);
  pinned.text += ' changed';
  assert.notEqual(pinnedIndexHash({ pinned_message: pinned }, 69), row.index.hash);
});
