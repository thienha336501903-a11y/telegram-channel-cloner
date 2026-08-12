import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConsistency } from '../lib/consistency.js';

test('consistency passes when every message and link target is mapped', () => {
  const report = evaluateConsistency({
    messages: [
      { source_message_id: 1, media_group_id: null, is_pinned: false },
      { source_message_id: 2, media_group_id: 'album-a', is_pinned: true },
      { source_message_id: 3, media_group_id: 'album-a', is_pinned: false }
    ],
    mappings: [
      { source_message_id: 1, destination_message_id: 101, status: 'copied' },
      { source_message_id: 2, destination_message_id: 102, status: 'copied' },
      { source_message_id: 3, destination_message_id: 103, status: 'copied' }
    ],
    internalLinks: [{ source_message_id: 2 }]
  });
  assert.equal(report.pass, true);
  assert.deepEqual(report.missing_message_ids, []);
  assert.deepEqual(report.unresolved_link_targets, []);
  assert.deepEqual(report.incomplete_albums, []);
});

test('consistency reports missing messages, links, pins and albums', () => {
  const report = evaluateConsistency({
    messages: [
      { source_message_id: 1, media_group_id: null, is_pinned: false },
      { source_message_id: 2, media_group_id: 'album-a', is_pinned: true },
      { source_message_id: 3, media_group_id: 'album-a', is_pinned: false }
    ],
    mappings: [{ source_message_id: 1, destination_message_id: 101, status: 'copied' }],
    internalLinks: [{ source_message_id: 2 }]
  });
  assert.equal(report.pass, false);
  assert.deepEqual(report.missing_message_ids, [2, 3]);
  assert.deepEqual(report.unresolved_link_targets, [2]);
  assert.deepEqual(report.missing_pinned_ids, [2]);
  assert.equal(report.incomplete_albums.length, 1);
});
