import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const finish = fs.readFileSync(new URL('../lib/v5-phase4-canary-finish.js', import.meta.url), 'utf8');
const complete = fs.readFileSync(new URL('../api/reader/complete.js', import.meta.url), 'utf8');

test('Phase 4 finish wrapper is restricted to the exact approved course/source/message rows', () => {
  assert.match(finish, /PHASE4_CANARY_COURSE_ID = 'a645f117-2320-452f-8538-154b80484218'/);
  assert.match(finish, /PHASE4_CANARY_SOURCE_ID = '039eedf1-6d26-4d04-a152-27e4d29fc5c0'/);
  assert.match(finish, /'be7c377e-05ef-4dd3-8ea3-9b54361dcd2e'/);
  assert.match(finish, /'df29f70c-fcc7-4985-8f58-03f432acb520'/);
  assert.match(finish, /PHASE4_CANARY_MESSAGE_ROWS\.has\(clean\(asset\.telegram_message_row_id\)\)/);
  assert.match(finish, /Date\.now\(\) < PHASE4_CANARY_EXPIRES_AT/);
  assert.match(finish, /READER_PHASE4_PRODUCTION_CANARY_DISABLED/);
});

test('all non-canary and failed jobs delegate to the unchanged production finish path', () => {
  assert.match(finish, /import \{ finishV5MirrorJob(?:, oneRpcRow)?(?:, safeProgress)? \} from '\.\/v5-mirror-jobs\.js'/);
  assert.match(finish, /if \(!context \|\| ok !== true\) \{\s*return finishV5MirrorJob/);
  assert.match(finish, /payload\.benchmark === true/);
});

test('exact production canary videos permit only bounded faststart size drift', () => {
  assert.match(finish, /Math\.max\(1024 \* 1024, Math\.ceil\(expectedBytes \* 0\.01\)\)/);
  assert.match(finish, /Math\.abs\(reportedBytes - expectedBytes\) > maxFaststartDrift/);
  assert.match(finish, /v5_mirror_phase4_size_drift_excessive/);
  assert.match(finish, /v5_mirror_object_key_mismatch/);
  assert.match(finish, /v5_mirror_bytes_required/);
});

test('successful canary finish still uses canonical production finish RPC', () => {
  assert.match(finish, /db\('rpc\/finish_v5_telegram_mirror_job'/);
  assert.match(finish, /p_ok: true/);
  assert.match(finish, /p_object_key: validated\.expectedObjectKey/);
  assert.match(finish, /p_bytes: validated\.reportedBytes/);
  assert.doesNotMatch(finish, /finishBenchmarkJob/);
});

test('successful canary finish restores heartbeat telemetry after canonical RPC overwrites result', () => {
  assert.match(finish, /heartbeatTelemetry/);
  assert.match(finish, /production_canary: true/);
  assert.match(finish, /source_expected_bytes: validated\.expectedBytes/);
  assert.match(finish, /faststart_drift_bytes/);
  assert.match(finish, /v5_jobs\?id=eq\.\$\{encodeURIComponent\(job\.id\)\}&job_type=eq\.telegram_mirror&status=eq\.success/);
  assert.match(finish, /method: 'PATCH'/);
  assert.match(finish, /Prefer: 'return=representation'/);
});

test('Reader finish endpoint keeps the Phase 4 wrapper while recovery serializes only the canary claim and heartbeat stays unchanged', () => {
  assert.match(complete, /import \{ claimV5MirrorJob, heartbeatV5MirrorJob(?:, safeProgress)? \} from '\.\.\/\.\.\/lib\/v5-mirror-jobs\.js'/);
  assert.match(complete, /import \{ finishPhase4CanaryMirrorJob \} from '\.\.\/\.\.\/lib\/v5-phase4-canary-finish\.js'/);
  assert.match(complete, /const job = await finishPhase4CanaryMirrorJob\(\{/);
  assert.match(complete, /const job = phase4RecoverySerialJob\(await claimV5MirrorJob\(agentId\)\);/);
  assert.match(complete, /if \(!job \|\| job\.production_canary !== true\) return job;/);
  assert.match(complete, /benchmark: false/);
  assert.match(complete, /const job = await heartbeatV5MirrorJob\(\{/);
});
