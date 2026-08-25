import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manager = read('server/admin/reader-manager.js');
const pairing = read('reader-manager/reader_manager_pairing.py');
const guard = read('lib/v4-playback-guard.js');
const agent = read('reader-cli/reader_agent.py');
const admin = read('public/index.html');
const config = read('lib/clone-config.js');

assert.match(manager, /cloneConfig\(\)\.clonerPublicUrl/);
assert.match(pairing, /os\.getenv\("CLONER_URL"/);
assert.match(pairing, /urlparse\(DEFAULT_CLONER_URL\)/);
assert.match(config, /clonerPublicUrl: 'https:\/\/reader\.yeubep\.shop'/);
assert.match(config, /v4PublicUrl: 'https:\/\/v4\.daubepnho\.store'/);
assert.match(guard, /isConfiguredV4Origin/);
assert.match(agent, /https:\/\/reader\.yeubep\.shop/);
assert.match(admin, /runtimeConfig\.lmsPublicUrl/);

console.log('YeuBep Cloner domain routing checks passed');
