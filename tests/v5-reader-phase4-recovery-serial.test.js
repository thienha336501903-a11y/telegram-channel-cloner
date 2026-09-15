import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const complete = fs.readFileSync(path.join(repoRoot, 'api/reader/complete.js'), 'utf8');

test('Phase 4A production canary recovery is forced to Reader serial scheduling', () => {
  assert.match(complete, /function phase4RecoverySerialJob\(job\)/);
  assert.match(complete, /job\.production_canary !== true/);
  assert.match(complete, /benchmark: false/);
  assert.match(complete, /phase4_recovery_serial: true/);
  assert.match(complete, /phase4RecoverySerialJob\(await claimV5MirrorJob\(agentId\)\)/);
});

test('recovery rewrite is limited to server-authorized production canary jobs', () => {
  assert.match(complete, /if \(!job \|\| job\.production_canary !== true\) return job;/);
  assert.doesNotMatch(complete, /body\.production_canary/);
  assert.doesNotMatch(complete, /payload\.production_canary/);
});

test('canonical Phase 4 canary finish path remains unchanged during serial recovery', () => {
  assert.match(complete, /finishPhase4CanaryMirrorJob/);
  assert.match(complete, /action === 'v5-mirror-finish'/);
  assert.match(complete, /const job = await finishPhase4CanaryMirrorJob\(\{/);
});
