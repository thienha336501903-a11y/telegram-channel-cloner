import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const worker = read('reader-cli/mirror_v5_r2.py');
const agent = read('reader-manager/reader_manager_agent.py');
const control = read('api/reader/complete.js');
const jobs = read('lib/v5-mirror-jobs.js');
const installer = read('reader-manager/installer.iss');

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  try {
    const { execSync } = require('node:child_process');
    const cmd = process.platform === 'win32' ? 'where.exe python' : 'which python || which python3';
    return execSync(cmd, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {
    return 'python';
  }
}

test('1. Concurrency strictly remains 1 across claim and execution', () => {
  assert.match(jobs, /claim_v5_telegram_mirror_job/);
  // Claim RPC claims at most one job
  assert.match(jobs, /const claimed = one\(await db\('rpc\/claim_v5_telegram_mirror_job'/);
  // Agent loop processes jobs sequentially
  assert.match(agent, /job = claim_next_job\(config\)\s*\n\s*if job:\s*\n\s*run_job\(config, job, stop_event, status_callback\)/);
  assert.doesNotMatch(agent, /max_workers\s*=\s*[2-9]/);
  assert.doesNotMatch(jobs, /p_concurrency/);
});

test('2. Duplicate Telegram message fetch is removed and message object is reused', () => {
  // Canonical fetch in run()
  assert.match(worker, /message_obj = await client\.get_messages\(entity, ids=int\(args\.message_id\)\)/);
  assert.match(worker, /if not message_obj or not getattr\(message_obj, "media", None\):/);
  // Photo check on canonical message
  assert.match(worker, /if getattr\(message_obj, "photo", None\) or getattr\(getattr\(message_obj, "media", None\), "photo", None\):/);
  // Passed directly to download functions
  assert.match(worker, /download_thumbnail\(client, entity, message_obj,/);
  assert.match(worker, /download_resumable\(client, entity, message_obj,/);
  // Functions accept message object directly
  assert.match(worker, /if hasattr\(message_id, "media"\):\s*\n\s*message = message_id/);
});

test('3. Small-object R2 fast path (< 8 MiB) uses single PUT and verifies exact size', () => {
  assert.match(worker, /SMALL_OBJECT_THRESHOLD_BYTES = 8 \* 1024 \* 1024/);
  assert.match(worker, /def upload_small_object\(client, bucket, key, local_path, content_type,/);
  assert.match(worker, /client\.put_object\(/);
  assert.match(worker, /total_bytes < SMALL_OBJECT_THRESHOLD_BYTES/);
  assert.match(worker, /upload_small_object\(client, bucket, object_key, local_path, content_type/);
  // Small object verify
  assert.match(worker, /head = head_matching_object\(client, bucket, key, total_bytes\)/);
  assert.match(worker, /if not head:\s*\n\s*raise RuntimeError\("r2_size_mismatch_after_complete"\)/);
});

test('4. Multipart upload path is preserved for large media (>= 8 MiB)', () => {
  assert.match(worker, /PART_SIZE = 16 \* 1024 \* 1024/);
  assert.match(worker, /client\.create_multipart_upload/);
  assert.match(worker, /client\.upload_part\(/);
  assert.match(worker, /client\.complete_multipart_upload/);
  assert.match(worker, /load_or_create_checkpoint/);
  assert.match(worker, /atomic_json\(checkpoint_path, checkpoint\)/);
});

test('5. Progress telemetry calculates rate, ETA, percent, and elapsed ms safely', () => {
  assert.match(worker, /def report_progress\(progress_file, stage, current, total\):/);
  assert.match(worker, /"bytes_per_second":/);
  assert.match(worker, /"mb_per_second":/);
  assert.match(worker, /"eta_seconds":/);
  assert.match(worker, /"percent":/);
  assert.match(worker, /"elapsed_ms":/);
});

test('6. Reader Agent extracts progress telemetry and forwards safe fields in heartbeat', () => {
  assert.match(agent, /def progress_telemetry\(path\):/);
  assert.match(agent, /telem = progress_telemetry\(progress_file\)/);
  assert.match(agent, /if telem\.get\("stage"\):\s*\n\s*payload\["progress_stage"\] = telem\["stage"\]/);
  assert.match(agent, /if telem\.get\("bytes_per_second"\) is not None:\s*\n\s*payload\["bytes_per_second"\] = telem\["bytes_per_second"\]/);
  assert.match(agent, /if telem\.get\("eta_seconds"\) is not None:\s*\n\s*payload\["eta_seconds"\] = telem\["eta_seconds"\]/);
  // Backward compatibility preserved
  assert.match(agent, /current, total, stage = progress_info\(progress_file\)/);
  assert.match(agent, /payload = \{"job_id": job_id\}/);
  assert.match(agent, /if current is not None:\s*\n\s*payload\["progress_current"\] = current/);
  assert.match(agent, /if total is not None:\s*\n\s*payload\["progress_total"\] = total/);
});

test('7. Local cache preservation and reuse across retries', () => {
  assert.match(worker, /def can_reuse_download_cache\(local_path, manifest, channel, message_id, expected_bytes, is_photo\):/);
  assert.match(worker, /def can_reuse_faststart_cache\(remux_path, manifest, channel, message_id\):/);
  assert.match(worker, /def save_cache_manifest\(asset_id, data\):/);
  assert.match(worker, /def load_cache_manifest\(asset_id\):/);
  assert.match(worker, /clean_asset_cache\(args\.asset_id, local_name\)/);
  // Reused cache messages
  assert.match(worker, /Reusing existing downloaded Telegram media cache/);
  assert.match(worker, /Reusing existing verified faststart remux cache/);
});

test('8. Cache garbage collection enforces TTL and size limits without evicting active jobs', () => {
  assert.match(worker, /CACHE_TTL_SECONDS = 24 \* 60 \* 60/);
  assert.match(worker, /MAX_CACHE_BYTES = 10 \* 1024 \* 1024 \* 1024/);
  assert.match(worker, /is_active = any\(p\.name\.startswith\(f"\{active_id\}/);
});

test('9. StageTimer instruments per-stage timings without exposing credentials', () => {
  assert.match(worker, /class StageTimer:/);
  assert.match(worker, /timer\.start_stage\("telegram_connect"\)/);
  assert.match(worker, /timer\.start_stage\("telegram_resolve_channel"\)/);
  assert.match(worker, /timer\.start_stage\("telegram_message_fetch"\)/);
  assert.match(worker, /timer\.start_stage\("telegram_download"\)/);
  assert.match(worker, /timer\.start_stage\("faststart_source_probe"\)/);
  assert.match(worker, /timer\.start_stage\("faststart_remux"\)/);
  assert.match(worker, /timer\.start_stage\("faststart_output_probe_verify"\)/);
  assert.match(worker, /timer\.start_stage\("r2_preflight_head"\)/);
  assert.match(worker, /timer\.start_stage\("r2_upload"\)/);
  assert.match(worker, /timer\.start_stage\("r2_complete"\)/);
  assert.match(worker, /timer\.start_stage\("r2_final_head_verify"\)/);
  assert.match(worker, /"timings_ms": timer\.timings/);
  assert.match(worker, /"total_worker_time_ms": timer\.total_elapsed_ms\(\)/);
  assert.doesNotMatch(worker, /TELEGRAM_SESSION_STRING.*telemetry/s);
});

test('10. Telemetry and agent never touch legacy System A or external domains', () => {
  assert.doesNotMatch(worker, /daubepnho\.store/);
  assert.doesNotMatch(agent, /daubepnho\.store/);
  assert.doesNotMatch(control, /daubepnho\.store/);
  assert.doesNotMatch(jobs, /daubepnho\.store/);
});

test('11. Functional Python test: cache reuse, manifest, and GC execution', () => {
  const pyScript = `
import json, tempfile, time, sys
from pathlib import Path
sys.path.insert(0, 'reader-cli')
import mirror_v5_r2

with tempfile.TemporaryDirectory() as td:
    cache_dir = Path(td)
    asset_id = "test-asset-123"
    local_path = cache_dir / f"{asset_id}-sample.part"
    local_path.write_bytes(b"sample video bytes content 12345")
    size = local_path.stat().st_size

    # 1. Test manifest save/load
    mirror_v5_r2.cache_root = lambda: cache_dir
    manifest = {"channel": "@testchannel", "message_id": 42, "download_size": size}
    mirror_v5_r2.save_cache_manifest(asset_id, manifest)
    loaded = mirror_v5_r2.load_cache_manifest(asset_id)
    assert loaded.get("channel") == "@testchannel"
    assert loaded.get("download_size") == size

    # 2. Test can_reuse_download_cache
    ok = mirror_v5_r2.can_reuse_download_cache(local_path, loaded, "@testchannel", 42, size, False)
    assert ok is True

    # 3. Test mismatch detection
    bad_chan = mirror_v5_r2.can_reuse_download_cache(local_path, loaded, "@wrongchannel", 42, size, False)
    assert bad_chan is False

    bad_msg = mirror_v5_r2.can_reuse_download_cache(local_path, loaded, "@testchannel", 999, size, False)
    assert bad_msg is False

    # 4. Test run_cache_gc
    old_file = cache_dir / "old-asset-sample.part"
    old_file.write_bytes(b"old stale data")
    # Simulate old mtime (48 hours ago)
    old_time = time.time() - (48 * 3600)
    import os
    os.utime(old_file, (old_time, old_time))

    active_file = cache_dir / "active-asset-sample.part"
    active_file.write_bytes(b"active data")
    os.utime(active_file, (old_time, old_time))

    gc_res = mirror_v5_r2.run_cache_gc(cache_dir=cache_dir, active_asset_ids=["active-asset"], max_age_seconds=86400)
    assert not old_file.exists(), "Old file must be evicted"
    assert active_file.exists(), "Active asset file must NOT be evicted"
    assert local_path.exists(), "Recent file must not be evicted"

    # 5. Test clean_asset_cache
    mirror_v5_r2.clean_asset_cache(asset_id, "sample")
    assert not local_path.exists(), "Cleaned cache must unlink local_path"

    print(json.dumps({"ok": True, "gc_evicted": gc_res["evicted_count"]}))
`;
  const pythonBin = resolvePython();
  const output = execFileSync(pythonBin, ['-c', pyScript], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.ok, true);
  assert.ok(result.gc_evicted >= 1);
});
