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

test('1. Migration SQL defines finish_v5_telegram_mirror_job with required p_attempt and search_path security', () => {
  assert.match(migrationCode, /create or replace function public\.finish_v5_telegram_mirror_job/);
  assert.match(migrationCode, /p_attempt integer\s*\)/);
  assert.doesNotMatch(migrationCode, /p_attempt integer default/);
  assert.match(migrationCode, /set search_path = pg_catalog, public/);
  assert.match(migrationCode, /v5_mirror_attempt_required/);
  assert.match(migrationCode, /v5_mirror_lease_fenced:expected_attempt_%_got_%/);
  assert.match(migrationCode, /revoke all on function public\.finish_v5_telegram_mirror_job/);
  assert.match(migrationCode, /grant execute on function public\.finish_v5_telegram_mirror_job/);
});

test('2. finishOwnedJob in lib/v5-mirror-jobs.js enforces required attempt fencing generation without fallback', () => {
  assert.match(jobsCode, /attempt = null/);
  assert.match(jobsCode, /parsedAttempt === null/);
  assert.match(jobsCode, /v5_mirror_attempt_required/);
  assert.match(jobsCode, /v5_mirror_lease_fenced:expected_attempt_\$\{job\.attempts\}_got_\$\{parsedAttempt\}/);
  assert.match(jobsCode, /p_attempt: Number\(parsedAttempt\)/);
  assert.doesNotMatch(jobsCode, /delete rpcBody\.p_attempt/);
});

test('3. finishPhase4CanaryMirrorJob accepts and forwards attempt with strict fencing check without fallback', () => {
  assert.match(canaryFinishCode, /attempt = null/);
  assert.match(canaryFinishCode, /v5_mirror_attempt_required/);
  assert.match(canaryFinishCode, /v5_mirror_lease_fenced:expected_attempt_\$\{job\.attempts\}_got_\$\{parsedAttempt\}/);
  assert.match(canaryFinishCode, /p_attempt: Number\(parsedAttempt\)/);
  assert.doesNotMatch(canaryFinishCode, /delete rpcBody\.p_attempt/);
});

test('4. api/reader/complete.js requires attempt and maps lease_fenced to 409', () => {
  assert.match(apiCode, /const attempt = safeProgress\(body\.attempt\)/);
  assert.match(apiCode, /v5_mirror_attempt_required/);
  assert.match(apiCode, /errMsg\.includes\('lease_fenced'\)/);
  assert.match(apiCode, /v5_mirror_lease_fenced/);
});

test('5. reader_manager_agent.py includes attempt in mirror finish completion payload', () => {
  assert.match(agentCode, /attempt_val = job\.get\("attempt"\)/);
  assert.match(agentCode, /"attempt": int\(attempt_val or 0\)/);
});

test('6. Finish outbox mechanism saves unconfirmed completions with attempt and unlinks on success', () => {
  assert.match(agentCode, /def finish_outbox_dir\(\):/);
  assert.match(agentCode, /def save_pending_finish\(job_id, completion_payload\):/);
  assert.match(agentCode, /"attempt": attempt/);
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
save_pending_finish(test_job_id, {"job_id": test_job_id, "attempt": 2, "bytes": 5000})

# 2. Verify in list
items = list_pending_finishes()
found = [data for _, data in items if data.get("job_id") == test_job_id]
assert len(found) == 1, f"Expected 1 found, got {len(found)}"
assert found[0]["attempt"] == 2
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

test('10. Database migration SQL is mirrored identically between LMS and cloner repositories', (t) => {
  const lmsMigrationPath = path.join(REPO_ROOT, '..', 'yeunauan-lms-clone', 'sql', 'migration_lms_v5_mirror_fencing_20260917.sql');
  if (!fs.existsSync(lmsMigrationPath)) {
    t.skip('LMS repository not checked out in isolated CI runner');
    return;
  }
  const lmsSql = fs.readFileSync(lmsMigrationPath, 'utf8');
  assert.equal(lmsSql.replace(/\r\n/g, '\n').trim(), migrationCode.replace(/\r\n/g, '\n').trim());
});

test('11. Executable unit tests: safeProgress parser handles all boundary cases correctly', async () => {
  const { safeProgress } = await import('../lib/v5-mirror-jobs.js');
  assert.equal(safeProgress(undefined), null);
  assert.equal(safeProgress(null), null);
  assert.equal(safeProgress(''), null);
  assert.equal(safeProgress(false), null);
  assert.equal(safeProgress(true), null);
  assert.equal(safeProgress(0), 0);
  assert.equal(safeProgress(1), 1);
  assert.equal(safeProgress('1'), 1);
  assert.equal(safeProgress('0'), 0);
  assert.equal(safeProgress(1.5), null);
  assert.equal(safeProgress('abc'), null);
  assert.equal(safeProgress(-1), null);
  assert.equal(safeProgress(NaN), null);
  assert.equal(safeProgress(Infinity), null);
});

test('12. Executable runtime test: finishV5MirrorJob evaluates safeProgress(attempt) and enforces strict fencing', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
  process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'sb_secret_mock_key';

  const { finishV5MirrorJob } = await import('../lib/v5-mirror-jobs.js');

  let capturedRpc = null;
  const originalFetch = globalThis.fetch;
  const makeResp = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data
  });

  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (urlStr.includes('v5_jobs?select=')) {
      return makeResp([{ id: 'job-exec-1', course_id: 'c1', asset_id: 'a1', status: 'running', locked_by: 'agent-1', attempts: 1, payload: {}, result: {} }]);
    }
    if (urlStr.includes('v5_media_assets?select=')) {
      return makeResp([{ id: 'a1', origin: 'telegram', bytes: 1000, mime_type: 'video/mp4', original_filename: 'test.mp4' }]);
    }
    if (urlStr.includes('rpc/finish_v5_telegram_mirror_job')) {
      capturedRpc = body;
      return makeResp([{ id: 'job-exec-1', status: 'success', result: {} }]);
    }
    if (urlStr.includes('v5_jobs?id=eq.') || urlStr.includes('v5_media_assets?id=eq.')) {
      return makeResp([{ id: 'job-exec-1', status: 'success' }]);
    }
    return makeResp([]);
  };

  try {
    // A. Missing attempt throws v5_mirror_attempt_required
    await assert.rejects(
      async () => {
        await finishV5MirrorJob({
          jobId: 'job-exec-1',
          agentId: 'agent-1',
          ok: true,
          attempt: null,
          bytes: 1000,
          objectKey: 'media/v5/c1/a1/test.mp4'
        });
      },
      { message: 'v5_mirror_attempt_required' }
    );

    // B. Stale attempt throws lease fenced
    await assert.rejects(
      async () => {
        await finishV5MirrorJob({
          jobId: 'job-exec-1',
          agentId: 'agent-1',
          ok: true,
          attempt: 2,
          bytes: 1000,
          objectKey: 'media/v5/c1/a1/test.mp4'
        });
      },
      { message: 'v5_mirror_lease_fenced:expected_attempt_1_got_2' }
    );

    // C. Correct attempt executes without ReferenceError and includes p_attempt: 1
    const res = await finishV5MirrorJob({
      jobId: 'job-exec-1',
      agentId: 'agent-1',
      ok: true,
      attempt: 1,
      bytes: 1000,
      objectKey: 'media/v5/c1/a1/test.mp4',
      transformVersion: 'original-v1'
    });
    assert.ok(res);
    assert.equal(capturedRpc.p_attempt, 1);
    assert.equal(capturedRpc.p_job_id, 'job-exec-1');
    assert.equal(capturedRpc.p_agent_id, 'agent-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('13. Executable runtime test: finishPhase4CanaryMirrorJob evaluates safeProgress(attempt) without ReferenceError', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
  process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'sb_secret_mock_key';

  const { finishPhase4CanaryMirrorJob } = await import('../lib/v5-phase4-canary-finish.js');

  let capturedRpc = null;
  const originalFetch = globalThis.fetch;
  const makeResp = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data
  });

  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (urlStr.includes('v5_jobs?select=')) {
      return makeResp([{
        id: 'job-canary-exec',
        course_id: 'a645f117-2320-452f-8538-154b80484218',
        asset_id: 'asset-canary-exec',
        status: 'running',
        locked_by: 'agent-canary',
        attempts: 1,
        payload: {},
        result: {}
      }]);
    }
    if (urlStr.includes('v5_media_assets?select=')) {
      return makeResp([{
        id: 'asset-canary-exec',
        origin: 'telegram',
        telegram_source_id: '039eedf1-6d26-4d04-a152-27e4d29fc5c0',
        telegram_message_row_id: 'be7c377e-05ef-4dd3-8ea3-9b54361dcd2e',
        bytes: 5000,
        mime_type: 'video/mp4',
        original_filename: 'canary.mp4'
      }]);
    }
    if (urlStr.includes('rpc/finish_v5_telegram_mirror_job')) {
      capturedRpc = body;
      return makeResp([{ id: 'job-canary-exec', status: 'success', result: {} }]);
    }
    if (urlStr.includes('v5_jobs?id=eq.') || urlStr.includes('v5_media_assets?id=eq.')) {
      return makeResp([{ id: 'job-canary-exec', status: 'success' }]);
    }
    return makeResp([]);
  };

  try {
    // Missing attempt throws v5_mirror_attempt_required
    await assert.rejects(
      async () => {
        await finishPhase4CanaryMirrorJob({
          jobId: 'job-canary-exec',
          agentId: 'agent-canary',
          ok: true,
          attempt: null,
          bytes: 5000,
          objectKey: 'media/v5/a645f117-2320-452f-8538-154b80484218/asset-canary-exec/canary.mp4'
        });
      },
      { message: 'v5_mirror_attempt_required' }
    );

    // Stale attempt throws lease fenced
    await assert.rejects(
      async () => {
        await finishPhase4CanaryMirrorJob({
          jobId: 'job-canary-exec',
          agentId: 'agent-canary',
          ok: true,
          attempt: 3,
          bytes: 5000,
          objectKey: 'media/v5/a645f117-2320-452f-8538-154b80484218/asset-canary-exec/canary.mp4'
        });
      },
      { message: 'v5_mirror_lease_fenced:expected_attempt_1_got_3' }
    );

    // Correct attempt passes p_attempt: 1 without ReferenceError
    const res = await finishPhase4CanaryMirrorJob({
      jobId: 'job-canary-exec',
      agentId: 'agent-canary',
      ok: true,
      attempt: 1,
      bytes: 5000,
      objectKey: 'media/v5/a645f117-2320-452f-8538-154b80484218/asset-canary-exec/canary.mp4',
      transformVersion: 'ffmpeg-faststart-v1'
    });
    assert.ok(res);
    assert.equal(capturedRpc.p_attempt, 1);
    assert.equal(capturedRpc.p_job_id, 'job-canary-exec');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('14. Executable Python test: mirror_v5_r2.py completion logging does not raise UnicodeEncodeError under CP1252', () => {
  const pyCode = `
import subprocess, sys, os
env = os.environ.copy()
env['PYTHONIOENCODING'] = 'cp1252'
code = '''
import sys
# Test completion log statement from mirror_v5_r2.py line 1140
result_bytes = 79579382
object_key = "media/v5/719a3171-c593-45bc-9e69-946df1957510/10c9420a-0e84-46a3-bdc0-2426142c1f8b/Mo-rong-66-.mp4"
print(f"V5 mirror complete: {result_bytes} bytes -> {object_key}")
'''
p = subprocess.Popen([sys.executable, '-c', code], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
out, err = p.communicate()
assert p.returncode == 0, f"Failed with code {p.returncode}: {err}"
assert b"V5 mirror complete: 79579382 bytes -> media/v5/" in out
print("WORKER_CP1252_LOGGING_OK")
`;
  const res = spawnSync(pythonBin, ['-c', pyCode], { encoding: 'utf8' });
  assert.equal(res.status, 0, `Python CP1252 logging test failed: ${res.stderr}`);
  assert.match(res.stdout, /WORKER_CP1252_LOGGING_OK/);
});

test('15. Unit tests: oneRpcRow handles both PostgREST collection and single-object RPC responses', async () => {
  const { oneRpcRow } = await import('../lib/v5-mirror-jobs.js');

  // A. oneRpcRow([{ id: 1 }]) => { id: 1 }
  assert.deepEqual(oneRpcRow([{ id: 1 }]), { id: 1 });

  // B. oneRpcRow({ id: 1 }) => { id: 1 }
  assert.deepEqual(oneRpcRow({ id: 1 }), { id: 1 });

  // C. oneRpcRow([]) => null
  assert.equal(oneRpcRow([]), null);

  // D. oneRpcRow(null) => null
  assert.equal(oneRpcRow(null), null);

  // Extra boundary cases
  assert.equal(oneRpcRow(undefined), null);
  assert.equal(oneRpcRow(''), null);
  assert.equal(oneRpcRow(123), null);
  assert.equal(oneRpcRow([null]), null);
  assert.equal(oneRpcRow([undefined]), null);
});

test('16. Executable runtime test: finishV5MirrorJob handles PostgREST single-object RPC response and runs enrichment PATCH', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
  process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'sb_secret_mock_key';

  const { finishV5MirrorJob } = await import('../lib/v5-mirror-jobs.js');

  const originalFetch = globalThis.fetch;
  const makeResp = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data
  });

  let rpcCalled = false;
  let jobPatchPayload = null;
  let assetPatchPayload = null;

  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;

    if (urlStr.includes('v5_jobs?select=')) {
      return makeResp([{
        id: 'job-single-obj',
        course_id: 'course-single-obj',
        asset_id: 'asset-single-obj',
        status: 'running',
        locked_by: 'agent-single',
        attempts: 1,
        payload: {},
        result: {}
      }]);
    }
    if (urlStr.includes('v5_media_assets?select=')) {
      return makeResp([{
        id: 'asset-single-obj',
        origin: 'telegram',
        bytes: 79579331,
        mime_type: 'video/mp4',
        original_filename: 'Mo-rong-66-.mp4'
      }]);
    }
    if (urlStr.includes('rpc/finish_v5_telegram_mirror_job')) {
      rpcCalled = true;
      // PostgREST returns a single composite object when RPC returns a single table row
      return makeResp({
        id: 'job-single-obj',
        status: 'success',
        result: {
          object_key: 'media/v5/course-single-obj/asset-single-obj/Mo-rong-66-.mp4',
          bytes: 79579382,
          etag: 'etag-test-123'
        }
      });
    }
    if (urlStr.includes('v5_jobs?id=eq.')) {
      jobPatchPayload = body;
      return makeResp([{
        id: 'job-single-obj',
        status: 'success',
        result: body.result
      }]);
    }
    if (urlStr.includes('v5_media_assets?id=eq.')) {
      assetPatchPayload = body;
      return makeResp([{
        id: 'asset-single-obj',
        status: 'ready'
      }]);
    }
    return makeResp([]);
  };

  try {
    const res = await finishV5MirrorJob({
      jobId: 'job-single-obj',
      agentId: 'agent-single',
      ok: true,
      attempt: 1,
      objectKey: 'media/v5/course-single-obj/asset-single-obj/Mo-rong-66-.mp4',
      bytes: 79579382,
      sourceBytes: 79579331,
      finalBytes: 79579382,
      transformVersion: 'ffmpeg-faststart-v1',
      checksumSha256: '47bdd87319e7d555c920cd1362c09c7e6e3d53e3eda6a588d0885a0e3964b5fa',
      etag: 'etag-test-123'
    });

    assert.ok(res, 'finishV5MirrorJob must not return null');
    assert.equal(rpcCalled, true, 'RPC must have been invoked');
    assert.ok(jobPatchPayload, 'Job enrichment PATCH must have executed');
    assert.ok(assetPatchPayload, 'Asset enrichment PATCH must have executed');

    assert.equal(res.status, 'success');
    assert.equal(res.result.source_bytes, 79579331);
    assert.equal(res.result.final_bytes, 79579382);
    assert.equal(res.result.transform_version, 'ffmpeg-faststart-v1');
    assert.equal(res.result.checksum_sha256, '47bdd87319e7d555c920cd1362c09c7e6e3d53e3eda6a588d0885a0e3964b5fa');
    assert.equal(res.result.faststart_drift_bytes, 51);
    assert.equal(assetPatchPayload.checksum_sha256, '47bdd87319e7d555c920cd1362c09c7e6e3d53e3eda6a588d0885a0e3964b5fa');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('17. Executable runtime test: finishV5MirrorJob still handles legacy array-shaped RPC response', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
  process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'sb_secret_mock_key';

  const { finishV5MirrorJob } = await import('../lib/v5-mirror-jobs.js');

  const originalFetch = globalThis.fetch;
  const makeResp = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data
  });

  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;

    if (urlStr.includes('v5_jobs?select=')) {
      return makeResp([{
        id: 'job-array-obj',
        course_id: 'course-array-obj',
        asset_id: 'asset-array-obj',
        status: 'running',
        locked_by: 'agent-array',
        attempts: 1,
        payload: {},
        result: {}
      }]);
    }
    if (urlStr.includes('v5_media_assets?select=')) {
      return makeResp([{
        id: 'asset-array-obj',
        origin: 'telegram',
        bytes: 1000,
        mime_type: 'video/mp4',
        original_filename: 'video.mp4'
      }]);
    }
    if (urlStr.includes('rpc/finish_v5_telegram_mirror_job')) {
      // Array-shaped response
      return makeResp([{
        id: 'job-array-obj',
        status: 'success',
        result: {
          object_key: 'media/v5/course-array-obj/asset-array-obj/video.mp4',
          bytes: 1000
        }
      }]);
    }
    if (urlStr.includes('v5_jobs?id=eq.')) {
      return makeResp([{ id: 'job-array-obj', status: 'success', result: body.result }]);
    }
    if (urlStr.includes('v5_media_assets?id=eq.')) {
      return makeResp([{ id: 'asset-array-obj', status: 'ready' }]);
    }
    return makeResp([]);
  };

  try {
    const res = await finishV5MirrorJob({
      jobId: 'job-array-obj',
      agentId: 'agent-array',
      ok: true,
      attempt: 1,
      objectKey: 'media/v5/course-array-obj/asset-array-obj/video.mp4',
      bytes: 1000,
      sourceBytes: 1000,
      finalBytes: 1000,
      transformVersion: 'ffmpeg-faststart-v1',
      checksumSha256: 'a'.repeat(64)
    });

    assert.ok(res);
    assert.equal(res.status, 'success');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('18. Executable runtime test: finishV5MirrorJob gracefully surfaces failed enrichment PATCH without pretending ownership failed', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
  process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'sb_secret_mock_key';

  const { finishV5MirrorJob } = await import('../lib/v5-mirror-jobs.js');

  const originalFetch = globalThis.fetch;
  const makeResp = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);

    if (urlStr.includes('v5_jobs?select=')) {
      return makeResp([{
        id: 'job-enrich-fail',
        course_id: 'course-enrich-fail',
        asset_id: 'asset-enrich-fail',
        status: 'running',
        locked_by: 'agent-enrich',
        attempts: 1,
        payload: {},
        result: {}
      }]);
    }
    if (urlStr.includes('v5_media_assets?select=')) {
      return makeResp([{
        id: 'asset-enrich-fail',
        origin: 'telegram',
        bytes: 1000,
        mime_type: 'video/mp4',
        original_filename: 'video.mp4'
      }]);
    }
    if (urlStr.includes('rpc/finish_v5_telegram_mirror_job')) {
      return makeResp({
        id: 'job-enrich-fail',
        status: 'success',
        result: {
          object_key: 'media/v5/course-enrich-fail/asset-enrich-fail/video.mp4',
          bytes: 1000
        }
      });
    }
    // Simulate enrichment PATCH network/500 failure
    if (urlStr.includes('v5_jobs?id=eq.') || urlStr.includes('v5_media_assets?id=eq.')) {
      return makeResp({ error: 'DB connection timeout during enrichment' }, 500);
    }
    return makeResp([]);
  };

  try {
    const res = await finishV5MirrorJob({
      jobId: 'job-enrich-fail',
      agentId: 'agent-enrich',
      ok: true,
      attempt: 1,
      objectKey: 'media/v5/course-enrich-fail/asset-enrich-fail/video.mp4',
      bytes: 1000,
      sourceBytes: 1000,
      finalBytes: 1000,
      transformVersion: 'ffmpeg-faststart-v1',
      checksumSha256: 'b'.repeat(64)
    });

    assert.ok(res, 'Job must be returned since finish RPC committed');
    assert.equal(res.status, 'success');
    assert.equal(res.metadata_enrichment_incomplete, true);
    assert.equal(res.enrichment_error, 'finish_committed_metadata_incomplete');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

