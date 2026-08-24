import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('sql/007_reader_manager_profiles.sql');
const manager = read('lib/reader-manager.js');
const jobs = read('lib/reader-jobs.js');
const control = read('api/reader/complete.js');
const admin = read('api/admin.js');
const storage = read('reader-manager/reader_manager_storage.py');
const gui = read('reader-manager/reader_manager_gui.py');
const agent = read('reader-manager/reader_manager_agent.py');
const pairing = read('reader-manager/reader_manager_pairing.py');
const installer = read('reader-manager/installer.iss');
const readerAdmin = read('server/admin/reader-manager.js');

test('Reader Manager migration is additive, source-scoped and RLS protected', () => {
  assert.match(migration, /create table if not exists public\.tgcloner_reader_agents/);
  assert.match(migration, /create table if not exists public\.tgcloner_reader_profiles/);
  assert.match(migration, /create table if not exists public\.tgcloner_reader_pairings/);
  assert.match(migration, /create table if not exists public\.tgcloner_reader_source_access/);
  assert.match(migration, /alter table public\.tgcloner_reader_jobs[\s\S]*add column if not exists assigned_reader_profile_id/);
  assert.match(migration, /enable row level security/g);
  assert.doesNotMatch(migration, /drop table|truncate|disable row level security/i);
});

test('pairing stores hashes and issues a revocable per-machine token', () => {
  assert.match(manager, /secretHash\(code, 'pairing'\)/);
  assert.match(manager, /crypto\.randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(manager, /secretHash\(token, 'agent-token'\)/);
  assert.doesNotMatch(migration, /agent_token\s+text/i);
  assert.doesNotMatch(migration, /pairing_code\s+text/i);
});

test('managed Reader endpoints coexist with the legacy fail-closed secret', () => {
  assert.match(manager, /READER_INGEST_SECRET/);
  assert.match(manager, /mode: 'legacy'/);
  assert.match(control, /action === 'pair'/);
  assert.match(control, /action === 'register-profile'/);
  assert.match(control, /action === 'source-access'/);
  assert.match(admin, /'reader-manager': readerManagerHandler/);
});

test('jobs are targeted to profiles and managed agents cannot claim another assignment', () => {
  assert.match(jobs, /assigned_reader_profile_id/);
  assert.match(jobs, /claimed_reader_profile_id/);
  assert.match(jobs, /assigned_reader_profile_id\.in/);
  assert.match(jobs, /reader_job_already_assigned/);
  assert.match(jobs, /progress_current/);
});

test('Windows Reader Manager protects all local configuration with DPAPI', () => {
  assert.match(storage, /CryptProtectData/);
  assert.match(storage, /CryptUnprotectData/);
  assert.match(storage, /reader-manager\.dat/);
  assert.doesNotMatch(storage, /\.session/);
  assert.match(gui, /StringSession\.save/);
  assert.doesNotMatch(gui, /Set-Content|\.env|READER_INGEST_SECRET/);
});

test('Reader Manager provides basic-user setup without Python or command entry', () => {
  assert.match(gui, /Kết nối máy Reader/);
  assert.match(gui, /Thêm tài khoản Telegram/);
  assert.match(gui, /Mã Telegram/);
  assert.match(gui, /Mật khẩu hai lớp/);
  assert.match(installer, /PrivilegesRequired=lowest/);
  assert.match(installer, /YeuNauAnReaderImport\.exe/);
  assert.match(agent, /reader_source_access_denied/);
});

test('one-field pairing selects only the trusted Production or team Preview server', () => {
  assert.match(readerAdmin, /connection_code:\s*`YNA1\|/);
  assert.match(readerAdmin, /VERCEL_ENV === 'preview'/);
  assert.match(readerAdmin, /VERCEL_BRANCH_URL \|\| process\.env\.VERCEL_URL/);
  assert.match(pairing, /def parse_pairing_package/);
  assert.match(pairing, /PRODUCTION_CLONER_HOST/);
  assert.match(pairing, /PREVIEW_CLONER_HOST\.fullmatch/);
  assert.match(pairing, /parsed\.scheme != "https"/);
  assert.match(pairing, /reader_server_not_trusted/);
  assert.match(gui, /parse_pairing_package\(pairing_value\)/);
});

test('Reader workers receive decrypted sessions only through the local process environment', () => {
  const importer = read('reader-cli/export_history.py');
  const reconciler = read('reader-cli/reconcile_history.py');
  assert.match(importer, /TELEGRAM_SESSION_STRING/);
  assert.match(importer, /StringSession\(session_string\)/);
  assert.match(reconciler, /local_session\(args\.session\)/);
  assert.match(agent, /"TELEGRAM_SESSION_STRING": profile\["session"\]/);
  assert.doesNotMatch(agent, /post_json.*session/i);
});
