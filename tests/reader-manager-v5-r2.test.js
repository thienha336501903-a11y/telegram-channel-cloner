import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const agent = read('reader-manager/reader_manager_agent.py');
const gui = read('reader-manager/reader_manager_gui.py');
const storage = read('reader-manager/reader_manager_storage.py');
const build = read('reader-manager/build.ps1');
const installer = read('reader-manager/installer.iss');

test('managed Windows Reader claims V5 mirror only with encrypted local R2 config', () => {
  assert.match(agent, /APP_VERSION = "1\.3\.0"/);
  assert.match(agent, /V5_MIRROR_CAPABILITY = "v5_r2_mirror_v1"/);
  assert.match(agent, /def has_v5_r2_config\(config\):/);
  assert.match(agent, /if has_v5_r2_config\(config\):[\s\S]*values\.append\(V5_MIRROR_CAPABILITY\)/);
  assert.match(agent, /"R2_ACCOUNT_ID": str\(r2\["account_id"\]\)/);
  assert.match(agent, /"R2_SECRET_ACCESS_KEY": str\(r2\["secret_access_key"\]\)/);
  assert.match(agent, /api\(config, "v5-mirror-claim"/);
  assert.match(agent, /api\(config, "v5-mirror-heartbeat"/);
  assert.match(agent, /api\(config, "v5-mirror-finish"/);
  assert.match(storage, /CryptProtectData/);
  assert.match(storage, /reader-manager\.dat/);
});

test('managed Reader verifies Telegram source access before mirroring', () => {
  assert.match(agent, /def choose_v5_profile\(/);
  assert.match(agent, /asyncio\.run\(verify_access\(profile, channel\)\)/);
  assert.match(agent, /"source-access"/);
  assert.match(agent, /reader_source_access_denied/);
  assert.match(agent, /profile\.get\("status"\).*== "ready"/s);
});

test('R2 credentials are entered in GUI and persisted through DPAPI config only', () => {
  assert.match(gui, /Cấu hình R2 V5/);
  assert.match(gui, /Secret Access Key \(để trống để giữ secret hiện tại\)/);
  assert.match(gui, /config\["r2"\] = values/);
  assert.match(gui, /save_config\(config\)/);
  assert.match(gui, /mã hóa bằng Windows DPAPI/);
  assert.doesNotMatch(gui, /requests\.post\([\s\S]{0,300}secret_access_key/);
});

test('Windows installer ships the dedicated R2 mirror executable', () => {
  assert.match(build, /--name YeuNauAnReaderMirror reader-cli\/mirror_v5_r2\.py/);
  assert.match(build, /Copy-Item -Force dist\/YeuNauAnReaderMirror\.exe/);
  assert.match(installer, /MyAppVersion "1\.3\.0"/);
  assert.match(installer, /YeuNauAnReaderMirror\.exe/);
  assert.match(installer, /PrivilegesRequired=lowest/);
});
