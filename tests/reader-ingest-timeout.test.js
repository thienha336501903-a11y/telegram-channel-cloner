import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hasUsableReaderMtprotoMedia } from '../lib/reader-media.js';

const ingest = fs.readFileSync(new URL('../api/reader/ingest.js', import.meta.url), 'utf8');
const reader = fs.readFileSync(new URL('../reader-cli/export_history.py', import.meta.url), 'utf8');

test('Reader MTProto documents bypass synchronous Bot API self-forward hydration', () => {
  assert.equal(hasUsableReaderMtprotoMedia({
    message_type: 'video',
    raw_message: { from_reader: true, video: { mtproto: true, file_size: 25_000_000, file_id: '' } }
  }), true);
  assert.match(ingest, /if \(hasUsableReaderMtprotoMedia\(m\)\)/);
  assert.match(ingest, /mtproto_preserved: mtprotoPreserved/);
});

test('Reader MTProto photos bypass hydration when a usable size exists', () => {
  assert.equal(hasUsableReaderMtprotoMedia({
    message_type: 'photo',
    raw_message: { from_reader: true, photo: [{ mtproto: true, file_size: 2048, file_id: '' }] }
  }), true);
});

test('missing or invalid descriptors retain the legacy hydration fallback', () => {
  assert.equal(hasUsableReaderMtprotoMedia({
    message_type: 'video',
    raw_message: { from_reader: true, video: { mtproto: true, file_size: 0, file_id: '' } }
  }), false);
  assert.match(ingest, /else if \(m\.raw_message\?\.from_reader\)/);
});

test('local Reader uses bounded batches as a second timeout guard', () => {
  assert.match(reader, /--batch-size", type=int, default=20/);
});
