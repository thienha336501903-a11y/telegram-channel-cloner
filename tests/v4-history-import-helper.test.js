// Regression scope: history import stays local-only, Reader Agent is one-time setup,
// manual Windows import remains available as a secret-free fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const powershell = fs.readFileSync(new URL('../reader-cli/import_history_windows.ps1', import.meta.url), 'utf8');
const cmd = fs.readFileSync(new URL('../reader-cli/import-history.cmd', import.meta.url), 'utf8');
const reader = fs.readFileSync(new URL('../reader-cli/export_history.py', import.meta.url), 'utf8');
const gitignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

test('Cloner admin explains live webhook versus automatic local history import', () => {
  assert.match(page, /Bài mới\/sửa bài/);
  assert.match(page, /webhook tự cập nhật/);
  assert.match(page, /Bài cũ/);
  assert.match(page, /Reader Agent trên Windows/);
  assert.match(page, /Telegram user session vẫn chỉ nằm trên máy Windows/);
  assert.match(page, /Cài Reader Agent 1 lần/);
  assert.match(page, /Lệnh thủ công/);
});

test('every source exposes automatic history import and a manual fallback', () => {
  assert.match(page, /data-reader-source/);
  assert.match(page, /🤖 Import tự động/);
  assert.match(page, /data-history-channel/);
  assert.match(page, /📋 Lệnh thủ công/);
  assert.match(page, /function historicalImportCommand/);
  assert.match(page, /git pull --ff-only origin main/);
  assert.match(page, /reader-cli\\\\import-history\.cmd/);
  assert.match(page, /navigator\.clipboard/);
  assert.match(page, /window\.prompt/);
});

test('generated admin commands never embed runtime secrets or sessions', () => {
  const helperStart = page.indexOf('function historicalImportCommand');
  const helperEnd = page.indexOf('async function copyText', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = page.slice(helperStart, helperEnd);
  assert.doesNotMatch(helper, /TELEGRAM_API_ID/);
  assert.doesNotMatch(helper, /TELEGRAM_API_HASH/);
  assert.doesNotMatch(helper, /READER_INGEST_SECRET/);
  assert.doesNotMatch(helper, /Authorization/);
  assert.doesNotMatch(helper, /\.session/i);
});

test('Windows helper stores reusable secrets with DPAPI and remains local-only', () => {
  assert.match(powershell, /ConvertFrom-SecureString/);
  assert.match(powershell, /ConvertTo-SecureString/);
  assert.match(powershell, /\.reader-windows-secrets\.json/);
  assert.match(powershell, /git pull --ff-only --quiet origin main/);
  assert.match(powershell, /Tracked local changes exist; skipping automatic reader update/);
  assert.match(powershell, /pip install -r/);
  assert.match(powershell, /export_history\.py/);
  assert.match(powershell, /https:\/\/reader\.yeubep\.shop/);
  assert.match(cmd, /ExecutionPolicy Bypass/);
  assert.match(cmd, /import_history_windows\.ps1/);
  assert.match(gitignore, /reader-cli\/\.reader-windows-secrets\.json/);
});

test('Windows cmd binds -100 Telegram ids explicitly as the Channel parameter value', () => {
  assert.match(cmd, /-Channel "%~1"/);
  assert.doesNotMatch(cmd, /import_history_windows\.ps1" %\*/);
});

test('history reader resolves private chat ids and t.me/c links from local Telegram dialogs', () => {
  assert.match(reader, /def private_channel_id/);
  assert.match(reader, /-100\\d\+/);
  assert.match(reader, /t\\\.me\/c\/\(\\d\+\)/);
  assert.match(reader, /async def resolve_channel/);
  assert.match(reader, /client\.iter_dialogs\(\)/);
  assert.match(reader, /Make sure the reader account is a member of the channel/);
  assert.match(reader, /entity = await resolve_channel\(client, args\.channel\)/);
});

test('source history controls prefer username and safely fall back to chat id', () => {
  assert.match(page, /s\.username\?'@'\+s\.username:s\.chat_id/);
  assert.match(page, /copyHistoricalImport\(manual\.dataset\.historyChannel\)/);
});
