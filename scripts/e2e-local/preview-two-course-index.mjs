// Read-only preview for the retained learner-free 1→2 TEST run. It does not
// call Telegram Bot API, change the Docker database, or publish a message.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildCourseIndex } from './course-index-core.mjs';

const SOURCE = '-1004320185488';
const DESTINATIONS = ['-1003933578709', '-1004492904064'];
const DB_CONTAINER = 'tgcloner-e2e-1to2-db';

const sql = `
with s as (select id,chat_id,title,active from public.tgcloner_sources where chat_id='${SOURCE}'),
d as (select id,source_id,chat_id,username,active from public.tgcloner_destinations
      where chat_id in ('${DESTINATIONS.join("','")}'))
select json_build_object(
  'source',(select row_to_json(s) from s),
  'messages',(select json_agg(json_build_object('source_message_id',m.source_message_id,
    'media_group_id',m.media_group_id,'message_type',m.message_type,
    'text',m.text,'caption',m.caption) order by m.source_message_id)
    from public.tgcloner_source_messages m join s on s.id=m.source_id),
  'destinations',(select json_agg(json_build_object(
    'destination',row_to_json(d),
    'runs',(select json_agg(json_build_object('id',r.id,'source_id',r.source_id,
      'destination_id',r.destination_id,'status',r.status,'phase',r.phase,
      'high_watermark',r.snapshot_high_watermark,
      'manifest_closed_at',r.manifest_closed_at,'verified_at',r.last_verified_at,
      'manifest_ids',(select json_agg(mf.source_message_id order by mf.source_message_id)
        from public.tgcloner_clone_manifest mf where mf.run_id=r.id),
      'unsafe_work',(select count(*) from public.tgcloner_clone_work w where w.run_id=r.id
        and (w.status not in ('done','skipped','cancelled') or w.side_effect_state='ambiguous'))
    )) from public.tgcloner_clone_runs r where r.destination_id=d.id),
    'mappings',(select json_agg(json_build_object('source_message_id',m.source_message_id,
      'destination_message_id',m.destination_message_id,'status',m.status)
      order by m.source_message_id)
      from public.tgcloner_message_mappings m where m.destination_id=d.id)
  ) order by d.chat_id) from d)
)::text`;

export function buildTwoDestinationPreviews(data, { appendixStartSourceId = null } = {}) {
  if (data?.source?.chat_id !== SOURCE || data.source.active !== false ||
      !Array.isArray(data.messages) || data.messages.length !== 60 ||
      Number(data.messages.at(-1)?.source_message_id) !== 61 ||
      data.messages.at(-1)?.message_type !== 'text' ||
      !Array.isArray(data.destinations) || data.destinations.length !== 2 ||
      JSON.stringify(data.destinations.map((row) => row.destination?.chat_id)) !== JSON.stringify(DESTINATIONS)) {
    throw new Error('Verified 1to2 TEST source or destination set changed');
  }
  const baseline = data.messages.filter((message) => Number(message.source_message_id) <= 60)
    .map((message) => Number(message.source_message_id));
  if (baseline.length !== 59 || Number(baseline.at(-1)) !== 60) {
    throw new Error('Verified 59-post baseline changed');
  }
  const previews = [];
  for (const row of data.destinations) {
    const destination = row.destination;
    const runs = row.runs || [];
    const run = runs[0];
    if (destination.source_id !== data.source.id || destination.active !== false || runs.length !== 1 ||
        run.source_id !== data.source.id || run.destination_id !== destination.id ||
        run.status !== 'active' || run.phase !== 'ready_for_new' || !run.verified_at ||
        !run.manifest_closed_at || Number(run.high_watermark) !== 60 ||
        Number(run.unsafe_work) !== 0 || JSON.stringify(run.manifest_ids) !== JSON.stringify(baseline)) {
      throw new Error(`Destination ${destination.chat_id} has no verified, clean 59-post baseline`);
    }
    const index = buildCourseIndex({ source: data.source, destination, messages: data.messages,
      mappings: row.mappings, appendixStartSourceId });
    if (index.postCount !== 60 || index.highWatermark !== 61 || index.albumCount !== 10) {
      throw new Error(`Destination ${destination.chat_id} mapping or album inventory changed`);
    }
    previews.push({ destination: destination.chat_id, runId: run.id, index });
  }
  return previews;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appendixArg = process.argv.find((arg) => arg.startsWith('--appendix-start='));
  const appendixStartSourceId = appendixArg ? Number(appendixArg.split('=')[1]) : null;
  const output = execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  }).trim();
  for (const { destination, runId, index } of buildTwoDestinationPreviews(JSON.parse(output), { appendixStartSourceId })) {
    console.log(`E2E_1TO2_INDEX_PREVIEW destination=${destination} run=${runId} posts=${index.postCount} entries=${index.groupCount} albums=${index.albumCount} H=${index.highWatermark} hash=${index.hash} chars=${index.text.length}`);
    for (const [i, entry] of index.entries.entries()) {
      console.log(`INDEX_ENTRY ${String(i + 1).padStart(2, '0')} destination=${destination} source=${entry.sourceIds.join(',')} target=${entry.destinationId} title=${entry.title}`);
    }
  }
  console.log('E2E_1TO2_INDEX_PREVIEW_ONLY no_telegram_write=true');
}
