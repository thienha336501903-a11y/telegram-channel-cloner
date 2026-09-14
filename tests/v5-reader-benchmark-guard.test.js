import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const jobs = fs.readFileSync(new URL('../lib/v5-mirror-jobs.js', import.meta.url), 'utf8');

const benchmarkStart = jobs.indexOf('async function finishBenchmarkJob');
const benchmarkEnd = jobs.indexOf('async function finishOwnedJob');
const benchmarkFinish = jobs.slice(benchmarkStart, benchmarkEnd);

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
