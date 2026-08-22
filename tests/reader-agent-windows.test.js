import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const agent = read('reader-cli/reader_agent.py');
assert.match(agent, /\/api\/reader\/claim/);
assert.match(agent, /\/api\/reader\/heartbeat/);
assert.match(agent, /\/api\/reader\/finish-job/);
assert.match(agent, /export_history\.py/);
assert.doesNotMatch(agent, /telegram-cloner-reader\.session/);

const ps = read('reader-cli/reader_agent_windows.ps1');
assert.match(ps, /ConvertFrom-SecureString/);
assert.match(ps, /\.reader-windows-secrets\.json/);
assert.match(ps, /reader_agent\.py/);

const installer = read('reader-cli/install_reader_agent_windows.ps1');
assert.match(installer, /schtasks\.exe/);
assert.match(installer, /\/SC ONLOGON/);
assert.match(installer, /\/RL LIMITED/);

console.log('Reader Agent Windows safety checks passed');
