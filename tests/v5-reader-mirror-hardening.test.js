import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const worker = read('reader-cli/mirror_v5_r2.py');
const agent = read('reader-manager/reader_manager_agent.py');
const jobs = read('lib/v5-mirror-jobs.js');
const installer = read('reader-manager/installer.iss');

test('1. mirror_v5_r2.py supports --progress-file and reports download and upload stages', () => {
  assert.match(worker, /--progress-file/);
  assert.match(worker, /def report_progress\(progress_file, stage, current, total\):/);
  assert.match(worker, /report_progress\(progress_file, "telegram_download",/);
  assert.match(worker, /report_progress\(progress_file, "r2_upload",/);
});

test('2. Video / document integrity is strictly preserved (size mismatch raises exception)', () => {
  assert.match(worker, /if expected_bytes and actual != int\(expected_bytes\):\s*\n\s*raise RuntimeError\(f"telegram_download_size_mismatch:\{actual\}\/\{expected_bytes\}"\)/);
  assert.match(jobs, /if \(!isPhotoOrThumbnail\(asset\) && expectedBytes !== null && expectedBytes > 0 && reportedBytes !== expectedBytes\) \{\s*\n\s*throw new Error\(`v5_mirror_size_mismatch:\$\{reportedBytes\}\/\$\{expectedBytes\}`\);/);
});

test('3. Telegram photo chooses indexed size and rejects divergent representation before upload', () => {
  assert.match(worker, /photo_size = exact_photo_size\(message, expected_bytes\)/);
  assert.match(worker, /target\.unlink\(missing_ok=True\)/);
  assert.match(worker, /thumb=telegram_thumb_selector\(photo_size\)/);
  assert.match(worker, /raise RuntimeError\(f"telegram_photo_size_mismatch:\{actual\}\/\{expected_bytes\}"\)/);
});

test('4. Telegram thumbnail chooses indexed size and rejects mismatch', () => {
  assert.match(worker, /async def download_thumbnail\(client, entity, message_id, target, expected_bytes=0, progress_file=None\):/);
  assert.match(worker, /thumb=telegram_thumb_selector\(matches\[0\]\) if matches else -1/);
  assert.match(worker, /raise RuntimeError\(f"telegram_thumbnail_size_mismatch:\{actual\}\/\{expected\}"\)/);
  assert.match(jobs, /asset\.metadata\?\.telegram\?\.variant === 'thumbnail'/);
});

test('5. R2 HEAD validation ensures Content-Length matches canonical actual bytes', () => {
  assert.match(worker, /head = head_matching_object\(client, bucket, object_key, total_bytes\)/);
  assert.match(worker, /if not head:\s*\n\s*raise RuntimeError\("r2_size_mismatch_after_complete"\)/);
  assert.match(worker, /if uploaded\["bytes"\] != actual_bytes:\s*\n\s*raise RuntimeError\(f"mirror_size_mismatch:\{uploaded\['bytes'\]\}\/\{actual_bytes\}"\)/);
});

test('6. R2 object already complete avoids re-download and re-upload', () => {
  assert.match(worker, /if expected > 0:\s*\n\s*existing = head_matching_object\(r2_client\(\), bucket, args\.object_key, expected\)/);
  assert.match(worker, /print\(f"R2 object already complete before retry: \{expected\} bytes", flush=True\)/);
  assert.match(worker, /existing = head_matching_object\(client, bucket, object_key, total_bytes\)/);
  assert.match(worker, /print\(f"R2 object already complete: \{total_bytes\} bytes", flush=True\)/);
});

test('7. Short-lived access cache avoids repeated verify_access for the same channel within TTL', () => {
  assert.match(agent, /_SOURCE_ACCESS_CACHE = \{\}/);
  assert.match(agent, /SOURCE_ACCESS_CACHE_TTL = 240/);
  assert.match(agent, /def invalidate_source_access_cache\(source_id=None, channel=None, profile_id=None\):/);
  assert.match(agent, /if cache_key in _SOURCE_ACCESS_CACHE and \(now - _SOURCE_ACCESS_CACHE\[cache_key\]\) < SOURCE_ACCESS_CACHE_TTL:\s*\n\s*return profile/);
  assert.match(agent, /_SOURCE_ACCESS_CACHE\[cache_key\] = now/);
  assert.match(agent, /_SOURCE_ACCESS_CACHE\.pop\(cache_key, None\)/);
});

test('8. Telegram access/session errors invalidate the access cache immediately', () => {
  assert.match(agent, /if not ok and error and any\(term in error\.lower\(\) for term in \("access_denied", "channelprivate", "chatadminrequired", "authkey", "userdeactivated", "session"\)\):\s*\n\s*invalidate_source_access_cache\(source_id, channel, profile_id\)/);
});

test('9. Windows worker child process is spawned with CREATE_NO_WINDOW to hide console popup', () => {
  assert.match(agent, /if os\.name == "nt":\s*\n\s*popen_kwargs\["creationflags"\] = getattr\(subprocess, "CREATE_NO_WINDOW", 0x08000000\)/);
  assert.match(agent, /process = subprocess\.Popen\(command, env=env, \*\*popen_kwargs\)/);
});

test('10. Heartbeat reports active byte progress every ~2.5 seconds for v5_mirror jobs', () => {
  assert.match(agent, /heartbeat_interval = 2\.5 if job_type == "v5_mirror" else 10/);
  assert.match(agent, /current, total, stage = progress_info\(progress_file\)/);
  assert.match(agent, /api\(config, "v5-mirror-heartbeat", payload, timeout=20\)/);
  assert.match(agent, /time\.sleep\(1 if job_type == "v5_mirror" else 2\)/);
});

test('11. APP_VERSION bumped to 1.3.x / 1.4.x across reader_manager_agent and installer', () => {
  assert.match(agent, /APP_VERSION = "1\.[34]\.[0-9]+"/);
  assert.match(installer, /#define MyAppVersion "1\.[34]\.[0-9]+"/);
});
