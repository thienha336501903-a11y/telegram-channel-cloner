import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCourseIndex } from '../scripts/e2e-local/course-index-core.mjs';
import { sendTextSafely, DistributorTelegramAmbiguousFailure } from '../lib/distributor-telegram.js';

const source = { title: 'Trung thu dẻo' };
const destination = { chat_id: '-1004492904064' };
const messages = [
  { source_message_id: 2, text: '🎥 Mở đầu', media_group_id: null },
  { source_message_id: 3, text: 'Bài 2 https://t.me/c/3535777660/2', media_group_id: null },
  { source_message_id: 4, caption: 'Ảnh nguyên liệu', media_group_id: 'album1' },
  { source_message_id: 5, caption: 'Ảnh tiếp', media_group_id: 'album1' },
  { source_message_id: 7, text: 'Bài cuối', media_group_id: null }
];
const mappings = [2, 3, 4, 5, 7].map((source_message_id, index) => ({
  source_message_id, destination_message_id: index + 14, status: 'copied'
}));

test('creates a chronological, album-aware index with only destination links', () => {
  const index = buildCourseIndex({ source, destination, messages, mappings, appendixStartSourceId: 7 });
  assert.equal(index.postCount, 5);
  assert.equal(index.groupCount, 4);
  assert.deepEqual(index.entries.map((entry) => entry.sourceIds), [[2], [3], [4, 5], [7]]);
  assert.deepEqual(index.entries.map((entry) => entry.destinationId), [14, 15, 16, 18]);
  assert.equal(index.entries[2].url, 'https://t.me/c/4492904064/16');
  assert.ok(index.text.includes('PHỤ LỤC\n04. Bài cuối'));
  assert.ok(!index.text.includes('3535777660'));
  for (const entity of index.entities) {
    assert.equal(entity.type, 'text_link');
    assert.ok(entity.url.startsWith('https://t.me/c/4492904064/'));
    assert.ok(index.text.slice(entity.offset, entity.offset + entity.length).length > 0);
  }
  assert.equal(index.hash, buildCourseIndex({ source, destination, messages, mappings, appendixStartSourceId: 7 }).hash);
});

test('refuses missing, reordered or incomplete album mappings', () => {
  assert.throws(() => buildCourseIndex({ source, destination, messages, mappings: mappings.slice(1) }), /exactly one copied mapping/);
  assert.throws(() => buildCourseIndex({ source, destination, messages, mappings: mappings.map((row) => row.source_message_id === 5 ? { ...row, destination_message_id: 10 } : row) }), /order changed/);
  assert.throws(() => buildCourseIndex({ source, destination, messages, mappings, appendixStartSourceId: 5 }), /first post of an album/);
  const split = messages.map((row) => row.source_message_id === 5 ? { ...row, media_group_id: 'other' } : row);
  split[4].media_group_id = 'album1';
  assert.throws(() => buildCourseIndex({ source, destination, messages: split, mappings }), /not contiguous/);
});

test('fits 53 posts into one Telegram message, preserving UTF-16 link offsets', () => {
  const many = Array.from({ length: 53 }, (_, index) => ({ source_message_id: index + 2, text: `🎬 Bài ${index + 1}: ${'Tên bài rất dài '.repeat(15)}` }));
  const mapped = many.map((message, index) => ({ source_message_id: message.source_message_id, destination_message_id: index + 14, status: 'copied' }));
  const index = buildCourseIndex({ source, destination, messages: many, mappings: mapped });
  assert.ok(index.text.length <= 4096);
  assert.equal(index.entities.length, 53);
  for (let i = 0; i < 53; i += 1) {
    assert.equal(index.text.slice(index.entities[i].offset, index.entities[i].offset + index.entities[i].length), index.entries[i].title);
  }
});

test('Bot API index send is silent and refuses a malformed success', async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'unit-test-token';
  try {
    let parameters;
    const fetchImpl = async (_url, request) => {
      parameters = JSON.parse(request.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 60, chat: { id: -1004492904064 } } }) };
    };
    const entry = buildCourseIndex({ source, destination, messages, mappings });
    const sent = await sendTextSafely({ chatId: destination.chat_id, text: entry.text, entities: entry.entities }, { fetchImpl });
    assert.equal(sent.message_id, 60);
    assert.equal(parameters.disable_notification, true);
    assert.equal(parameters.link_preview_options.is_disabled, true);
    assert.deepEqual(parameters.entities, entry.entities);
    await assert.rejects(
      sendTextSafely({ chatId: destination.chat_id, text: entry.text }, {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 60, chat: { id: -1009999999999 } } }) })
      }), DistributorTelegramAmbiguousFailure
    );
  } finally {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});
