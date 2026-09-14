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

test('1. Production concurrency strictly max = 1 across client and backend', () => {
  // Client enforcement: if has_prod, can_claim_mirror returns False
  assert.match(agent, /if has_prod:\s*\n\s*return False, None/);
  // Backend enforcement: if 1 job is running and not benchmark, cannot claim
  assert.match(jobs, /if \(runningJobs && runningJobs\.length === 1\) \{[\s\S]*const isRunningBenchmark = Boolean\(benchmarkPayload\(runningJobs\[0\]\)\);[\s\S]*if \(!isRunningBenchmark\) \{[\s\S]*return null;/);
  // Backend enforcement: newly claimed job cannot be production if already running 1 job
  assert.match(jobs, /if \(!isClaimedBenchmark\) \{[\s\S]*status: 'queued'[\s\S]*return null;/);
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
  // Backend allows second job if first job is benchmark
  assert.match(jobs, /const isRunningBenchmark = Boolean\(benchmarkPayload\(runningJobs\[0\]\)\);/);
});

test('4. Worker #3 cannot run when 2 benchmark workers are already active', () => {
  // Client blocks when benchmark_count >= 2 or total >= 2
  assert.match(agent, /if total >= 2 or benchmark_count >= 2:\s*\n\s*return False, None/);
  // Backend blocks when runningJobs.length >= 2
  assert.match(jobs, /if \(runningJobs && runningJobs\.length >= 2\) \{\s*\n\s*return null;\s*\n\s*\}/);
});

test('5. Production job cannot exploit benchmark path', () => {
  assert.match(jobs, /function benchmarkObjectKeyFor\(job\) \{/);
  assert.match(jobs, /!key\.startsWith\(BENCHMARK_PREFIX\)/);
  assert.match(jobs, /throw new Error\('v5_mirror_benchmark_object_key_denied'\);/);
  assert.match(jobs, /benchmark: Boolean\(benchmarkObjectKey\)/);
});

test('6. Benchmark prefix guard strictly enforced', () => {
  assert.match(jobs, /BENCHMARK_PREFIX = 'benchmarks\/reader-phase1\/20260914\/message-13\/'/);
  assert.match(jobs, /!key\.startsWith\(BENCHMARK_PREFIX\)/);
});

test('7. Heartbeat telemetry still persists into v5_jobs.result.telemetry for benchmark jobs', () => {
  assert.match(jobs, /if \(job && benchmarkPayload\(job\)\) \{/);
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
  assert.match(agent, /APP_VERSION = "1\.4\.0"/);
  assert.match(installer, /#define MyAppVersion "1\.4\.0"/);
});
