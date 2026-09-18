import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const agent = read('reader-manager/reader_manager_agent.py');
const installer = read('reader-manager/installer.iss');
const gui = read('reader-manager/reader_manager_gui.py');

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  try {
    const cmd = process.platform === 'win32' ? 'where.exe python' : 'which python || which python3';
    return execSync(cmd, { shell: true, encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {
    return 'python';
  }
}

const pythonBin = resolvePython();
const managerDir = path.join(repoRoot, 'reader-manager').replace(/\\/g, '/');

test('Reader 1.4.5 exposes explicit one-shot V5 mode without changing the default', () => {
  assert.match(agent, /APP_VERSION = "1\.4\.5"/);
  assert.match(installer, /#define MyAppVersion "1\.4\.5"/);
  assert.match(agent, /YEUNAUAN_READER_V5_ONE_SHOT/);
  assert.match(agent, /ONE_SHOT_V5_CANARY_ENABLED/);
  assert.match(agent, /ONE_SHOT_V5_JOB_CLAIMED:/);
  assert.match(agent, /ONE_SHOT_V5_COMPLETE/);
  assert.match(agent, /ONE_SHOT_V5_STOPPED/);
});

test('required_job_attempt is fail-closed and never invents attempt=1', () => {
  const py = `
import sys
sys.path.insert(0, r'${managerDir}')
import reader_manager_agent as a

assert a.required_job_attempt({"attempt": 1}) == 1
assert a.required_job_attempt({"attempt": "2"}) == 2
assert a.required_job_attempt({"attempt": 3.0}) == 3

for bad in ({}, {"attempt": None}, {"attempt": 0}, {"attempt": False}, {"attempt": ""}, {"attempt": "0"}, {"attempt": "1.5"}, {"attempt": 1.5}):
    try:
        a.required_job_attempt(bad)
        raise AssertionError(f"accepted invalid attempt: {bad!r}")
    except RuntimeError as exc:
        assert str(exc) == "v5_mirror_attempt_required"

print("REQUIRED_ATTEMPT_FAIL_CLOSED_PASS")
`;
  const res = spawnSync(pythonBin, ['-c', py], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /REQUIRED_ATTEMPT_FAIL_CLOSED_PASS/);
});

test('one-shot V5 mode claims exactly one V5 job, skips generic work, then stops after lifecycle', () => {
  const py = `
import os, sys
sys.path.insert(0, r'${managerDir}')
import reader_manager_agent as a

os.environ["YEUNAUAN_READER_V5_ONE_SHOT"] = "1"

class FakeEvent:
    def __init__(self):
        self.flag = False
    def is_set(self):
        return self.flag
    def set(self):
        self.flag = True
    def wait(self, _seconds):
        return self.flag

stop = FakeEvent()
calls = {"claim_v5": 0, "generic": 0, "start": 0, "stats": 0, "terminate": 0}

a.load_config = lambda: {"agent_token": "tok"}
a.sync_remote_profiles = lambda c: c
a.list_pending_finishes = lambda: []
a.recover_busy_profiles_for_one_shot = lambda c: c
a.mirror_backoff_remaining = lambda: 0
a.can_claim_mirror = lambda: (True, "any")
a.has_v5_r2_config = lambda c: True

def no_generic(_config):
    calls["generic"] += 1
    raise AssertionError("generic claim must not run in one-shot V5 mode")
a.claim_generic_job = no_generic

def claim_v5(_config):
    calls["claim_v5"] += 1
    if calls["claim_v5"] > 1:
        raise AssertionError("second V5 claim attempted")
    return {
        "id": "job-one-shot",
        "job_type": "v5_mirror",
        "attempt": 4,
        "benchmark": False
    }
a.claim_v5_job = claim_v5

def start_job(_config, job, _stop_event, _status_callback=None):
    assert job["id"] == "job-one-shot"
    calls["start"] += 1
a.start_mirror_job = start_job

def stats():
    calls["stats"] += 1
    if calls["stats"] == 1:
        return (0, False, 0)
    if calls["stats"] == 2:
        return (1, True, 0)
    return (0, False, 0)
a.active_mirror_stats = stats

a.terminate_all_subprocesses = lambda: calls.__setitem__("terminate", calls["terminate"] + 1)

a.agent_loop(stop)

assert stop.is_set()
assert calls["claim_v5"] == 1, calls
assert calls["generic"] == 0, calls
assert calls["start"] == 1, calls
assert calls["terminate"] == 1, calls
print("ONE_SHOT_EXACTLY_ONE_CLAIM_PASS")
`;
  const res = spawnSync(pythonBin, ['-c', py], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /ONE_SHOT_EXACTLY_ONE_CLAIM_PASS/);
  assert.match(res.stdout, /ONE_SHOT_V5_CANARY_ENABLED/);
  assert.match(res.stdout, /ONE_SHOT_V5_JOB_CLAIMED:job-one-shot/);
  assert.match(res.stdout, /ONE_SHOT_V5_COMPLETE/);
  assert.match(res.stdout, /ONE_SHOT_V5_STOPPED/);
});

test('one-shot boundary remains locked if the first claimed job fails to start', () => {
  const py = `
import os, sys
sys.path.insert(0, r'${managerDir}')
import reader_manager_agent as a

os.environ["YEUNAUAN_READER_V5_ONE_SHOT"] = "true"

class FakeEvent:
    def __init__(self):
        self.flag = False
    def is_set(self):
        return self.flag
    def set(self):
        self.flag = True
    def wait(self, _seconds):
        return self.flag

stop = FakeEvent()
calls = {"claim_v5": 0}

a.load_config = lambda: {"agent_token": "tok"}
a.sync_remote_profiles = lambda c: c
a.list_pending_finishes = lambda: []
a.recover_busy_profiles_for_one_shot = lambda c: c
a.mirror_backoff_remaining = lambda: 0
a.active_mirror_stats = lambda: (0, False, 0)
a.can_claim_mirror = lambda: (True, "any")
a.claim_generic_job = lambda _c: (_ for _ in ()).throw(AssertionError("generic claim must not run"))

def claim_v5(_config):
    calls["claim_v5"] += 1
    if calls["claim_v5"] > 1:
        raise AssertionError("second claim attempted after first-job failure")
    return {"id": "job-start-fail", "job_type": "v5_mirror", "attempt": 2, "benchmark": False}
a.claim_v5_job = claim_v5

def fail_start(*_args, **_kwargs):
    raise RuntimeError("synthetic_start_failure")
a.start_mirror_job = fail_start
a.terminate_all_subprocesses = lambda: None

a.agent_loop(stop)

assert stop.is_set()
assert calls["claim_v5"] == 1
print("ONE_SHOT_FAILURE_STILL_ONE_CLAIM_PASS")
`;
  const res = spawnSync(pythonBin, ['-c', py], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /ONE_SHOT_FAILURE_STILL_ONE_CLAIM_PASS/);
});

test('normal mode still preserves generic-job priority when one-shot env is absent', () => {
  const py = `
import os, sys
sys.path.insert(0, r'${managerDir}')
import reader_manager_agent as a

os.environ.pop("YEUNAUAN_READER_V5_ONE_SHOT", None)

class FakeEvent:
    def __init__(self):
        self.flag = False
    def is_set(self):
        return self.flag
    def set(self):
        self.flag = True
    def wait(self, _seconds):
        return self.flag

stop = FakeEvent()
calls = {"generic": 0, "v5": 0, "run": 0}

a.load_config = lambda: {"agent_token": "tok"}
a.sync_remote_profiles = lambda c: c
a.flush_pending_finishes = lambda c: 0
a.active_mirror_stats = lambda: (0, False, 0)
a.mirror_backoff_remaining = lambda: 0

def generic(_config):
    calls["generic"] += 1
    return {"id": "generic-1", "job_type": "import"}
a.claim_generic_job = generic

def run(_config, job, _stop_event, _status_callback=None):
    calls["run"] += 1
    assert job["id"] == "generic-1"
    stop.set()
a.run_job = run
a.record_last_success = lambda: None

def v5(_config):
    calls["v5"] += 1
    return None
a.claim_v5_job = v5
a.terminate_all_subprocesses = lambda: None

a.agent_loop(stop)

assert calls["generic"] == 1, calls
assert calls["run"] == 1, calls
assert calls["v5"] == 0, calls
print("NORMAL_MODE_GENERIC_PRIORITY_PASS")
`;
  const res = spawnSync(pythonBin, ['-c', py], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /NORMAL_MODE_GENERIC_PRIORITY_PASS/);
});


test('one-shot recovery changes only stale local busy profiles through authenticated profile-status API', () => {
  const py = `
import os, sys
sys.path.insert(0, r'${managerDir}')
import reader_manager_agent as a

os.environ["YEUNAUAN_READER_V5_ONE_SHOT"] = "1"
calls = []
saved = []

a.active_mirror_stats = lambda: (0, False, 0)
a.api = lambda config, action, payload=None, timeout=45: calls.append((action, payload, timeout)) or {"ok": True}
a.save_config = lambda config: saved.append(config.copy())

config = {
    "agent_token": "tok",
    "profiles": [
        {"id": "p-busy", "status": "busy", "session": "s"},
        {"id": "p-ready", "status": "ready", "session": "s2"}
    ]
}

out = a.recover_busy_profiles_for_one_shot(config)
assert out["profiles"][0]["status"] == "ready"
assert out["profiles"][1]["status"] == "ready"
assert calls == [("profile-status", {"profile_id": "p-busy", "status": "ready"}, 20)]
assert len(saved) == 1
print("ONE_SHOT_BUSY_PROFILE_RECOVERY_PASS")
`;
  const res = spawnSync(pythonBin, ['-c', py], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /ONE_SHOT_BUSY_PROFILE_RECOVERY_PASS/);
});

test('busy profile recovery is disabled outside explicit one-shot mode', () => {
  const py = `
import os, sys
sys.path.insert(0, r'${managerDir}')
import reader_manager_agent as a

os.environ.pop("YEUNAUAN_READER_V5_ONE_SHOT", None)
a.api = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("API must not be called"))
config = {"profiles": [{"id": "p-busy", "status": "busy", "session": "s"}]}
out = a.recover_busy_profiles_for_one_shot(config)
assert out["profiles"][0]["status"] == "busy"
print("NORMAL_MODE_NO_BUSY_RECOVERY_PASS")
`;
  const res = spawnSync(pythonBin, ['-c', py], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /NORMAL_MODE_NO_BUSY_RECOVERY_PASS/);
});

test('GUI shutdown waits for agent cleanup instead of exiting immediately', () => {
  assert.match(gui, /self\.agent_thread = None/);
  assert.match(gui, /self\.stop_event, self\.agent_thread = start_background/);
  assert.match(gui, /self\.stop_event\.set\(\)/);
  assert.match(gui, /self\.agent_thread\.join\(timeout=12\)/);
  assert.match(agent, /def wait_for_active_mirrors\(timeout=10\):/);
  assert.match(agent, /terminate_all_subprocesses\(\)\s*\n\s*wait_for_active_mirrors\(timeout=10\)/);
});
