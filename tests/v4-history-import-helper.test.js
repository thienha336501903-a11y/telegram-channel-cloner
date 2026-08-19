import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('Cloner admin explains live webhook versus local historical import', () => {
  assert.match(page, /Bài mới\/sửa bài/);
  assert.match(page, /webhook tự cập nhật/);
  assert.match(page, /Bài cũ trước khi đăng ký/);
  assert.match(page, /local history reader/);
});

test('every source exposes a local historical import command helper', () => {
  assert.match(page, /data-history-channel/);
  assert.match(page, /📋 Lệnh import/);
  assert.match(page, /function historicalImportCommand/);
  assert.match(page, /reader-cli\/export_history\.py/);
  assert.match(page, /--cloner-url https:\/\/telegram-channel-cloner\.vercel\.app/);
  assert.match(page, /navigator\.clipboard/);
  assert.match(page, /window\.prompt/);
});

test('history helper does not embed runtime secrets or sessions into the generated command', () => {
  const helperStart = page.indexOf('function historicalImportCommand');
  const helperEnd = page.indexOf('async function copyHistoricalImport', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = page.slice(helperStart, helperEnd);
  assert.doesNotMatch(helper, /TELEGRAM_API_ID/);
  assert.doesNotMatch(helper, /TELEGRAM_API_HASH/);
  assert.doesNotMatch(helper, /READER_INGEST_SECRET/);
  assert.doesNotMatch(helper, /Authorization/);
  assert.doesNotMatch(helper, /session/i);
});

test('source table prefers username and falls back to chat id for import target', () => {
  assert.match(page, /const historyChannel=s\.username\?'@'\+s\.username:s\.chat_id/);
  assert.match(page, /copyHistoricalImport\(b\.dataset\.historyChannel\)/);
});
