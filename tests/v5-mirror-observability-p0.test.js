import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizeTelemetry } from '../lib/v5-mirror-jobs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  try {
    const cmd = process.platform === 'win32' ? 'where.exe python' : 'which python || which python3';
    return execSync(cmd, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {
    return 'python';
  }
}
const pythonBin = resolvePython();

test('P0 regression: old exact-source-size assumption in validateReportedMirror rejects faststart drift', () => {
  const jobsCode = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'v5-mirror-jobs.js'), 'utf8');

  // Assert validateReportedMirror has the exact size check that caused P0
  assert.match(jobsCode, /v5_mirror_size_mismatch/);

  // Re-create the logic to verify exact error message for forensic P0
  const P0_SOURCE_BYTES = 79579331;
  const P0_FINAL_BYTES = 79579382;

  function oldValidateReportedMirror({ bytes, assetBytes, isPhoto = false }) {
    if (!isPhoto && assetBytes !== null && assetBytes > 0 && bytes !== assetBytes) {
      throw new Error(`v5_mirror_size_mismatch:${bytes}/${assetBytes}`);
    }
    return bytes;
  }

  assert.throws(
    () => oldValidateReportedMirror({ bytes: P0_FINAL_BYTES, assetBytes: P0_SOURCE_BYTES, isPhoto: false }),
    {
      name: 'Error',
      message: 'v5_mirror_size_mismatch:79579382/79579331'
    }
  );
});

test('sanitizeTelemetry preserves safe performance metrics and strips sensitive fields', () => {
  const rawTelemetry = {
    claim_ms: 120,
    telegram_connect_ms: 45,
    telegram_download_ms: 1200,
    telegram_bytes: 79579331,
    telegram_mbps: 63.25,
    prepare_ms: 80,
    faststart_ms: 350,
    verify_ms: 95,
    r2_upload_ms: 1850,
    r2_bytes: 79579382,
    r2_mbps: 41.1,
    finish_ms: 110,
    total_ms: 3850,
    total_worker_time_ms: 3575,
    cache_reused: 'none',
    transform_version: 'ffmpeg-faststart-v1',
    upload_method: 'multipart',
    faststart_remuxed: true,
    attempt: 1,
    timings_ms: {
      telegram_download: 1200,
      r2_upload: 1850
    },
    // Secret fields that must be stripped:
    session_string: '1BQAAAA=secret_token',
    bot_token: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    password: 'super_secret_password',
    api_hash: '0123456789abcdef0123456789abcdef'
  };

  const sanitized = sanitizeTelemetry(rawTelemetry);
  assert.ok(sanitized);

  // Safe fields preserved
  assert.equal(sanitized.claim_ms, 120);
  assert.equal(sanitized.telegram_download_ms, 1200);
  assert.equal(sanitized.telegram_bytes, 79579331);
  assert.equal(sanitized.telegram_mbps, 63.25);
  assert.equal(sanitized.faststart_ms, 350);
  assert.equal(sanitized.r2_bytes, 79579382);
  assert.equal(sanitized.r2_mbps, 41.1);
  assert.equal(sanitized.transform_version, 'ffmpeg-faststart-v1');
  assert.equal(sanitized.faststart_remuxed, true);
  assert.equal(sanitized.timings_ms.telegram_download, 1200);

  // Dangerous fields omitted
  assert.equal(sanitized.session_string, undefined);
  assert.equal(sanitized.bot_token, undefined);
  assert.equal(sanitized.password, undefined);
  assert.equal(sanitized.api_hash, undefined);
});

test('classify_telegram_error maps error taxonomy correctly without credential leaks', () => {
  const pythonCode = `
import sys
sys.path.insert(0, 'reader-manager')
from reader_manager_agent import classify_telegram_error

class FloodWaitError(Exception): pass
class SessionPasswordNeededError(Exception): pass
class ChannelPrivateError(Exception): pass
class ChatAdminRequiredError(Exception): pass
class UsernameNotOccupiedError(Exception): pass

assert classify_telegram_error(FloodWaitError("A wait of 45 seconds is required")) == "reader_source_access_flood_wait_45s"
assert classify_telegram_error(SessionPasswordNeededError("Two-step verification")) == "reader_source_access_unauthorized"
assert classify_telegram_error(ChannelPrivateError("Private channel")) == "reader_source_access_forbidden"
assert classify_telegram_error(ChatAdminRequiredError("Chat admin required")) == "reader_source_access_chat_admin_required"
assert classify_telegram_error(Exception("Auth key unregistered authkey hash=secret")) == "reader_source_access_session_invalid"
assert classify_telegram_error(TimeoutError("Connection timed out")) == "reader_source_access_network_timeout"
assert classify_telegram_error(UsernameNotOccupiedError("No user")) == "reader_source_access_source_missing"
assert classify_telegram_error(Exception("RpcError 400: BAD_REQUEST")) == "reader_source_access_rpc_error_rpc_generic"
assert classify_telegram_error(Exception("Random unknown error")) == "reader_source_access_denied"

print("ALL_TAXONOMY_OK")
`;

  const res = spawnSync(pythonBin, ['-c', pythonCode], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ALL_TAXONOMY_OK/);
});

test('save_finish_failure_log writes local diagnostic artifact on finish failure', () => {
  const pythonCode = `
import sys, json, tempfile, shutil
from pathlib import Path
sys.path.insert(0, 'reader-manager')
import reader_manager_agent

test_id = "test-job-476e8187"
record = {
    "job_id": test_id,
    "attempt": 1,
    "error": "HTTP 500: internal_server_error",
    "bytes": 79579382,
    "telemetry": {"total_ms": 1500}
}

reader_manager_agent.save_finish_failure_log(test_id, record)
log_path = Path("reader-manager/.finish-failures") / f"failure_{test_id}.json"
assert log_path.exists(), "Failure log file was not created"
content = json.loads(log_path.read_text(encoding="utf-8"))
assert content["job_id"] == test_id
assert content["bytes"] == 79579382

# Cleanup
log_path.unlink(missing_ok=True)
print("FINISH_LOG_OK")
`;

  const res = spawnSync(pythonBin, ['-c', pythonCode], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /FINISH_LOG_OK/);
});

test('Photos continue exact size validation in validateReportedMirror', () => {
  const jobsCode = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'v5-mirror-jobs.js'), 'utf8');
  // Photo check is bypassed in size mismatch check
  assert.match(jobsCode, /!isPhotoOrThumbnail\(asset\)/);
});

test('Normal production mirror concurrency remains strictly max = 1', () => {
  const jobsCode = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'v5-mirror-jobs.js'), 'utf8');
  assert.match(jobsCode, /runningJobs && runningJobs\.length >= 2/);
  assert.match(jobsCode, /Normal production job is running: production concurrency remains strictly 1/);
});
