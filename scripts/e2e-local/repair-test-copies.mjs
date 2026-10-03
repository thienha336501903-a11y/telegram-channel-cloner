// One-time repair for the confirmed 2026-10-02 disposable TEST channel run.
// The source is never contacted by a mutating Bot API method.
import { execFileSync } from 'node:child_process';
import { verifyTestBot } from './test-bot-identity.mjs';
import { assertConfirmedRepairSnapshot, confirmedDeleteIds } from './repair-test-copies-core.mjs';

const SOURCE_CHAT_ID = '-1003535777660';
const DESTINATION_CHAT_ID = '-1004492904064';
const KNOWN_EARLIER_COPY = { source: 56, destination: 9 }; // Manually verified as t.me/c/4492904064/9.
const idsToDelete = confirmedDeleteIds;
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();

if (process.env.E2E_SOURCE_CHAT_ID !== SOURCE_CHAT_ID || process.env.E2E_DESTINATION_CHAT_IDS !== DESTINATION_CHAT_ID || process.env.E2E_EXISTING_COURSE_PREFIX !== 'true') {
  throw new Error('Repair is restricted to the confirmed TEST source and destination in course-prefix mode');
}

const sql = `select m.source_message_id, m.destination_message_id, m.status from public.tgcloner_message_mappings m join public.tgcloner_destinations d on d.id=m.destination_id where d.chat_id='${DESTINATION_CHAT_ID}' order by m.destination_message_id`;
const output = execFileSync('docker', ['exec', 'tgcloner-e2e-db', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-F', ',', '-c', sql], { encoding: 'utf8', timeout: 10_000 });
const actualRows = output.trim().split(/\r?\n/).filter(Boolean);
const unsafeWorkSql = `select count(*) from public.tgcloner_clone_work w join public.tgcloner_clone_runs r on r.id=w.run_id join public.tgcloner_destinations d on d.id=r.destination_id where d.chat_id='${DESTINATION_CHAT_ID}' and ((w.phase='copy' and w.status not in ('done','skipped','cancelled')) or w.status='blocked_ambiguous' or w.side_effect_state='ambiguous')`;
const unsafeWorkCount = execFileSync('docker', ['exec', 'tgcloner-e2e-db', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', unsafeWorkSql], { encoding: 'utf8', timeout: 10_000 }).trim();
assertConfirmedRepairSnapshot(actualRows, unsafeWorkCount);

await verifyTestBot({ token, expectedUsername: 'yeubep_distributor_test_bot' });

async function telegram(method, params) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true) throw new Error(`${method}: ${body?.description || 'unknown API failure'}`);
  return body.result;
}

const chat = await telegram('getChat', { chat_id: DESTINATION_CHAT_ID });
if (String(chat?.id) !== DESTINATION_CHAT_ID || chat?.type !== 'channel') {
  throw new Error('Destination TEST channel identity mismatch; no Telegram message was deleted');
}
console.log(`E2E_REPAIR_CONFIRMED source=${SOURCE_CHAT_ID} destination=${DESTINATION_CHAT_ID} old_source_56_destination_9=true db_mappings=4`);

const deleted = [];
for (const messageId of idsToDelete) {
  try {
    const result = await telegram('deleteMessage', { chat_id: DESTINATION_CHAT_ID, message_id: messageId });
    if (result !== true) throw new Error('unexpected deleteMessage result');
  } catch (error) {
    throw new Error(`E2E_REPAIR_STOP confirmed_deleted=${deleted.join(',') || 'none'} uncertain_or_failed_id=${messageId}: ${error.message}. Do not retry or start a new copy before reconciliation.`);
  }
  deleted.push(messageId);
  console.log(`E2E_REPAIR_DELETED destination_message_id=${messageId}`);
}
console.log(`E2E_REPAIR_PASS removed_exact_test_copies=${idsToDelete.length}`);
