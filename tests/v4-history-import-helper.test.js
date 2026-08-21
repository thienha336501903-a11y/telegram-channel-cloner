// Regression scope: history import stays local-only, one-command on Windows, and never embeds secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const powershell = fs.readFileSync(new URL('../reader-cli/import_history_windows.ps1', import.meta.url), 'utf8');
const cmd = fs.readFileSync(new URL('../reader-cli/import-history.cmd', import.meta.url), 'utf8');
const reader = fs.readFileSync(new URL('../reader-cli/export_history.py', import.meta.url), 'utf8');
const gitignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

test('Cloner admin explains live webhook versus local historical import', () => {
  assert.match(page, /Bài mới\/sửa bài/);
  assert.match(page, /webhook tự cập nhật/);
  assert.match(page, /Bài cũ trước khi đăng ký/);
  assert.match(page, /Import 1 lệnh/);
  assert.match(page, /Windows DPAPI/);
});

test('every source exposes a one-command Windows historical import helper', () => {
  assert.match(page, /data-history-channel/);
  assert.match(page, /📋 Import 1 lệnh/);
  assert.match(page, /function historicalImportCommand/);
  assert.match(page, /git pull --ff-only origin main/);
  assert.match(page, /reader-cli\\\\import-history\.cmd/);
  assert.match(page, /navigator\.clipboard/);
  assert.match(page, /window\.prompt/);
});

test('generated admin command never embeds runtime secrets or sessions', () => {
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

test('Windows helper stores reusable secrets with DPAPI and remains local-only', () => {
  assert.match(powershell, /ConvertFrom-SecureString/);
  assert.match(powershell, /ConvertTo-SecureString/);
  assert.match(powershell, /\.reader-windows-secrets\.json/);
  assert.match(powershell, /git pull --ff-only --quiet origin main/);
  assert.match(powershell, /Tracked local changes exist; skipping automatic reader update/);
  assert.match(powershell, /pip install -r/);
  assert.match(powershell, /export_history\.py/);
  assert.match(powershell, /https:\/\/telegram-channel-cloner\.vercel\.app/);
  assert.match(cmd, /ExecutionPolicy Bypass/);
  assert.match(cmd, /import_history_windows\.ps1/);
  assert.match(gitignore, /reader-cli\/\.reader-windows-secrets\.json/);
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

test('source table prefers username and safely falls back to chat id', () => {
  assert.match(page, /const historyChannel=s\.username\?'@'\+s\.username:s\.chat_id/);
  assert.match(page, /copyHistoricalImport\(b\.dataset\.historyChannel\)/);
});
