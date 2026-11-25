// R1 (Owner 25/11): optional server-side channel allowlist. Unset = unchanged behaviour; set = only listed channels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertReaderChannelAllowed, isReaderChannelAllowed, readerChannelAllowlist, readerChannelAllowlistStatus } from '../lib/channel-allowlist.js';

const env = list => ({ READER_CHANNEL_ALLOWLIST: list });

test('unset or blank list = no restriction (deploying the code changes nothing)', () => {
  assert.equal(readerChannelAllowlist({}), null);
  assert.equal(readerChannelAllowlist(env('  ')), null);
  assert.equal(isReaderChannelAllowed({ chat_id: '-1009999' }, {}), true);
});

test('ids match with or without -100, usernames case-insensitively; others are refused', () => {
  const e = env('-1004310054018, 123456 ,@MyCourse');
  assert.equal(isReaderChannelAllowed({ chat_id: '-1004310054018' }, e), true);
  assert.equal(isReaderChannelAllowed({ chat_id: '4310054018' }, e), true);
  assert.equal(isReaderChannelAllowed({ chat_id: '-100123456' }, e), true);
  assert.equal(isReaderChannelAllowed({ chat_id: '-1000000', username: 'mycourse' }, e), true);
  assert.equal(isReaderChannelAllowed({ chat_id: '-1007777' }, e), false);
  assert.equal(isReaderChannelAllowed({ chat_id: '' }, e), false);
  assert.throws(() => assertReaderChannelAllowed({ chat_id: '-1007777' }, e), err => err.code === 'reader_channel_not_allowlisted' && err.status === 403);
});

test('health status counts entries and typos without exposing ids', () => {
  assert.deepEqual(readerChannelAllowlistStatus({}), { enabled: false, entries: 0, ignored: 0 });
  assert.deepEqual(readerChannelAllowlistStatus(env('-1004310054018, @Kenh, abc')), { enabled: true, entries: 2, ignored: 1 });
  // Only typos = no valid entry = restriction stays off (never locks every channel by mistake).
  assert.deepEqual(readerChannelAllowlistStatus(env('abc')), { enabled: false, entries: 0, ignored: 1 });
  assert.equal(readerChannelAllowlist(env('abc')), null);
});

test('every entry point checks the allowlist', () => {
  const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(read('lib/repository.js'), /export async function upsertSource\(source\) \{\n  assertReaderChannelAllowed\(source\);/);
  assert.match(read('lib/repository.js'), /return rows\?\.\[0\] && isReaderChannelAllowed\(rows\[0\]\) \? rows\[0\] : null;/);
  assert.match(read('lib/reader-jobs.js'), /queueReaderJob\(source[^)]*\) \{\n  assertReaderChannelAllowed\(source\);/);
  assert.match(read('lib/reader-jobs.js'), /if \(!source \|\| !isReaderChannelAllowed\(source\)\) \{[\s\S]*?status: 'failed', last_error: 'reader_channel_not_allowlisted'/);
  // Refused before the current MASTER is switched off.
  const source = read('server/admin/source.js');
  assert.ok(source.indexOf('assertReaderChannelAllowed(') < source.indexOf("patch(TABLES.sources, 'active=eq.true'"));
  // Reader-supplied username is not used for the check.
  assert.match(read('api/reader/register-source.js'), /isReaderChannelAllowed\(\{ chat_id: String\(botChat\.id \?\? chatId\), username: botChat\.username \}\)/);
  assert.match(read('api/reader/ingest.js'), /if \(!isReaderChannelAllowed\(source\)\) return json\(res, 403/);
  assert.match(read('api/reader/register-source.js'), /reader_channel_not_allowlisted/);
  assert.match(read('api/admin.js'), /error\?\.code === 'reader_channel_not_allowlisted'\) return json\(res, 403/);
});
