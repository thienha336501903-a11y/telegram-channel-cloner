import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTwoDestinationPreviews } from '../scripts/e2e-local/preview-two-course-index.mjs';

function fixture() {
  const source = { id: 'source-test', chat_id: '-1004320185488', title: 'TEST course', active: false };
  const messages = Array.from({ length: 60 }, (_, index) => ({
    source_message_id: index + 2, message_type: 'text', text: `Bài ${index + 1}`,
    media_group_id: index < 20 ? `album-${Math.floor(index / 2)}` : null
  }));
  const destinations = ['-1003933578709', '-1004492904064'].map((chat_id, destIndex) => {
    const id = `dest-${destIndex}`;
    return {
      destination: { id, source_id: source.id, chat_id, active: false },
      runs: [{ id: `run-${destIndex}`, source_id: source.id, destination_id: id,
        status: 'active', phase: 'ready_for_new', verified_at: '2026-10-03T09:40:43Z',
        manifest_closed_at: '2026-10-03T04:09:36Z', high_watermark: 60,
        unsafe_work: 0, manifest_ids: messages.slice(0, 59).map(m => m.source_message_id) }],
      mappings: messages.map((m, i) => ({ source_message_id: m.source_message_id,
        destination_message_id: i + (destIndex ? 80 : 8), status: 'copied' }))
    };
  });
  return { source, messages, destinations };
}

test('previews the 60-post course separately for both TEST destinations without a send', () => {
  const previews = buildTwoDestinationPreviews(fixture(), { appendixStartSourceId: 42 });
  assert.equal(previews.length, 2);
  assert.deepEqual(previews.map(row => row.index.postCount), [60, 60]);
  assert.deepEqual(previews.map(row => row.index.albumCount), [10, 10]);
  assert.notEqual(previews[0].index.hash, previews[1].index.hash);
  for (const row of previews) {
    assert.ok(row.index.text.includes('PHỤ LỤC'));
    assert.ok(row.index.entities.every(entity => entity.url.includes(row.destination.slice(4))));
    assert.ok(row.index.entries.every(entry => entry.url.includes(row.destination.slice(4))));
  }
});

test('blocks a changed run, baseline, or duplicated destination mapping before preview', () => {
  const unready = fixture();
  unready.destinations[1].runs[0].phase = 'catching_up';
  assert.throws(() => buildTwoDestinationPreviews(unready), /verified, clean/);
  const drift = fixture();
  drift.destinations[0].runs[0].manifest_ids.pop();
  assert.throws(() => buildTwoDestinationPreviews(drift), /verified, clean/);
  const duplicate = fixture();
  duplicate.destinations[0].mappings.push({ ...duplicate.destinations[0].mappings[0] });
  assert.throws(() => buildTwoDestinationPreviews(duplicate), /Mappings must be unique/);
});
