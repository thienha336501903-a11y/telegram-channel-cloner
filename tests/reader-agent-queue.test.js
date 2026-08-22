import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const tables = read('lib/tables.js');
assert.match(tables, /readerJobs:\s*'tgcloner_reader_jobs'/);

const jobs = read('lib/reader-jobs.js');
assert.match(jobs, /status=in\.\(queued,processing\)/);
assert.match(jobs, /reader_agent_stale_requeued/);
assert.match(jobs, /claimed_by=eq\./);

const v4Source = read('server/admin/v4-source.js');
assert.match(v4Source, /queueReaderJob\(source\)/);
assert.match(v4Source, /reader_job_created/);
assert.match(v4Source, /active: Boolean\(existing\?\.active\)/);

const admin = read('api/admin.js');
assert.match(admin, /'reader-job': readerJobHandler/);

const claim = read('api/reader/claim.js');
const heartbeat = read('api/reader/heartbeat.js');
const finish = read('api/reader/finish-job.js');
for (const source of [claim, heartbeat, finish]) {
  assert.match(source, /READER_INGEST_SECRET/);
}

const migration = read('sql/005_reader_agent_queue.sql');
assert.match(migration, /create table if not exists public\.tgcloner_reader_jobs/);
assert.match(migration, /enable row level security/);
assert.match(migration, /where status in \('queued','processing'\)/);

console.log('Reader Agent queue checks passed');
