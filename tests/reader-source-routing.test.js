import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const routing = read('lib/reader-source-routing.js');
const jobs = read('lib/reader-jobs.js');
const migration = read('sql/007_reader_manager_profiles.sql');

test('source access matrix supports unknown, verified and denied with one row per profile/source', () => {
  assert.match(migration, /status in \('unknown','verified','denied'\)/);
  assert.match(migration, /unique \(source_id, reader_profile_id\)/);
});

test('automatic reconcile routing prefers verified profiles and excludes denied profiles', () => {
  assert.match(routing, /accessByProfile\.get\(profile\.id\) === 'verified'/);
  assert.match(routing, /accessByProfile\.get\(profile\.id\) !== 'denied'/);
  assert.match(routing, /return profiles\.find[\s\S]*\|\| null/);
});

test('explicit profile selection remains available as a deliberate access re-check', () => {
  assert.match(routing, /requested && requested !== 'auto'/);
  assert.match(routing, /return chooseReaderProfile\(requested\)/);
});

test('managed claim re-routes unassigned reconcile jobs by source instead of profileIds[0]', () => {
  assert.match(jobs, /candidate\.job_type === 'reconcile'/);
  assert.match(jobs, /chooseReaderProfileForSource\(candidate\.source_id, \{ allowedProfileIds: profileIds \}\)/);
  assert.match(jobs, /if \(!routed\?\.id\) continue/);
  assert.doesNotMatch(jobs, /candidate\.assigned_reader_profile_id \|\| profileIds\[0\] \|\| null/);
});

test('normal import auto-selection keeps existing generic Reader Manager behavior', () => {
  assert.match(jobs, /if \(type === 'reconcile'\) return chooseReaderProfileForSource\(source\.id\)/);
  assert.match(jobs, /return chooseReaderProfile\('auto'\)/);
});
