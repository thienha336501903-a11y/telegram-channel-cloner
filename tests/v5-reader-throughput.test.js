import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const worker = read('reader-cli/mirror_v5_r2.py');
const agent = read('reader-manager/reader_manager_agent.py');
const jobs = read('lib/v5-mirror-jobs.js');

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

test('1. Small R2 objects use one PUT plus mandatory HEAD while larger objects retain multipart', () => {
  assert.match(worker, /SMALL_PUT_THRESHOLD = 8 \* 1024 \* 1024/);
  assert.match(worker, /if total_bytes <= SMALL_PUT_THRESHOLD:[\s\S]*?return upload_small_object/);
  assert.match(worker, /client\.put_object\(/);
  assert.match(worker, /client\.create_multipart_upload\(/);
  assert.match(worker, /client\.upload_part\(/);
  assert.match(worker, /client\.complete_multipart_upload\(/);
});

test('2. Functional small PUT writes exact bytes and verifies HEAD', () => {
  const script = `
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, 'reader-cli')
import mirror_v5_r2 as m

class FakeClient:
    def __init__(self):
        self.body = b''
        self.put_calls = 0
        self.head_calls = 0
    def put_object(self, **kwargs):
        self.put_calls += 1
        self.body = kwargs['Body'].read()
        return {'ETag': 'put-etag'}
    def head_object(self, **kwargs):
        self.head_calls += 1
        return {'ContentLength': len(self.body), 'ETag': 'head-etag'}

with tempfile.TemporaryDirectory() as td:
    p = Path(td) / 'small.bin'
    p.write_bytes(b'x' * 12345)
    progress = Path(td) / 'progress.json'
    client = FakeClient()
    result = m.upload_small_object(client, 'bucket', p, 'key', 'application/octet-stream', str(progress))
    assert client.put_calls == 1
    assert client.head_calls == 1
    assert result['bytes'] == 12345
    state = json.loads(progress.read_text())
    assert state['stage'] == 'r2_upload' and state['current'] == state['total'] == 12345
    print(json.dumps({'ok': True}))
`;
  const output = execFileSync(pythonBin, ['-c', script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(JSON.parse(output.trim().split('\n').pop()).ok, true);
});

test('3. Retry cache is preserved on failure and only cleaned after verified success', () => {
  assert.match(worker, /success = False/);
  assert.match(worker, /if success:\s*\n\s*remux_path\.unlink\(missing_ok=True\)\s*\n\s*local_path\.unlink\(missing_ok=True\)/);
  assert.match(worker, /if validate_faststart_cache\(local_path, remux_path\):/);
  assert.match(worker, /_telemetry\["cache"\]\["faststart_reused"\] = True/);
});

test('4. Cache GC is scoped to stale .part files and leaves checkpoints/arbitrary files alone', () => {
  assert.match(worker, /for path in root\.glob\("\*\.part"\)/);
  assert.doesNotMatch(worker, /glob\("\*\.r2\.json"\)/);
  const script = `
import json, os, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, 'reader-cli')
import mirror_v5_r2 as m

with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    old_part = root / 'old.part'
    protected = root / 'asset123-current.part'
    arbitrary = root / 'keep.txt'
    checkpoint = root / 'old.r2.json'
    for p in (old_part, protected, arbitrary, checkpoint): p.write_bytes(b'x')
    old = time.time() - (80 * 60 * 60)
    os.utime(old_part, (old, old)); os.utime(protected, (old, old)); os.utime(checkpoint, (old, old))
    m.cache_gc(root, protected_prefix='asset123')
    assert not old_part.exists()
    assert protected.exists()
    assert arbitrary.exists()
    assert checkpoint.exists()
    print(json.dumps({'ok': True}))
`;
  const output = execFileSync(pythonBin, ['-c', script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(JSON.parse(output.trim().split('\n').pop()).ok, true);
});

test('5. Telegram message is preloaded once in run and reused by download helpers', () => {
  assert.match(worker, /message_obj = await client\.get_messages\(entity, ids=int\(args\.message_id\)\)/);
  assert.match(worker, /download_thumbnail\([\s\S]*?message=message_obj/);
  assert.match(worker, /download_resumable\([\s\S]*?message=message_obj/);
  assert.match(worker, /message = message or await client\.get_messages\(entity, ids=int\(message_id\)\)/);
});

test('6. Concurrency is canary-controlled, defaults to one and is hard-capped at two', () => {
  assert.match(agent, /MAX_V5_MIRROR_CONCURRENCY = 2/);
  assert.match(agent, /raw = config\.get\("v5_mirror_concurrency", 1\)/);
  assert.match(agent, /return max\(1, min\(MAX_V5_MIRROR_CONCURRENCY, value\)\)/);
  assert.match(agent, /os\.getenv\("V5_MIRROR_CONCURRENCY"\)/);
});

test('7. Generic import/reconcile is exclusive between mirror batches', () => {
  const activeBranch = agent.indexOf('if active > 0:');
  const genericClaim = agent.indexOf('job = claim_generic_job(config)');
  const mirrorBatch = agent.indexOf('started = start_mirror_batch(config, stop_event, status_callback)');
  assert.ok(activeBranch >= 0 && genericClaim > activeBranch && mirrorBatch > genericClaim);
  assert.match(agent, /Generic import\/reconcile remains exclusive and always has priority/);
});

test('8. Shared profile remains busy until its final concurrent mirror exits', () => {
  assert.match(agent, /_PROFILE_ACTIVE_COUNTS = \{\}/);
  assert.match(agent, /def acquire_profile_usage\(config, profile_id\):/);
  assert.match(agent, /_PROFILE_ACTIVE_COUNTS\[profile_id\] = previous \+ 1/);
  assert.match(agent, /if previous == 0:[\s\S]*?"status": "busy"/);
  assert.match(agent, /def release_profile_usage\(config, profile_id\):[\s\S]*?should_mark_ready = True[\s\S]*?"status": "ready"/);
});

test('9. Flood/rate/timeout errors pause claims and temporarily degrade to concurrency one', () => {
  assert.match(agent, /def rate_limit_wait_seconds\(error\):/);
  assert.match(agent, /"floodwait"/);
  assert.match(agent, /"too many requests"/);
  assert.match(agent, /def effective_mirror_concurrency\(config\):[\s\S]*?return 0[\s\S]*?return 1[\s\S]*?return configured/);
  assert.match(agent, /Telegram đang giới hạn tạm thời · Reader tự giảm tốc/);
});

test('10. Telemetry persisted to job payload is whitelist-only and preserves source payload', () => {
  assert.match(jobs, /body: \{ payload: \{ \.\.\.payload, reader_telemetry: safe \} \}/);
  assert.match(jobs, /allowedTimings/);
  assert.match(jobs, /telegram_reused/);
  assert.match(jobs, /r2_small_put/);
  assert.doesNotMatch(jobs, /reader_telemetry.*(?:agent_token|api_hash|secret_access_key|session)/i);
});
