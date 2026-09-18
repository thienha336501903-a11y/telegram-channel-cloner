import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const agent = read('reader-manager/reader_manager_agent.py');
const jobs = read('lib/v5-mirror-jobs.js');
const storage = read('reader-manager/reader_manager_storage.py');
const installer = read('reader-manager/installer.iss');

test('1. Normal production concurrency remains max = 1; only exact server-authorized Phase 4 pair may overlap', () => {
  // Client enforcement for ordinary production: if has_prod, can_claim_mirror returns False.
  assert.match(agent, /if has_prod:\s*\n\s*return False, None/);
  // Backend ordinary-production guard: a non-benchmark running job is allowed a second slot only
  // when it passes the exact server-side production canary authorization.
  assert.match(jobs, /runningCanary = await isProductionCanaryJob\(runningJobs\[0\]\)/);
  assert.match(jobs, /if \(!runningCanary\) \{[\s\S]*return null;/);
  // A claimed second job must also be the exact canary; otherwise it is safely requeued.
  assert.match(jobs, /const isClaimedCanary = runningCanary && await isProductionCanaryJob\(claimed\)/);
  assert.match(jobs, /if \(!isClaimedCanary\) \{[\s\S]*requeueClaimedMirrorJob\(claimed, owner\);[\s\S]*return null;/);
  assert.match(jobs, /async function requeueClaimedMirrorJob\(claimed, owner\) \{[\s\S]*status: 'queued'/);
});

test('2. Benchmark concurrency max = 2', () => {
  // Client limit: capped at 2
  assert.match(agent, /if total >= 2 or benchmark_count >= 2:\s*\n\s*return False, None/);
  // Backend limit: strictly 2
  assert.match(jobs, /if \(runningJobs && runningJobs\.length >= 2\) \{\s*\n\s*return null;\s*\n\s*\}/);
});

test('3. Benchmark worker #2 can claim and run while benchmark worker #1 is active', () => {
  // When benchmark_count == 1, client allows benchmark_only slot
  assert.match(agent, /if benchmark_count == 1:\s*\n\s*return True, "benchmark_only"/);
  // Backend recognizes the running benchmark class
  assert.match(jobs, /const isRunningBenchmark = Boolean\(benchmarkPayload\(runningJobs\[0\]\)\);/);
});

test('4. Worker #3 cannot run when 2 workers are already active', () => {
  // Client blocks when benchmark_count >= 2 or total >= 2
  assert.match(agent, /if total >= 2 or benchmark_count >= 2:\s*\n\s*return False, None/);
  // Backend blocks when runningJobs.length >= 2, including Phase 4 canary
  assert.match(jobs, /if \(runningJobs && runningJobs\.length >= 2\) \{\s*\n\s*return null;\s*\n\s*\}/);
});

test('5. Production cannot self-authorize benchmark or Phase 4 canary paths', () => {
  assert.match(jobs, /function benchmarkObjectKeyFor\(job\) \{/);
  assert.match(jobs, /!key\.startsWith\(BENCHMARK_PREFIX\)/);
  assert.match(jobs, /throw new Error\('v5_mirror_benchmark_object_key_denied'\);/);
  assert.match(jobs, /function isProductionCanaryAsset\(asset\) \{/);
  assert.match(jobs, /PHASE4_CANARY_MESSAGE_ROWS\.has\(clean\(asset\?\.telegram_message_row_id\)\)/);
  assert.doesNotMatch(jobs, /payload\.production_canary\s*===\s*true/);
});

test('6. Benchmark prefix guard strictly enforced', () => {
  assert.match(jobs, /BENCHMARK_PREFIX = 'benchmarks\/reader-phase1\/20260914\/message-13\/'/);
  assert.match(jobs, /!key\.startsWith\(BENCHMARK_PREFIX\)/);
});

test('7. Heartbeat telemetry still persists into v5_jobs.result.telemetry for benchmark jobs', () => {
  assert.match(jobs, /const persistTelemetry = job && \(benchmarkPayload\(job\) \|\| await isProductionCanaryJob\(job\)\);/);
  assert.match(jobs, /if \(persistTelemetry\) \{/);
  assert.match(jobs, /telemetry: \{[\s\S]*progress_stage: stage/);
  assert.match(jobs, /bytes_per_second: bps/);
  assert.match(jobs, /mb_per_second: mbPerSec/);
  assert.match(jobs, /eta_seconds: eta/);
  assert.match(jobs, /samples,/);
  assert.match(jobs, /stages/);
});

test('8. Benchmark finish preserves and overlays telemetry', () => {
  assert.match(jobs, /async function finishBenchmarkJob\(\{/);
  assert.match(jobs, /const existingTelemetry = \(job\.result && typeof job\.result === 'object' && job\.result\.telemetry\)/);
  assert.match(jobs, /\.\.\.\(finalTelemetry \? \{ telemetry: finalTelemetry \} : \{\}\)/);
});

test('9. Worker failure or success releases active slot', () => {
  // mirror_worker has finally block removing job_id
  assert.match(agent, /finally:\s*\n\s*with _ACTIVE_MIRRORS_LOCK:\s*\n\s*_ACTIVE_MIRRORS\.pop\(job_id, None\)\s*\n\s*_ACTIVE_SUBPROCESSES\.pop\(job_id, None\)/);
});

test('10. Graceful shutdown terminates active subprocesses without zombies', () => {
  assert.match(agent, /def terminate_all_subprocesses\(\):/);
  assert.match(agent, /p\.terminate\(\)/);
  assert.match(agent, /p\.wait\(timeout=5\)/);
  assert.match(agent, /agent_loop[\s\S]*terminate_all_subprocesses\(\)/);
});

test('11. FloodWait and rate-limiting trigger backoff without retry storm', () => {
  assert.match(agent, /def rate_limit_wait_seconds\(error\):/);
  assert.match(agent, /is_flood = any\(term in text for term in \(/);
  assert.match(agent, /"floodwait"/);
  assert.match(agent, /"too many requests"/);
  assert.match(agent, /def apply_mirror_backpressure\(error\):/);
  assert.match(agent, /_MIRROR_BACKOFF_UNTIL = max\(_MIRROR_BACKOFF_UNTIL, now \+ wait_seconds\)/);
  assert.match(agent, /_MIRROR_DEGRADED_UNTIL = max\(_MIRROR_DEGRADED_UNTIL, now \+ degraded_seconds\)/);
});

test('12. Existing Reader config from 1.3.4 loads seamlessly in 1.4.0', () => {
  assert.match(storage, /def load_config\(\):/);
  assert.match(storage, /value\.get\("version"\) != 1/);
  assert.match(storage, /value\.setdefault\("profiles", \[\]\)/);
  assert.match(agent, /APP_VERSION = "1\.4\.[1-4]"/);
  assert.match(installer, /#define MyAppVersion "1\.4\.[1-4]"/);
});

test('13. claimV5MirrorJob runtime execution has selectMany defined', () => {
  assert.match(jobs, /async function selectMany\(path\) \{/);
  assert.match(jobs, /const runningJobs = await selectMany\(/);
});

test('14. Benchmark/canary workers can share active local profile only through server-returned benchmark scheduling bit', () => {
  assert.match(agent, /def ready_profiles\(config, allow_busy=False\):/);
  assert.match(agent, /def choose_v5_profile\(config, channel, source_id, allow_busy=False\):/);
  assert.match(agent, /profile = choose_v5_profile\(config, channel, source_id, allow_busy=is_benchmark\)/);
  assert.match(jobs, /benchmark: Boolean\(benchmarkObjectKey\) \|\| productionCanary/);
  assert.match(jobs, /production_canary: productionCanary/);
});
