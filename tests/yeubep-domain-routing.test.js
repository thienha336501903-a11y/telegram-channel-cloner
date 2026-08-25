import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manager = read('server/admin/reader-manager.js');
const pairing = read('reader-manager/reader_manager_pairing.py');
const guard = read('lib/v4-playback-guard.js');
const agent = read('reader-cli/reader_agent.py');
const admin = read('public/index.html');

assert.match(manager, /https:\/\/reader\.yeubep\.shop/);
assert.match(pairing, /DEFAULT_CLONER_URL = "https:\/\/reader\.yeubep\.shop"/);
assert.match(pairing, /PRODUCTION_CLONER_HOST = "reader\.yeubep\.shop"/);
assert.match(guard, /host === 'daubepnho\.store'/);
assert.match(agent, /https:\/\/reader\.yeubep\.shop/);
assert.match(admin, /host==='hoc\.yeubep\.shop'/);

console.log('YeuBep Cloner domain routing checks passed');
