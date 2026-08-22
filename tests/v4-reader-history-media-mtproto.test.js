import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const reader = fs.readFileSync(new URL('../reader-cli/export_history.py', import.meta.url), 'utf8');
const register = fs.readFileSync(new URL('../api/reader/register-source.js', import.meta.url), 'utf8');
const resolver = fs.readFileSync(new URL('../lib/mtproto-history-media.js', import.meta.url), 'utf8');
const warmup = fs.readFileSync(new URL('../api/telegram/warmup.js', import.meta.url), 'utf8');
const thumbnail = fs.readFileSync(new URL('../api/telegram/thumbnail.js', import.meta.url), 'utf8');

test('history reader uploads only safe MTProto descriptors for media', () => {
  assert.match(reader, /def reader_raw_message/);
  assert.match(reader, /"from_reader": True/);
  assert.match(reader, /"mtproto": True/);
  assert.match(reader, /"file_id": ""/);
  assert.match(reader, /raw_message\["photo"\] = \[descriptor\]/);
  assert.match(reader, /raw_message\[message_type\] = item/);
  assert.doesNotMatch(reader, /raw_message.*TELEGRAM_API_HASH/);
  assert.doesNotMatch(reader, /raw_message.*READER_INGEST_SECRET/);
  assert.doesNotMatch(reader, /raw_message.*session/i);
});

test('reader registration verifies the Cloner bot can access the source', () => {
  assert.match(register, /getChat\(chatId\)/);
  assert.match(register, /telegram_bot_source_access_required/);
  assert.match(register, /bot_access_verified: true/);
  assert.match(register, /active: Boolean\(existing\?\.active\)/);
});

test('historical MTProto resolver supports both documents and photos', () => {
  assert.match(resolver, /InputDocumentFileLocation/);
  assert.match(resolver, /InputPhotoFileLocation/);
  assert.match(resolver, /resolveMtprotoHistoricalMedia/);
  assert.match(resolver, /resolveMtprotoHistoricalThumbnail/);
  assert.match(resolver, /client\.getMessages\(entity, \{ ids: Number\(messageId\) \}\)/);
});

test('MTProto gateway keeps feed video protection while allowing non-video history media', () => {
  assert.match(warmup, /const VIDEO_TYPES = new Set\(\['video', 'animation', 'video_note'\]\)/);
  assert.match(warmup, /purpose === 'feed' && VIDEO_TYPES\.has\(resolved\.row\.message_type\)/);
  assert.match(warmup, /playback_lease_required/);
  assert.match(warmup, /resolveMtprotoHistoricalMedia/);
  assert.doesNotMatch(warmup, /streamOnly && purpose === 'feed'\) \{\s*return json/);
});

test('thumbnail gateway falls back to MTProto for Reader history thumbnails', () => {
  assert.match(thumbnail, /thumb\.file_id && !thumb\.mtproto/);
  assert.match(thumbnail, /resolveMtprotoHistoricalThumbnail/);
  assert.match(thumbnail, /streamResolvedMtprotoRange/);
  assert.match(thumbnail, /thumbnailCacheId/);
  assert.match(thumbnail, /transport=\$\{thumbnail\.mtproto \? 'mtproto' : 'bot-api'\}/);
});
