import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const jobs = fs.readFileSync(new URL('../lib/v5-mirror-jobs.js', import.meta.url), 'utf8');

const benchmarkStart = jobs.indexOf('async function finishBenchmarkJob');
const benchmarkEnd = jobs.indexOf('async function finishOwnedJob');
const benchmarkFinish = jobs.slice(benchmarkStart, benchmarkEnd);
const productionValidationStart = jobs.indexOf('function validateReportedMirror');
const benchmarkValidationStart = jobs.indexOf('function validateReportedBenchmark');
const productionValidation = jobs.slice(productionValidationStart, benchmarkValidationStart);
const benchmarkValidation = jobs.slice(benchmarkValidationStart, benchmarkStart);

test('R2 benchmark jobs are opt-in and restricted to the approved isolated prefix', () => {
  assert.match(jobs, /const BENCHMARK_PREFIX = 'benchmarks\/reader-phase1\/20260914\/message-13\/'/);
  assert.match(jobs, /payload\.benchmark === true/);
  assert.match(jobs, /payload\.benchmark_object_key/);
  assert.match(jobs, /key\.startsWith\(BENCHMARK_PREFIX\)/);
  assert.match(jobs, /key\.includes\('\.\.'\)/);
  assert.match(jobs, /v5_mirror_benchmark_object_key_denied/);
});

test('benchmark object key is returned to Reader while production object key remains unchanged', () => {
  assert.match(jobs, /const benchmarkObjectKey = benchmarkObjectKeyFor\(claimed\)/);
  assert.match(jobs, /const objectKey = benchmarkObjectKey \|\| objectKeyFor\(claimed/);
  assert.match(jobs, /benchmark: Boolean\(benchmarkObjectKey\)/);
  assert.match(jobs, /media\/v5\/\$\{job\.course_id\}\/\$\{asset\.id\}/);
});

test('benchmark completion updates only the benchmark job and never the production asset/post finish RPC', () => {
  assert.ok(benchmarkStart >= 0 && benchmarkEnd > benchmarkStart);
  assert.match(benchmarkFinish, /v5_jobs\?id=eq\./);
  assert.match(benchmarkFinish, /method: 'PATCH'/);
  assert.match(benchmarkFinish, /benchmark: true/);
  assert.doesNotMatch(benchmarkFinish, /v5_media_assets/);
  assert.doesNotMatch(benchmarkFinish, /v5_posts/);
  assert.doesNotMatch(benchmarkFinish, /finish_v5_telegram_mirror_job/);
  assert.match(jobs, /if \(benchmarkPayload\(job\)\) \{\s*return finishBenchmarkJob/);
  assert.match(jobs, /rpc\/finish_v5_telegram_mirror_job/);
});

test('benchmark video permits only bounded faststart size drift while production keeps exact video size validation', () => {
  assert.ok(productionValidationStart >= 0 && benchmarkValidationStart > productionValidationStart);
  assert.match(productionValidation, /reportedBytes !== expectedBytes/);
  assert.doesNotMatch(productionValidation, /maxFaststartDrift/);

  assert.match(benchmarkValidation, /Math\.max\(1024 \* 1024, Math\.ceil\(expectedBytes \* 0\.01\)\)/);
  assert.match(benchmarkValidation, /Math\.abs\(reportedBytes - expectedBytes\) > maxFaststartDrift/);
  assert.match(benchmarkValidation, /v5_mirror_benchmark_size_drift_excessive/);
  assert.match(benchmarkFinish, /source_expected_bytes: sourceExpectedBytes/);
});

test('benchmark heartbeat telemetry is forwarded from API and persisted into result.telemetry', () => {
  const complete = fs.readFileSync(new URL('../api/reader/complete.js', import.meta.url), 'utf8');
  assert.match(complete, /progressStage:\s*typeof body\.progress_stage === 'string'\s*\?\s*body\.progress_stage\s*:\s*null/);
  assert.match(complete, /bytesPerSecond:\s*safeProgress\(body\.bytes_per_second\)/);
  assert.match(complete, /etaSeconds:\s*safeProgress\(body\.eta_seconds\)/);
  assert.match(complete, /telemetry:\s*body\.telemetry/);

  assert.match(jobs, /if \(job && benchmarkPayload\(job\)\) \{/);
  assert.match(jobs, /prevResult\.telemetry/);
  assert.match(jobs, /samples\.push\(\{/);
  assert.match(jobs, /stages\[stage\]/);
  assert.match(jobs, /mb_per_second:\s*mbPerSec/);
});

test('production heartbeat behavior remains strictly unchanged (no telemetry written to result for production)', () => {
  assert.match(jobs, /export async function heartbeatV5MirrorJob/);
  // Telemetry in result is only written if benchmarkPayload is true
  assert.match(jobs, /if \(stage \|\| bps !== null \|\| eta !== null\) \{\s*const job = await selectOne\(/);
  assert.match(jobs, /if \(job && benchmarkPayload\(job\)\) \{\s*const nowIso = values\.updated_at;/);
  // Default values only patch locked_at, updated_at, progress_current, progress_total
  assert.match(jobs, /const values = \{\s*locked_at: new Date\(\)\.toISOString\(\),\s*updated_at: new Date\(\)\.toISOString\(\)\s*\};/);
});

test('benchmark finish merges and preserves existing heartbeat telemetry in result', () => {
  assert.match(benchmarkFinish, /const existingTelemetry = \(job\.result && typeof job\.result === 'object' && job\.result\.telemetry\)\s*\?\s*job\.result\.telemetry\s*:\s*null;/);
  assert.match(benchmarkFinish, /const finalTelemetry = \(telemetry && typeof telemetry === 'object'\)\s*\?\s*\{ \.\.\.\(existingTelemetry \|\| \{\}\), \.\.\.telemetry \}\s*:\s*existingTelemetry;/);
  assert.match(benchmarkFinish, /\.\.\.\(finalTelemetry \? \{ telemetry: finalTelemetry \} : \{\}\)/);
});

test('production concurrency strictly remains 1 and benchmark concurrency capped at 2', () => {
  const agentScript = fs.readFileSync(new URL('../reader-manager/reader_manager_agent.py', import.meta.url), 'utf8');
  assert.doesNotMatch(agentScript, /ThreadPoolExecutor|ProcessPoolExecutor|asyncio\.gather/);
  assert.match(agentScript, /def run_job\(config, job,/);
  assert.match(agentScript, /if has_prod:\s*\n\s*return False, None/);
  assert.match(agentScript, /if total >= 2 or benchmark_count >= 2:\s*\n\s*return False, None/);
});
