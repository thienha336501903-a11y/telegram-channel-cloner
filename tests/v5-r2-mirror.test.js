import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const control = read('api/reader/complete.js');
const jobs = read('lib/v5-mirror-jobs.js');
const agent = read('reader-cli/reader_agent.py');
const worker = read('reader-cli/mirror_v5_r2.py');
const gitignore = read('.gitignore');
const ci = read('.github/workflows/ci.yml');

test('V5 mirror reuses the existing authenticated Reader control function', () => {
  assert.match(control, /authenticateReaderRequest/);
  assert.match(control, /action === 'v5-mirror-claim'/);
  assert.match(control, /action === 'v5-mirror-heartbeat'/);
  assert.match(control, /action === 'v5-mirror-finish'/);
  assert.match(control, /capabilities\.includes\('v5_r2_mirror_v1'\)/);
  assert.match(control, /value === null \|\| value === undefined \|\| value === '' \|\| typeof value === 'boolean'/);
});

test('mirror job ownership and R2 object key are enforced server-side', () => {
  assert.match(jobs, /rpc\/claim_v5_telegram_mirror_job/);
  assert.match(jobs, /rpc\/finish_v5_telegram_mirror_job/);
  assert.match(jobs, /status=eq\.running&locked_by=eq\./);
  assert.match(jobs, /function objectKeyFor/);
  assert.match(jobs, /media\/v5\/\$\{job\.course_id\}\/\$\{asset\.id\}/);
  assert.match(jobs, /v5_mirror_object_key_mismatch/);
  assert.match(jobs, /expected_bytes: safeBytes\(asset\.bytes\)/);
  assert.doesNotMatch(jobs, /values\.payload/);
});

test('Reader advertises V5 mirror only when all local R2 credentials exist', () => {
  assert.match(agent, /V5_MIRROR_CAPABILITY = "v5_r2_mirror_v1"/);
  assert.match(agent, /R2_ACCOUNT_ID/);
  assert.match(agent, /R2_ACCESS_KEY_ID/);
  assert.match(agent, /R2_SECRET_ACCESS_KEY/);
  assert.match(agent, /R2_BUCKET.*V5_R2_BUCKET/s);
  assert.match(agent, /if has_v5_r2_config\(\):/);
  assert.match(agent, /control_path\("v5-mirror-claim"\)/);
  assert.match(agent, /heartbeat_action = "v5-mirror-heartbeat"/);
  assert.match(agent, /finish_action = "v5-mirror-finish"/);
});

test('local mirror is resumable and idempotent across Telegram and R2 retries', () => {
  assert.match(worker, /client\.iter_download\(/);
  assert.match(worker, /offset=existing/);
  assert.match(worker, /client\.list_parts\(/);
  assert.match(worker, /create_multipart_upload/);
  assert.match(worker, /complete_multipart_upload/);
  assert.match(worker, /head_matching_object/);
  assert.match(worker, /R2 object already complete before retry/);
  assert.match(worker, /telegram_download_empty/);
  assert.match(worker, /r2_size_mismatch_after_complete/);
  assert.doesNotMatch(worker, /READER_INGEST_SECRET/);
});

test('mirror media/checkpoints are excluded from Git and all Reader scripts compile in CI', () => {
  assert.match(gitignore, /reader-cli\/\.v5-r2-cache\//);
  assert.match(gitignore, /\*\.part/);
  assert.match(gitignore, /\*\.r2\.json/);
  assert.match(ci, /python -m py_compile reader-cli\/reader_agent\.py/);
  assert.match(ci, /python -m py_compile reader-cli\/mirror_v5_r2\.py/);
  assert.match(ci, /-name '\*\.part'/);
  assert.match(ci, /-name '\*\.r2\.json'/);
});
