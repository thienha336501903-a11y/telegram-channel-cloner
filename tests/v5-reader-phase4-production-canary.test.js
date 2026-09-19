import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const jobs = read('lib/v5-mirror-jobs.js');
const agent = read('reader-manager/reader_manager_agent.py');

test('phase4 canary is server-authorized by exact course/source/message rows and self-expires', () => {
  assert.match(jobs, /PHASE4_CANARY_COURSE_ID = 'a645f117-2320-452f-8538-154b80484218'/);
  assert.match(jobs, /PHASE4_CANARY_SOURCE_ID = '039eedf1-6d26-4d04-a152-27e4d29fc5c0'/);
  assert.match(jobs, /'be7c377e-05ef-4dd3-8ea3-9b54361dcd2e'/);
  assert.match(jobs, /'df29f70c-fcc7-4985-8f58-03f432acb520'/);
  assert.match(jobs, /PHASE4_CANARY_EXPIRES_AT = Date\.parse\('2026-09-23T00:00:00Z'\)/);
  assert.match(jobs, /READER_PHASE4_PRODUCTION_CANARY_DISABLED/);
});

test('client payload cannot self-authorize production canary', () => {
  assert.match(jobs, /function isProductionCanaryAsset\(asset\)/);
  assert.match(jobs, /asset\?\.telegram_source_id/);
  assert.match(jobs, /asset\?\.telegram_message_row_id/);
  assert.doesNotMatch(jobs, /payload\.production_canary\s*===\s*true/);
});

test('normal production remains max one while exact canary pair may take second slot', () => {
  assert.match(jobs, /runningCanary = await isProductionCanaryJob\(runningJobs\[0\]\)/);
  assert.match(jobs, /if \(!runningCanary\) \{[\s\S]*return null;/);
  assert.match(jobs, /const isClaimedCanary = runningCanary && await isProductionCanaryJob\(claimed\)/);
  assert.match(jobs, /if \(!isClaimedCanary\) \{[\s\S]*requeueClaimedMirrorJob\(claimed, owner\)/);
  assert.match(jobs, /runningJobs && runningJobs\.length >= 2/);
});

test('benchmark and production-canary concurrency classes cannot mix', () => {
  assert.match(jobs, /else if \(!isRunningBenchmark \|\| runningCanary\) \{/);
  assert.match(jobs, /requeueClaimedMirrorJob\(claimed, owner\)/);
});

test('Reader 1.4.0 proven benchmark worker path is reused only as local scheduling shim', () => {
  assert.match(jobs, /benchmark: Boolean\(benchmarkObjectKey\) \|\| productionCanary/);
  assert.match(jobs, /production_canary: productionCanary/);
  assert.match(agent, /APP_VERSION = "1\.4\.(?:[1-9]|\d{2,})"/);
  assert.match(agent, /profile = choose_v5_profile\(config, channel, source_id, allow_busy=True\)/);
});

test('production canary keeps canonical production object key and normal finish RPC', () => {
  assert.match(jobs, /const objectKey = benchmarkObjectKey \|\| objectKeyFor\(claimed/);
  assert.match(jobs, /if \(benchmarkPayload\(job\)\) \{[\s\S]*finishBenchmarkJob/);
  assert.match(jobs, /rpc\/finish_v5_telegram_mirror_job/);
});

test('production canary heartbeat telemetry is persisted for audit', () => {
  assert.match(jobs, /const persistTelemetry = job && \(benchmarkPayload\(job\) \|\| await isProductionCanaryJob\(job\)\)/);
  assert.match(jobs, /production_canary: true/);
  assert.match(jobs, /bytes_per_second: bps/);
  assert.match(jobs, /mb_per_second: mbPerSec/);
  assert.match(jobs, /eta_seconds: eta/);
});
