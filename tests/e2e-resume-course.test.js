import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResumeMappings } from '../scripts/e2e-local/resume-course-core.mjs';

const messages = [2, 3, 4, 5, 7, 8, 9].map((source_message_id) => ({
  source_message_id,
  media_group_id: [4, 5].includes(source_message_id) ? 'album-a' : null
}));
const mapped = [14, 15, 16, 17, 18].map((destination_message_id, index) => ({
  source_message_id: messages[index].source_message_id, destination_message_id, status: 'copied'
}));

test('confirmed five mappings can be continued without another copy of old posts', () => {
  assert.equal(validateResumeMappings(mapped, messages).length, 5);
  assert.equal(validateResumeMappings([...mapped, { source_message_id: 8, destination_message_id: 19, status: 'copied' }], messages).length, 6);
});

test('a changed old ID, skipped lesson or out-of-order destination fails before Telegram copy', () => {
  assert.throws(() => validateResumeMappings([{ ...mapped[0], destination_message_id: 99 }, ...mapped.slice(1)], messages), /Confirmed TEST destination ID/);
  assert.throws(() => validateResumeMappings([...mapped, { source_message_id: 9, destination_message_id: 19, status: 'copied' }], messages), /chronological position/);
  assert.throws(() => validateResumeMappings([...mapped, { source_message_id: 8, destination_message_id: 17, status: 'copied' }], messages), /no longer chronological/);
});

test('a partial album at the restart checkpoint is quarantined', () => {
  const partial = messages.map((message) => ({ ...message, media_group_id: [7, 8].includes(message.source_message_id) ? 'album-b' : message.media_group_id }));
  assert.throws(() => validateResumeMappings(mapped, partial), /inside an album/);
});
