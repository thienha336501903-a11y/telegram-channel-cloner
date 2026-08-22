import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const agent = read('reader-cli/reader_agent.py');
assert.match(agent, /READER_CONTROL_PATH = "\/api\/reader\/complete"/);
assert.match(agent, /control_path\("claim"\)/);
assert.match(agent, /control_path\("heartbeat"\)/);
assert.match(agent, /control_path\("finish-job"\)/);
assert.match(agent, /post_json\(args\.cloner_url, control_path\("claim"\)/);
assert.doesNotMatch(agent, /post_json\(cloner_url=args\.cloner_url/);
assert.match(agent, /export_history\.py/);
assert.doesNotMatch(agent, /telegram-cloner-reader\.session/);

const authorize = read('reader-cli/authorize_session.py');
assert.match(authorize, /TelegramClient/);
assert.match(authorize, /telegram-cloner-reader/);
assert.match(authorize, /The session file remains on this PC/);
assert.doesNotMatch(authorize, /READER_INGEST_SECRET/);

const ps = read('reader-cli/reader_agent_windows.ps1');
assert.match(ps, /ConvertFrom-SecureString/);
assert.match(ps, /\.reader-windows-secrets\.json/);
assert.match(ps, /reader_agent\.py/);
assert.match(ps, /authorize_session\.py/);
assert.match(ps, /\$SetupOnly/);

const installer = read('reader-cli/install_reader_agent_windows.ps1');
assert.match(installer, /-SetupOnly -NoUpdate/);
assert.match(installer, /phone \/ OTP \/ 2FA/);
assert.match(installer, /schtasks\.exe/);
assert.match(installer, /\/SC ONLOGON/);
assert.match(installer, /\/RL LIMITED/);
assert.match(installer, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
assert.match(installer, /Set-ItemProperty -Path \$runKeyPath -Name \$TaskName -Value \$taskCommand/);
assert.match(installer, /Administrator rights are not required/);
assert.match(installer, /Start-Process -FilePath "powershell\.exe"/);
assert.doesNotMatch(installer, /RunOnce/);

console.log('Reader Agent Windows safety checks passed');
