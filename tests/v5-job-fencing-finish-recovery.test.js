import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const jobsPath = path.join(REPO_ROOT, 'lib', 'v5-mirror-jobs.js');
const jobsCode = fs.readFileSync(jobsPath, 'utf8');

const agentPath = path.join(REPO_ROOT, 'reader-manager', 'reader_manager_agent.py');
const agentCode = fs.readFileSync(agentPath, 'utf8');

const apiPath = path.join(REPO_ROOT, 'api', 'reader', 'complete.js');
const apiCode = fs.readFileSync(apiPath, 'utf8');

const canaryFinishPath = path.join(REPO_ROOT, 'lib', 'v5-phase4-canary-finish.js');
const canaryFinishCode = fs.readFileSync(canaryFinishPath, 'utf8');

const migrationPath = path.join(REPO_ROOT, 'sql', 'migration_v5_mirror_fencing_20260917.sql');
const migrationCode = fs.readFileSync(migrationPath, 'utf8');

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  try {
    const cmd = process.platform === 'win32' ? 'where.exe python' : 'which python || which python3';
    const out = spawnSync(cmd, { shell: true, encoding: 'utf8' });
    if (out.stdout) return out.stdout.trim().split(/\r?\n/)[0];
  } catch {}
  return 'python';
}

const pythonBin = resolvePython();

test('1. Migration SQL defines finish_v5_telegram_mirror_job with p_attempt and search_path security', () => {
  assert.match(migrationCode, /create or replace function public\.finish_v5_telegram_mirror_job/);
  assert.match(migrationCode, /p_attempt integer default null/);
  assert.match(migrationCode, /set search_path = pg_catalog, public/);
  assert.match(migrationCode, /v5_mirror_lease_fenced:expected_attempt_%_got_%/);
  assert.match(migrationCode, /revoke all on function public\.finish_v5_telegram_mirror_job/);
  assert.match(migrationCode, /grant execute on function public\.finish_v5_telegram_mirror_job/);
});

test('2. finishOwnedJob in lib/v5-mirror-jobs.js enforces attempt fencing generation', () => {
  assert.match(jobsCode, /attempt = null/);
  assert.match(jobsCode, /if \(attempt !== null && attempt !== undefined && job\.attempts !== null && job\.attempts !== undefined\)/);
  assert.match(jobsCode, /v5_mirror_lease_fenced:expected_attempt_\$\{job\.attempts\}_got_\$\{attempt\}/);
  assert.match(jobsCode, /rpcBody\.p_attempt = Number\(attempt\)/);
});

test('3. finishPhase4CanaryMirrorJob accepts and forwards attempt with fencing check', () => {
  assert.match(canaryFinishCode, /attempt = null/);
  assert.match(canaryFinishCode, /v5_mirror_lease_fenced:expected_attempt_\$\{job\.attempts\}_got_\$\{attempt\}/);
  assert.match(canaryFinishCode, /rpcBody\.p_attempt = Number\(attempt\)/);
});

test('4. api/reader/complete.js accepts attempt and maps lease_fenced to 409', () => {
  assert.match(apiCode, /attempt: safeProgress\(body\.attempt\)/);
  assert.match(apiCode, /errMsg\.includes\('lease_fenced'\)/);
  assert.match(apiCode, /v5_mirror_lease_fenced/);
});

test('5. reader_manager_agent.py includes attempt in mirror finish completion payload', () => {
  assert.match(agentCode, /attempt_val = job\.get\("attempt"\)/);
  assert.match(agentCode, /"attempt": int\(attempt_val or 0\)/);
});

test('6. Finish outbox mechanism saves unconfirmed completions and unlinks on success', () => {
  assert.match(agentCode, /def finish_outbox_dir\(\):/);
  assert.match(agentCode, /def save_pending_finish\(job_id, completion_payload\):/);
  assert.match(agentCode, /def remove_pending_finish\(job_id\):/);
  assert.match(agentCode, /def list_pending_finishes\(\):/);
  assert.match(agentCode, /def flush_pending_finishes\(config\):/);
  assert.match(agentCode, /remove_pending_finish\(job_id\)/);
  assert.match(agentCode, /save_pending_finish\(job_id, completion\)/);
});

test('7. agent_loop drains pending finish outbox before claiming new jobs', () => {
  assert.match(agentCode, /flush_pending_finishes\(config\)/);
});

test('8. Process supervision terminates and kills stubborn child processes without zombies', () => {
  assert.match(agentCode, /def terminate_all_subprocesses\(\):/);
  assert.match(agentCode, /p\.terminate\(\)/);
  assert.match(agentCode, /p\.wait\(timeout=5\)/);
  assert.match(agentCode, /p\.kill\(\)/);
  assert.match(agentCode, /p\.wait\(timeout=2\)/);
});

test('9. Functional Python test: outbox save, list, and removal lifecycle', () => {
  const managerDir = path.join(REPO_ROOT, 'reader-manager').replace(/\\/g, '/');
  const pyTest = `
import sys, shutil
sys.path.insert(0, '${managerDir}')
from reader_manager_agent import save_pending_finish, remove_pending_finish, list_pending_finishes, finish_outbox_dir

outbox = finish_outbox_dir()
test_job_id = "test-outbox-job-12345"

# 1. Save pending finish
save_pending_finish(test_job_id, {"job_id": test_job_id, "bytes": 5000})

# 2. Verify in list
items = list_pending_finishes()
found = [data for _, data in items if data.get("job_id") == test_job_id]
assert len(found) == 1, f"Expected 1 found, got {len(found)}"
assert found[0]["completion"]["bytes"] == 5000

# 3. Remove pending finish
remove_pending_finish(test_job_id)
items_after = list_pending_finishes()
found_after = [data for _, data in items_after if data.get("job_id") == test_job_id]
assert len(found_after) == 0

print("OUTBOX_LIFECYCLE_OK")
`;
  const res = spawnSync(pythonBin, ['-c', pyTest], { encoding: 'utf8' });
  assert.equal(res.status, 0, `Python outbox test failed: ${res.stderr}`);
  assert.match(res.stdout, /OUTBOX_LIFECYCLE_OK/);
});

test('10. Database migration SQL is mirrored identically between LMS and cloner repositories', () => {
  const lmsMigrationPath = path.join(REPO_ROOT, '..', 'yeunauan-lms-clone', 'sql', 'migration_lms_v5_mirror_fencing_20260917.sql');
  assert.equal(fs.existsSync(lmsMigrationPath), true);
  const lmsSql = fs.readFileSync(lmsMigrationPath, 'utf8');
  assert.equal(lmsSql.trim(), migrationCode.trim());
});
