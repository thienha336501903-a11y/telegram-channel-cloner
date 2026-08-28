import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const reconcile = read('lib/reader-reconcile.js');
assert.match(reconcile, /MAX_RECONCILE_ROWS = 100_000/);
assert.match(reconcile, /upper_bound_message_id/);
assert.match(reconcile, /reconcile_source_identity_mismatch/);
assert.match(reconcile, /present = new Set/);
assert.match(reconcile, /rpc\/tgcloner_apply_reconcile_snapshot/);
assert.match(reconcile, /p_present_message_ids: \[\.\.\.present\]/);
assert.match(reconcile, /event_type: 'reader_reconcile'/);
assert.match(reconcile, /telemetry failed after atomic apply/);
assert.doesNotMatch(reconcile, /DELETE_CHUNK_SIZE/);
assert.doesNotMatch(reconcile, /staleRows/);
assert.doesNotMatch(reconcile, /id=in\.\(/);
assert.doesNotMatch(reconcile, /syncSourceIndexedMessageCount/);

const atomic = read('sql/009_reader_reconcile_atomic_apply.sql');
assert.match(atomic, /tgcloner_apply_reconcile_snapshot/);
assert.match(atomic, /set search_path = pg_catalog, public/);
assert.match(atomic, /set_config\('statement_timeout', '20000', true\)/);
assert.match(atomic, /for update/);
assert.match(atomic, /m\.source_message_id <= p_upper_bound_message_id/);
assert.match(atomic, /not \(m\.source_message_id = any\(v_present\)\)/);
assert.match(atomic, /get diagnostics v_deleted = row_count/);
assert.match(atomic, /indexed_message_count = v_indexed_count::integer/);
assert.match(atomic, /grant execute on function public\.tgcloner_apply_reconcile_snapshot[\s\S]*to service_role/);
assert.doesNotMatch(atomic, /commit|begin transaction/i);

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
