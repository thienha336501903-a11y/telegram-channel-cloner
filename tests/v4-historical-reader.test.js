import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const register = fs.readFileSync(new URL('../api/reader/register-source.js', import.meta.url), 'utf8');
const ingest = fs.readFileSync(new URL('../api/reader/ingest.js', import.meta.url), 'utf8');
const cli = fs.readFileSync(new URL('../reader-cli/export_history.py', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../reader-cli/README.md', import.meta.url), 'utf8');

test('historical reader registration preserves mirror MASTER role', () => {
  assert.match(register, /getSourceByChatId\(chatId\)/);
  assert.match(register, /active: Boolean\(existing\?\.active\)/);
  assert.match(register, /mirror_master: Boolean\(existing\?\.active\)/);
  assert.doesNotMatch(register, /active:\s*true/);
  assert.doesNotMatch(register, /indexed_at:\s*null/);
});

test('historical ingest remains source-scoped and does not enqueue clone destinations', () => {
  assert.match(ingest, /upsertSourceMessage/);
  assert.match(ingest, /recordInternalLinks/);
  assert.doesNotMatch(ingest, /enqueueForDestinations/);
  assert.doesNotMatch(ingest, /getActiveSource/);
});

test('local reader supports any registered V4 source without changing MASTER', () => {
  assert.match(cli, /Registering\/importing a source must not change the clone\/mirror MASTER/);
  assert.match(cli, /mirror_master/);
  assert.match(cli, /MASTER mirror role was not changed/);
  assert.match(readme, /registered Telegram source/);
  assert.match(readme, /must not change the clone\/mirror MASTER/);
  assert.match(readme, /Live posts\/edits continue to arrive through the webhook separately/);
  assert.match(readme, /telegram-channel-cloner\.vercel\.app/);
});
