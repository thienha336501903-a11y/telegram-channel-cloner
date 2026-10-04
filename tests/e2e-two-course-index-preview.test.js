import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTwoDestinationPreviews } from '../scripts/e2e-local/preview-two-course-index.mjs';
import { buildCourseIndex } from '../scripts/e2e-local/course-index-core.mjs';

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

test('after exactly one mapped new post, previews both destinations from the retained baseline', () => {
  const data = fixture();
  data.messages.push({ source_message_id: 62, message_type: 'text', text: 'Bài mới', media_group_id: null });
  for (const [i, row] of data.destinations.entries()) {
    row.mappings.push({ source_message_id: 62, destination_message_id: i ? 141 : 69, status: 'copied' });
  }
  const previews = buildTwoDestinationPreviews(data, { afterOne: true });
  assert.deepEqual(previews.map(row => row.index.postCount), [61, 61]);
  assert.deepEqual(previews.map(row => row.index.highWatermark), [62, 62]);
  assert.throws(() => buildTwoDestinationPreviews(data), /source or destination set changed/);
});


function oneEntryTitle(text, { secondMessageText = null, album = false } = {}) {
  const messages = [{
    source_message_id: 2,
    message_type: 'text',
    text,
    media_group_id: album ? 'album-1' : null
  }];
  if (secondMessageText !== null) {
    messages.push({
      source_message_id: 3,
      message_type: 'text',
      text: secondMessageText,
      media_group_id: album ? 'album-1' : null
    });
  }
  const mappings = messages.map((message, index) => ({
    source_message_id: message.source_message_id,
    destination_message_id: 10 + index,
    status: 'copied'
  }));
  return buildCourseIndex({
    source: { title: 'TEST' },
    destination: { chat_id: '-1003933578709' },
    messages,
    mappings
  }).entries[0].title;
}

test('adds the next meaningful line when the first line is only a lesson number', () => {
  assert.equal(
    oneEntryTitle('Bài 1 :\n📍 QUY TRÌNH SƠ CHẾ & HẤP CÁ NỤC'),
    'Bài 1 : 📍 QUY TRÌNH SƠ CHẾ & HẤP CÁ NỤC'
  );
  assert.equal(
    oneEntryTitle('BÀI 02\n\nhttps://t.me/example\n🔥 TÊN BÀI THẬT'),
    'BÀI 02 🔥 TÊN BÀI THẬT'
  );
});

test('does not look ahead when the first line already contains a lesson title', () => {
  assert.equal(
    oneEntryTitle('Bài 17 📍 SỐT CÀ CHUA CÁ NỤC & XÍU MẠI\nNguyên liệu'),
    'Bài 17 📍 SỐT CÀ CHUA CÁ NỤC & XÍU MẠI'
  );
});

test('lesson-number fallback never steals a title from another Telegram post', () => {
  assert.equal(oneEntryTitle('Bài 8:', { secondMessageText: 'KHÔNG ĐƯỢC GHÉP' }), 'Bài 8:');
  assert.equal(
    oneEntryTitle('Bài 12:\n🎯 TÊN ALBUM', { secondMessageText: 'caption member 2', album: true }),
    'Bài 12: 🎯 TÊN ALBUM (2 bài)'
  );
});

test('long derived lesson titles still use the existing index truncation', () => {
  const title = oneEntryTitle(`Bài 1:\n${'A'.repeat(100)}`);
  assert.ok(Array.from(title).length <= 64);
  assert.ok(title.endsWith('…'));
});
