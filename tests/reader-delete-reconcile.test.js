import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const reconcile = read('lib/reader-reconcile.js');
assert.match(reconcile, /MAX_RECONCILE_ROWS = 100_000/);
assert.match(reconcile, /upper_bound_message_id/);
assert.match(reconcile, /reconcile_source_identity_mismatch/);
assert.match(reconcile, /source_message_id=lte\.\$\{upperBound\}/);
assert.match(reconcile, /present = new Set/);
assert.match(reconcile, /staleRows/);
assert.match(reconcile, /source_id=eq\.\$\{encodeURIComponent\(source\.id\)\}&id=in/);
assert.match(reconcile, /last_reconciled_at: now/);
assert.match(reconcile, /syncSourceIndexedMessageCount/);
assert.match(reconcile, /event_type: 'reader_reconcile'/);
assert.doesNotMatch(reconcile, /source_message_id=gt\.\$\{upperBound\}/);

const local = read('reader-cli/reconcile_history.py');
assert.match(local, /action=reconcile-plan/);
assert.match(local, /action=reconcile/);
assert.match(local, /telegram_chat_id != expected_chat_id/);
assert.match(local, /message_id > upper_bound/);
assert.match(local, /present_message_ids/);
assert.match(local, /telegram-cloner-reader/);
assert.match(local, /--result-file/);
assert.match(local, /"deleted_count": deleted/);
assert.doesNotMatch(local, /session.*post_json/i);

const agent = read('reader-cli/reader_agent.py');
assert.match(agent, /BASE_READER_CAPABILITIES = \["reconcile_v1"\]/);
assert.match(agent, /capabilities = reader_capabilities\(\)/);
assert.match(agent, /"capabilities": capabilities/);
assert.match(agent, /reconcile_history\.py/);
assert.match(agent, /job_type == "reconcile"/);
assert.match(agent, /"--source-id"/);
assert.match(agent, /Claimed \{job_type\} job/);
assert.match(agent, /TemporaryDirectory\(prefix="tgcloner-reader-result-"\)/);
assert.match(agent, /command\.extend\(\["--result-file", str\(result_file\)\]\)/);
assert.match(agent, /completion\["deleted_count"\] = deleted_count/);

console.log('Reader deletion reconcile safety checks passed');
