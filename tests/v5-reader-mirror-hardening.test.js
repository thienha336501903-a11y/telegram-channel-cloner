import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const worker = read('reader-cli/mirror_v5_r2.py');
const agent = read('reader-manager/reader_manager_agent.py');
const jobs = read('lib/v5-mirror-jobs.js');
const api = read('api/reader/complete.js');
const installer = read('reader-manager/installer.iss');

test('1. Mirror progress includes stages, byte rate and ETA without identifiers', () => {
  assert.match(worker, /def report_progress\(progress_file, stage, current=0, total=None\):/);
  assert.match(worker, /"rate_bps": rate_bps/);
  assert.match(worker, /"eta_seconds": eta_seconds/);
  assert.match(worker, /"stage_elapsed_ms": int\(elapsed \* 1000\)/);
  assert.match(worker, /report_progress\(progress_file, "telegram_download"/);
  assert.match(worker, /report_progress\(progress_file, "r2_upload"/);
  assert.doesNotMatch(worker, /"channel":.*progress/i);
});

test('2. Video and document integrity still fails closed on Telegram or R2 byte mismatch', () => {
  assert.match(worker, /if not is_photo:\s*\n\s*raise RuntimeError\(f"telegram_download_size_mismatch:\{actual\}\/\{total\}"\)/);
  assert.match(jobs, /if \(!isPhotoOrThumbnail && expectedBytes !== null && expectedBytes > 0 && reportedBytes !== expectedBytes\)/);
  assert.match(worker, /if uploaded\["bytes"\] != actual_bytes:\s*\n\s*raise RuntimeError\(f"mirror_size_mismatch:/);
});

test('3. Photo mismatch still falls back to a fresh validated Telegram download', () => {
  assert.match(worker, /target\.unlink\(missing_ok=True\)\s*\n\s*downloaded = await client\.download_media\(message\.media, file=str\(target\)\)/);
  assert.match(worker, /if not downloaded or not target\.exists\(\):\s*\n\s*raise RuntimeError\("telegram_photo_fresh_download_missing"\)/);
  assert.match(worker, /if actual <= 0:\s*\n\s*raise RuntimeError\("telegram_photo_fresh_download_empty"\)/);
});

test('4. Thumbnail path validates non-empty and can reuse an exact local cache', () => {
  assert.match(worker, /async def download_thumbnail\([\s\S]*?message=None,/);
  assert.match(worker, /if expected > 0 and existing == expected:[\s\S]*?_telemetry\["cache"\]\["telegram_reused"\] = True/);
  assert.match(worker, /raise RuntimeError\("telegram_thumbnail_empty"\)/);
});

test('5. Final R2 verification remains mandatory after both multipart and small PUT', () => {
  assert.match(worker, /head = head_matching_object\(client, bucket, object_key, total_bytes\)/);
  assert.match(worker, /raise RuntimeError\("r2_size_mismatch_after_complete"\)/);
  assert.match(worker, /raise RuntimeError\("r2_size_mismatch_after_put"\)/);
});

test('6. Complete R2 object can short-circuit a retry before Telegram download', () => {
  assert.match(worker, /if expected > 0:[\s\S]*?existing = head_matching_object\(r2_client\(\), bucket, args\.object_key, expected\)/);
  assert.match(worker, /_telemetry\["cache"\]\["r2_already_complete"\] = True/);
  assert.match(worker, /return \{[\s\S]*?"object_key": args\.object_key,[\s\S]*?"telemetry": telemetry_snapshot\(\)/);
});

test('7. Source access cache is serialized for C2 and invalidation is lock protected', () => {
  assert.match(agent, /_SOURCE_ACCESS_LOCK = threading\.RLock\(\)/);
  assert.match(agent, /SOURCE_ACCESS_CACHE_TTL = 240/);
  assert.match(agent, /def invalidate_source_access_cache\(source_id=None, channel=None, profile_id=None\):\s*\n\s*with _SOURCE_ACCESS_LOCK:/);
  assert.match(agent, /def choose_v5_profile\([\s\S]*?with _SOURCE_ACCESS_LOCK:/);
  assert.match(agent, /cached_at and \(now - cached_at\) < SOURCE_ACCESS_CACHE_TTL/);
});

test('8. Telegram access/session errors invalidate source cache immediately', () => {
  assert.match(agent, /if not ok and error and any\([\s\S]*?"access_denied"[\s\S]*?"session"[\s\S]*?invalidate_source_access_cache\(source_id, channel, profile_id\)/);
});

test('9. Windows worker process remains hidden and mirror workers stay separate processes', () => {
  assert.match(agent, /popen_kwargs\["creationflags"\] = getattr\(subprocess, "CREATE_NO_WINDOW", 0x08000000\)/);
  assert.match(agent, /process = subprocess\.Popen\(command, env=env, \*\*popen_kwargs\)/);
  assert.match(agent, /"mirror_v5_r2\.py": "YeuNauAnReaderMirror\.exe"/);
});

test('10. V5 heartbeat keeps byte progress while Reader UI receives rate and ETA', () => {
  assert.match(agent, /heartbeat_interval = 2\.5 if job_type == "v5_mirror" else 10/);
  assert.match(agent, /progress = progress_info\(progress_file\)/);
  assert.match(agent, /payload\["progress_current"\] = progress\["current"\]/);
  assert.match(agent, /payload\["progress_total"\] = progress\["total"\]/);
  assert.match(agent, /api\(config, "v5-mirror-heartbeat", payload, timeout=20\)/);
  assert.match(agent, /progress_detail\(progress\)/);
});

test('11. Reader 1.4.0 is explicit across agent and installer', () => {
  assert.match(agent, /APP_VERSION = "1\.4\.0"/);
  assert.match(installer, /#define MyAppVersion "1\.4\.0"/);
});

test('12. Final telemetry is sanitized server-side and merged without replacing existing job payload', () => {
  assert.match(jobs, /function safeMirrorTelemetry\(value\)/);
  assert.match(jobs, /reader_telemetry: safe/);
  assert.match(jobs, /payload: \{ \.\.\.payload, reader_telemetry: safe \}/);
  assert.match(jobs, /await persistMirrorTelemetry\(jobId, agentId, telemetry\)\.catch\(\(\) => null\)/);
  assert.match(api, /telemetry: body\.telemetry/);
});

test('13. Diagnostic telemetry whitelist contains timings, bytes and booleans only', () => {
  assert.match(jobs, /const allowedTimings = new Set\(\[/);
  assert.match(jobs, /for \(const key of \['telegram', 'uploaded'\]\)/);
  assert.match(jobs, /for \(const key of \['telegram_reused', 'faststart_reused', 'r2_already_complete', 'r2_small_put'\]\)/);
  assert.doesNotMatch(jobs, /reader_telemetry.*(?:token|secret|session|api_hash)/i);
});
