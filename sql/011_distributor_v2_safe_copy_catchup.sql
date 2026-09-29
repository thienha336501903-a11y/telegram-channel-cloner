-- System B Telegram Course Channel Distributor V2 safe-copy/catch-up layer.
-- PR2 remains disabled by default and performs no Telegram side effects by itself.

alter table public.tgcloner_clone_runs
  add column if not exists catchup_high_watermark bigint,
  add column if not exists catchup_quiescent_at timestamptz;

alter table public.tgcloner_clone_work
  add column if not exists sequence_no bigint,
  add column if not exists operation_kind text,
  add column if not exists source_fingerprint text;

update public.tgcloner_clone_work w
set sequence_no = coalesce(w.sequence_no, w.source_message_id),
    operation_kind = coalesce(w.operation_kind, case when w.phase = 'catchup' then 'copy' else w.phase end)
where w.sequence_no is null or w.operation_kind is null;

alter table public.tgcloner_clone_work
  alter column operation_kind set default 'copy';

create index if not exists tgcloner_clone_work_run_phase_sequence_idx
  on public.tgcloner_clone_work(run_id, phase, sequence_no, created_at, id);

-- Helper expression is duplicated intentionally in the SQL functions below so the
-- fingerprint contract remains the same as PR1 manifest snapshots.

create or replace function public.tgcloner_distributor_close_manifest(
  p_run_id uuid,
  p_high_watermark bigint,
  p_expected_message_ids bigint[]
)
returns public.tgcloner_clone_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean := false;
  v_run public.tgcloner_clone_runs;
  v_input bigint[] := coalesce(p_expected_message_ids, '{}'::bigint[]);
  v_expected bigint[] := '{}'::bigint[];
  v_existing bigint[] := '{}'::bigint[];
  v_missing bigint := 0;
  v_event_cursor bigint := 0;
  v_now timestamptz := clock_timestamp();
begin
  select coalesce(distributor_v2_enabled, false)
    into v_enabled
  from public.tgcloner_settings
  where singleton = true;
  if not coalesce(v_enabled, false) then
    raise exception 'distributor_v2_disabled';
  end if;

  if p_run_id is null or p_high_watermark is null or p_high_watermark < 0 then
    raise exception 'distributor_manifest_arguments_invalid';
  end if;
  if cardinality(v_input) > 100000 then
    raise exception 'distributor_manifest_too_large';
  end if;
  if exists (select 1 from unnest(v_input) as x(id) where id is null or id < 1 or id > p_high_watermark) then
    raise exception 'distributor_manifest_message_id_invalid';
  end if;

  select coalesce(array_agg(id order by id), '{}'::bigint[])
    into v_expected
  from (select distinct id from unnest(v_input) as x(id)) deduped;
  if cardinality(v_input) <> cardinality(v_expected) then
    raise exception 'distributor_manifest_duplicate_message_id';
  end if;

  select * into v_run
  from public.tgcloner_clone_runs
  where id = p_run_id
  for update;
  if not found then
    raise exception 'distributor_run_not_found';
  end if;

  if v_run.manifest_closed_at is not null then
    select coalesce(array_agg(source_message_id order by source_message_id), '{}'::bigint[])
      into v_existing
    from public.tgcloner_clone_manifest
    where run_id = p_run_id;
    if v_run.snapshot_high_watermark is distinct from p_high_watermark
       or v_existing is distinct from v_expected then
      raise exception 'distributor_manifest_already_closed_with_different_snapshot';
    end if;
    return v_run;
  end if;

  if v_run.status <> 'active' or v_run.phase not in ('registered','snapshotting') then
    raise exception 'distributor_run_not_snapshotable';
  end if;

  select count(*) into v_missing
  from unnest(v_expected) as x(id)
  where not exists (
    select 1 from public.tgcloner_source_messages m
    where m.source_id = v_run.source_id
      and m.source_message_id = x.id
  );
  if v_missing <> 0 then
    raise exception 'distributor_manifest_source_rows_missing:%', v_missing;
  end if;

  update public.tgcloner_clone_runs
  set phase = 'snapshotting', updated_at = v_now, version = version + 1
  where id = p_run_id;

  select coalesce(max(id), 0)
    into v_event_cursor
  from public.tgcloner_source_events
  where source_id = v_run.source_id;

  insert into public.tgcloner_clone_manifest(
    run_id, source_message_id, copy_unit_key, media_group_id, message_type,
    source_date, has_internal_links, is_pinned, source_fingerprint, snapshot_payload
  )
  select
    p_run_id,
    m.source_message_id,
    case when nullif(btrim(coalesce(m.media_group_id, '')), '') is not null
      then 'album:' || m.media_group_id
      else 'm:' || m.source_message_id::text end,
    m.media_group_id,
    m.message_type,
    m.source_date,
    m.has_internal_links,
    m.is_pinned,
    md5(jsonb_build_object(
      'message_type', m.message_type,
      'text', m.text,
      'text_entities', m.text_entities,
      'caption', m.caption,
      'caption_entities', m.caption_entities,
      'media_group_id', m.media_group_id,
      'is_pinned', m.is_pinned,
      'has_internal_links', m.has_internal_links,
      'source_date', m.source_date
    )::text),
    jsonb_build_object(
      'message_type', m.message_type,
      'text', m.text,
      'text_entities', m.text_entities,
      'caption', m.caption,
      'caption_entities', m.caption_entities,
      'media_group_id', m.media_group_id,
      'is_pinned', m.is_pinned,
      'has_internal_links', m.has_internal_links,
      'source_date', m.source_date
    )
  from public.tgcloner_source_messages m
  where m.source_id = v_run.source_id
    and m.source_message_id = any(v_expected)
  order by m.source_message_id
  on conflict (run_id, source_message_id) do nothing;

  insert into public.tgcloner_clone_work(
    run_id, phase, work_key, source_message_id, manifest_message_ids,
    status, side_effect_state, sequence_no, operation_kind
  )
  select
    p_run_id,
    'copy',
    'copy:' || copy_unit_key,
    min(source_message_id),
    array_agg(source_message_id order by source_message_id),
    'queued',
    'not_started',
    min(source_message_id),
    'copy'
  from public.tgcloner_clone_manifest
  where run_id = p_run_id
  group by copy_unit_key
  on conflict (run_id, work_key) do nothing;

  update public.tgcloner_clone_runs
  set snapshot_high_watermark = p_high_watermark,
      snapshot_event_cursor = v_event_cursor,
      manifest_closed_at = v_now,
      phase = 'backfilling',
      catchup_high_watermark = p_high_watermark,
      catchup_quiescent_at = null,
      updated_at = v_now,
      version = version + 1
  where id = p_run_id
  returning * into v_run;

  return v_run;
end;
$$;

create or replace function public.tgcloner_distributor_record_event(
  p_event_key text,
  p_source_id uuid,
  p_telegram_update_id bigint,
  p_origin text,
  p_event_kind text,
  p_source_message_id bigint,
  p_source_fingerprint text,
  p_payload jsonb,
  p_observed_at timestamptz
)
returns public.tgcloner_source_events
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_event public.tgcloner_source_events;
  v_key text := btrim(coalesce(p_event_key, ''));
begin
  if v_key = '' or p_source_id is null then
    raise exception 'distributor_event_identity_required';
  end if;
  perform 1 from public.tgcloner_sources where id = p_source_id;
  if not found then
    raise exception 'distributor_source_not_found';
  end if;

  insert into public.tgcloner_source_events(
    event_key, source_id, telegram_update_id, origin, event_kind,
    source_message_id, source_fingerprint, payload, observed_at
  )
  values (
    v_key, p_source_id, p_telegram_update_id, p_origin, p_event_kind,
    p_source_message_id, nullif(btrim(coalesce(p_source_fingerprint, '')), ''),
    coalesce(p_payload, '{}'::jsonb), coalesce(p_observed_at, now())
  )
  on conflict do nothing
  returning * into v_event;

  if not found then
    select * into v_event
    from public.tgcloner_source_events
    where event_key = v_key
       or (p_telegram_update_id is not null and origin = p_origin and telegram_update_id = p_telegram_update_id)
    order by id
    limit 1;
    if not found then
      raise exception 'distributor_event_dedupe_conflict_unresolved';
    end if;
    if v_event.source_id is distinct from p_source_id then
      raise exception 'distributor_event_identity_conflict';
    end if;
  end if;

  -- Any content event arriving after the backfill phase invalidates a previously
  -- quiescent/verified phase. We do not create Telegram side effects here; the
  -- gap scanner re-enters catch-up and groups albums safely.
  if p_event_kind in ('message_new','message_edit') then
    update public.tgcloner_clone_runs
    set phase = 'catching_up',
        catchup_quiescent_at = null,
        last_verified_at = null,
        updated_at = clock_timestamp(),
        version = version + 1
    where source_id = p_source_id
      and status = 'active'
      and phase in ('rewriting','verifying','ready_for_new','live_sync');
  end if;

  return v_event;
end;
$$;

create or replace function public.tgcloner_distributor_claim_work(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
returns setof public.tgcloner_clone_work
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean := false;
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_now timestamptz := clock_timestamp();
begin
  select coalesce(distributor_v2_enabled, false) into v_enabled
  from public.tgcloner_settings where singleton = true;
  if not coalesce(v_enabled, false) then return; end if;
  if v_worker = '' then raise exception 'distributor_worker_id_required'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'distributor_claim_limit_invalid'; end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 900 then raise exception 'distributor_lease_seconds_invalid'; end if;

  update public.tgcloner_clone_work
  set status = 'blocked_ambiguous', side_effect_state = 'ambiguous',
      last_error_code = 'lease_expired_after_side_effect_armed',
      last_error = 'Lease expired after external side effect was armed; reconciliation required.',
      lease_owner = null, lease_expires_at = null, updated_at = v_now
  where status = 'leased' and lease_expires_at <= v_now
    and side_effect_state in ('armed','confirmed','ambiguous');

  update public.tgcloner_clone_work
  set status = 'queued', lease_owner = null, lease_expires_at = null,
      next_attempt_at = null, last_error_code = 'lease_expired_before_side_effect',
      last_error = null, updated_at = v_now
  where status = 'leased' and lease_expires_at <= v_now
    and side_effect_state in ('not_started','not_applicable');

  update public.tgcloner_clone_work
  set status = 'failed',
      last_error_code = coalesce(last_error_code, 'max_attempts_exhausted'),
      last_error = coalesce(last_error, 'Maximum work attempts exhausted.'),
      finished_at = coalesce(finished_at, v_now), updated_at = v_now
  where status in ('queued','retry_wait') and attempt_count >= max_attempts;

  return query
  with candidates as (
    select w.id
    from public.tgcloner_clone_work w
    join public.tgcloner_clone_runs r on r.id = w.run_id
    where r.status = 'active'
      and (
        (r.phase = 'backfilling' and w.phase = 'copy') or
        (r.phase = 'catching_up' and w.phase = 'catchup') or
        (r.phase = 'rewriting' and w.phase in ('rewrite','pin')) or
        (r.phase = 'verifying' and w.phase = 'verify')
      )
      and w.status in ('queued','retry_wait')
      and w.attempt_count < w.max_attempts
      and (w.next_attempt_at is null or w.next_attempt_at <= v_now)
      and not exists (
        select 1 from public.tgcloner_clone_work l
        where l.run_id = w.run_id and l.status = 'leased'
      )
      and not exists (
        select 1 from public.tgcloner_clone_work p
        where p.run_id = w.run_id
          and p.phase = w.phase
          and coalesce(p.sequence_no, 9223372036854775807) < coalesce(w.sequence_no, 9223372036854775807)
          and p.status not in ('done','skipped','cancelled')
      )
    order by w.created_at, w.sequence_no nulls last, w.id
    for update of w skip locked
    limit p_limit
  )
  update public.tgcloner_clone_work w
  set status = 'leased', attempt_count = w.attempt_count + 1,
      next_attempt_at = null, lease_owner = v_worker,
      lease_generation = w.lease_generation + 1,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      started_at = coalesce(w.started_at, v_now), updated_at = v_now
  from candidates c
  where w.id = c.id
  returning w.*;
end;
$$;

create or replace function public.tgcloner_distributor_finish_copy(
  p_work_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_destination_message_ids bigint[],
  p_result jsonb
)
returns public.tgcloner_clone_work
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_work public.tgcloner_clone_work;
  v_run public.tgcloner_clone_runs;
  v_ids bigint[] := coalesce(p_destination_message_ids, '{}'::bigint[]);
  v_source_id bigint;
  v_dest_id bigint;
  v_fingerprint text;
  v_idx integer;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_work from public.tgcloner_clone_work where id = p_work_id for update;
  if not found then raise exception 'distributor_work_not_found'; end if;
  if v_work.status <> 'leased'
     or v_work.lease_owner is distinct from btrim(coalesce(p_worker_id, ''))
     or v_work.lease_generation is distinct from p_lease_generation
     or v_work.lease_expires_at is null or v_work.lease_expires_at <= v_now then
    raise exception 'distributor_work_lease_fenced';
  end if;
  if v_work.phase not in ('copy','catchup') or v_work.operation_kind <> 'copy' then
    raise exception 'distributor_copy_work_required';
  end if;
  if v_work.side_effect_state <> 'armed' then raise exception 'distributor_side_effect_not_armed'; end if;
  if cardinality(v_work.manifest_message_ids) = 0
     or cardinality(v_work.manifest_message_ids) <> cardinality(v_ids) then
    raise exception 'distributor_copy_result_count_mismatch';
  end if;
  if exists (select 1 from unnest(v_ids) x(id) where id is null or id < 1) then
    raise exception 'distributor_copy_destination_id_invalid';
  end if;

  select * into v_run from public.tgcloner_clone_runs where id = v_work.run_id for update;
  if not found then raise exception 'distributor_run_not_found'; end if;

  for v_idx in 1..cardinality(v_ids) loop
    v_source_id := v_work.manifest_message_ids[v_idx];
    v_dest_id := v_ids[v_idx];
    select md5(jsonb_build_object(
      'message_type', m.message_type,
      'text', m.text,
      'text_entities', m.text_entities,
      'caption', m.caption,
      'caption_entities', m.caption_entities,
      'media_group_id', m.media_group_id,
      'is_pinned', m.is_pinned,
      'has_internal_links', m.has_internal_links,
      'source_date', m.source_date
    )::text)
      into v_fingerprint
    from public.tgcloner_source_messages m
    where m.source_id = v_run.source_id and m.source_message_id = v_source_id;

    if v_fingerprint is null then
      select source_fingerprint into v_fingerprint
      from public.tgcloner_clone_manifest
      where run_id = v_run.id and source_message_id = v_source_id;
    end if;
    if v_fingerprint is null then raise exception 'distributor_copy_source_fingerprint_missing:%', v_source_id; end if;

    insert into public.tgcloner_message_mappings(
      source_id, source_message_id, destination_id, destination_message_id,
      status, run_id, work_id, source_fingerprint
    )
    values (
      v_run.source_id, v_source_id, v_run.destination_id, v_dest_id,
      'copied', v_run.id, v_work.id, v_fingerprint
    )
    on conflict (source_id, source_message_id, destination_id)
    do update set
      destination_message_id = excluded.destination_message_id,
      status = 'copied', run_id = excluded.run_id, work_id = excluded.work_id,
      source_fingerprint = excluded.source_fingerprint,
      updated_at = v_now
    where public.tgcloner_message_mappings.destination_message_id is null
       or public.tgcloner_message_mappings.destination_message_id = excluded.destination_message_id;

    if not found then raise exception 'distributor_copy_mapping_conflict:%', v_source_id; end if;
  end loop;

  update public.tgcloner_clone_work
  set status = 'done', side_effect_state = 'confirmed',
      result = coalesce(p_result, '{}'::jsonb), last_error_code = null, last_error = null,
      lease_owner = null, lease_expires_at = null, next_attempt_at = null,
      finished_at = v_now, updated_at = v_now
  where id = p_work_id
  returning * into v_work;
  return v_work;
end;
$$;

create or replace function public.tgcloner_distributor_finish_edit(
  p_work_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_result jsonb
)
returns public.tgcloner_clone_work
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_work public.tgcloner_clone_work;
  v_run public.tgcloner_clone_runs;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_work from public.tgcloner_clone_work where id = p_work_id for update;
  if not found then raise exception 'distributor_work_not_found'; end if;
  if v_work.status <> 'leased'
     or v_work.lease_owner is distinct from btrim(coalesce(p_worker_id, ''))
     or v_work.lease_generation is distinct from p_lease_generation
     or v_work.lease_expires_at is null or v_work.lease_expires_at <= v_now then
    raise exception 'distributor_work_lease_fenced';
  end if;
  if v_work.phase <> 'catchup' or v_work.operation_kind <> 'edit' then
    raise exception 'distributor_edit_work_required';
  end if;
  if v_work.side_effect_state <> 'armed' then raise exception 'distributor_side_effect_not_armed'; end if;
  if v_work.source_message_id is null or v_work.source_fingerprint is null then
    raise exception 'distributor_edit_identity_missing';
  end if;

  select * into v_run from public.tgcloner_clone_runs where id = v_work.run_id;
  if not found then raise exception 'distributor_run_not_found'; end if;

  update public.tgcloner_message_mappings
  set source_fingerprint = v_work.source_fingerprint,
      run_id = v_run.id,
      work_id = v_work.id,
      updated_at = v_now
  where source_id = v_run.source_id
    and source_message_id = v_work.source_message_id
    and destination_id = v_run.destination_id
    and destination_message_id is not null
    and status = 'copied';
  if not found then raise exception 'distributor_edit_mapping_missing'; end if;

  update public.tgcloner_clone_work
  set status = 'done', side_effect_state = 'confirmed',
      result = coalesce(p_result, '{}'::jsonb), last_error_code = null, last_error = null,
      lease_owner = null, lease_expires_at = null, next_attempt_at = null,
      finished_at = v_now, updated_at = v_now
  where id = p_work_id
  returning * into v_work;
  return v_work;
end;
$$;

create or replace function public.tgcloner_distributor_prepare_catchup(
  p_run_id uuid,
  p_album_settle_seconds integer default 5,
  p_quiet_seconds integer default 2
)
returns public.tgcloner_clone_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_run public.tgcloner_clone_runs;
  v_now timestamptz := clock_timestamp();
  v_barrier bigint := 0;
  v_event_barrier bigint := 0;
  v_inserted integer := 0;
  v_blockers integer := 0;
  v_pending integer := 0;
begin
  if p_album_settle_seconds < 0 or p_album_settle_seconds > 60 then raise exception 'distributor_album_settle_invalid'; end if;
  if p_quiet_seconds < 0 or p_quiet_seconds > 60 then raise exception 'distributor_quiet_seconds_invalid'; end if;

  select * into v_run from public.tgcloner_clone_runs where id = p_run_id for update;
  if not found then raise exception 'distributor_run_not_found'; end if;
  if v_run.status <> 'active' then return v_run; end if;
  if v_run.phase not in ('backfilling','catching_up') then raise exception 'distributor_run_not_catchup_phase'; end if;

  if v_run.phase = 'backfilling' then
    select count(*) into v_blockers from public.tgcloner_clone_work
    where run_id = p_run_id and phase = 'copy' and status in ('blocked_ambiguous','blocked_dependency','failed');
    if v_blockers > 0 then
      update public.tgcloner_clone_runs set status = 'blocked', status_reason = 'backfill_requires_attention', updated_at = v_now, version = version + 1
      where id = p_run_id returning * into v_run;
      return v_run;
    end if;
    select count(*) into v_pending from public.tgcloner_clone_work
    where run_id = p_run_id and phase = 'copy' and status not in ('done','skipped','cancelled');
    if v_pending > 0 then return v_run; end if;
    update public.tgcloner_clone_runs
    set phase = 'catching_up', catchup_quiescent_at = null, updated_at = v_now, version = version + 1
    where id = p_run_id returning * into v_run;
  end if;

  select count(*) into v_blockers from public.tgcloner_clone_work
  where run_id = p_run_id and phase = 'catchup' and status in ('blocked_ambiguous','blocked_dependency','failed');
  if v_blockers > 0 then
    update public.tgcloner_clone_runs set status = 'blocked', status_reason = 'catchup_requires_attention', updated_at = v_now, version = version + 1
    where id = p_run_id returning * into v_run;
    return v_run;
  end if;

  select count(*) into v_pending from public.tgcloner_clone_work
  where run_id = p_run_id and phase = 'catchup' and status not in ('done','skipped','cancelled');
  if v_pending > 0 then return v_run; end if;

  select coalesce(max(source_message_id), coalesce(v_run.snapshot_high_watermark, 0))
    into v_barrier
  from public.tgcloner_source_messages
  where source_id = v_run.source_id;
  select coalesce(max(id), 0) into v_event_barrier
  from public.tgcloner_source_events where source_id = v_run.source_id;

  -- New messages after H. Albums are scheduled only after the newest member has
  -- been stable for a small settle window so Bot webhook bursts stay grouped.
  with new_rows as (
    select m.*,
      case when nullif(btrim(coalesce(m.media_group_id, '')), '') is not null
        then 'album:' || m.media_group_id else 'm:' || m.source_message_id::text end as copy_unit_key
    from public.tgcloner_source_messages m
    where m.source_id = v_run.source_id
      and m.source_message_id > coalesce(v_run.snapshot_high_watermark, 0)
      and m.source_message_id <= v_barrier
      and not exists (
        select 1 from public.tgcloner_message_mappings mm
        where mm.source_id = v_run.source_id
          and mm.destination_id = v_run.destination_id
          and mm.source_message_id = m.source_message_id
          and mm.status = 'copied' and mm.destination_message_id is not null
      )
  ), stable_units as (
    select copy_unit_key,
      min(source_message_id) as first_id,
      max(updated_at) as last_update,
      array_agg(source_message_id order by source_message_id) as ids
    from new_rows
    group by copy_unit_key
    having copy_unit_key not like 'album:%'
       or max(updated_at) <= v_now - make_interval(secs => p_album_settle_seconds)
  )
  insert into public.tgcloner_clone_work(
    run_id, phase, work_key, source_message_id, manifest_message_ids,
    status, side_effect_state, sequence_no, operation_kind
  )
  select p_run_id, 'catchup', 'catchup:copy:' || copy_unit_key,
         first_id, ids, 'queued', 'not_started', first_id, 'copy'
  from stable_units
  on conflict (run_id, work_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    update public.tgcloner_clone_runs
    set catchup_high_watermark = greatest(coalesce(catchup_high_watermark,0), v_barrier),
        catchup_barrier_event_id = greatest(coalesce(catchup_barrier_event_id,0), v_event_barrier),
        catchup_quiescent_at = null, updated_at = v_now, version = version + 1
    where id = p_run_id returning * into v_run;
    return v_run;
  end if;

  -- Edits are detected by current source fingerprint vs mapping fingerprint, not
  -- only by event cursor. This closes the snapshot/event timing race.
  insert into public.tgcloner_clone_work(
    run_id, phase, work_key, source_message_id, manifest_message_ids,
    status, side_effect_state, sequence_no, operation_kind, source_fingerprint
  )
  select
    p_run_id,
    'catchup',
    'catchup:edit:' || m.source_message_id::text || ':' || f.fingerprint,
    m.source_message_id,
    array[m.source_message_id]::bigint[],
    case when m.has_internal_links then 'blocked_dependency' else 'queued' end,
    'not_started',
    m.source_message_id,
    'edit',
    f.fingerprint
  from public.tgcloner_source_messages m
  join public.tgcloner_message_mappings mm
    on mm.source_id = v_run.source_id
   and mm.destination_id = v_run.destination_id
   and mm.source_message_id = m.source_message_id
   and mm.status = 'copied'
   and mm.destination_message_id is not null
  cross join lateral (
    select md5(jsonb_build_object(
      'message_type', m.message_type,
      'text', m.text,
      'text_entities', m.text_entities,
      'caption', m.caption,
      'caption_entities', m.caption_entities,
      'media_group_id', m.media_group_id,
      'is_pinned', m.is_pinned,
      'has_internal_links', m.has_internal_links,
      'source_date', m.source_date
    )::text) as fingerprint
  ) f
  where m.source_id = v_run.source_id
    and m.source_message_id <= v_barrier
    and mm.source_fingerprint is distinct from f.fingerprint
  on conflict (run_id, work_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    update public.tgcloner_clone_runs
    set catchup_high_watermark = greatest(coalesce(catchup_high_watermark,0), v_barrier),
        catchup_barrier_event_id = greatest(coalesce(catchup_barrier_event_id,0), v_event_barrier),
        catchup_quiescent_at = null, updated_at = v_now, version = version + 1
    where id = p_run_id returning * into v_run;
    return v_run;
  end if;

  -- Two-step quiescence gate. First clean scan arms the quiet window; a later
  -- clean scan after the same watermark advances to rewriting.
  if v_run.catchup_quiescent_at is null
     or coalesce(v_run.catchup_high_watermark, -1) is distinct from v_barrier
     or coalesce(v_run.catchup_barrier_event_id, -1) is distinct from v_event_barrier then
    update public.tgcloner_clone_runs
    set catchup_high_watermark = v_barrier,
        catchup_barrier_event_id = v_event_barrier,
        catchup_quiescent_at = v_now,
        updated_at = v_now, version = version + 1
    where id = p_run_id returning * into v_run;
    return v_run;
  end if;

  if v_now < v_run.catchup_quiescent_at + make_interval(secs => p_quiet_seconds) then
    return v_run;
  end if;

  update public.tgcloner_clone_runs
  set phase = 'rewriting', catchup_quiescent_at = null,
      updated_at = v_now, version = version + 1
  where id = p_run_id returning * into v_run;
  return v_run;
end;
$$;

create or replace function public.tgcloner_distributor_set_run_control(
  p_run_id uuid,
  p_action text
)
returns public.tgcloner_clone_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_run public.tgcloner_clone_runs;
  v_action text := lower(btrim(coalesce(p_action, '')));
begin
  select * into v_run from public.tgcloner_clone_runs where id = p_run_id for update;
  if not found then raise exception 'distributor_run_not_found'; end if;
  if v_action = 'pause' then
    if v_run.status <> 'active' then raise exception 'distributor_run_not_active'; end if;
    update public.tgcloner_clone_runs set status = 'paused', status_reason = 'operator_paused', updated_at = clock_timestamp(), version = version + 1
    where id = p_run_id returning * into v_run;
  elsif v_action = 'resume' then
    if v_run.status not in ('paused','blocked') then raise exception 'distributor_run_not_resumable'; end if;
    if exists (
      select 1 from public.tgcloner_clone_work
      where run_id = p_run_id and status in ('blocked_ambiguous','blocked_dependency','failed')
    ) then
      raise exception 'distributor_run_has_unresolved_work';
    end if;
    update public.tgcloner_clone_runs set status = 'active', status_reason = null, updated_at = clock_timestamp(), version = version + 1
    where id = p_run_id returning * into v_run;
  else
    raise exception 'distributor_run_control_invalid';
  end if;
  return v_run;
end;
$$;

create or replace function public.tgcloner_distributor_resolve_ambiguous_copy(
  p_work_id uuid,
  p_resolution text,
  p_destination_message_ids bigint[] default null
)
returns public.tgcloner_clone_work
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_work public.tgcloner_clone_work;
  v_run public.tgcloner_clone_runs;
  v_resolution text := lower(btrim(coalesce(p_resolution, '')));
  v_ids bigint[] := coalesce(p_destination_message_ids, '{}'::bigint[]);
  v_source_id bigint;
  v_dest_id bigint;
  v_fp text;
  v_idx integer;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_work from public.tgcloner_clone_work where id = p_work_id for update;
  if not found then raise exception 'distributor_work_not_found'; end if;
  if v_work.status <> 'blocked_ambiguous' or v_work.operation_kind <> 'copy' then
    raise exception 'distributor_ambiguous_copy_required';
  end if;
  select * into v_run from public.tgcloner_clone_runs where id = v_work.run_id for update;
  if not found then raise exception 'distributor_run_not_found'; end if;

  if v_resolution = 'not_applied' then
    update public.tgcloner_clone_work
    set status = 'queued', side_effect_state = 'not_started', side_effect_started_at = null,
        last_error_code = null, last_error = null, next_attempt_at = null,
        finished_at = null, updated_at = v_now
    where id = p_work_id returning * into v_work;
    return v_work;
  end if;

  if v_resolution <> 'confirmed' then raise exception 'distributor_ambiguous_resolution_invalid'; end if;
  if cardinality(v_ids) <> cardinality(v_work.manifest_message_ids) or cardinality(v_ids) = 0 then
    raise exception 'distributor_ambiguous_confirmation_count_mismatch';
  end if;

  for v_idx in 1..cardinality(v_ids) loop
    v_source_id := v_work.manifest_message_ids[v_idx];
    v_dest_id := v_ids[v_idx];
    if v_dest_id is null or v_dest_id < 1 then raise exception 'distributor_copy_destination_id_invalid'; end if;
    select md5(jsonb_build_object(
      'message_type', m.message_type, 'text', m.text, 'text_entities', m.text_entities,
      'caption', m.caption, 'caption_entities', m.caption_entities,
      'media_group_id', m.media_group_id, 'is_pinned', m.is_pinned,
      'has_internal_links', m.has_internal_links, 'source_date', m.source_date
    )::text) into v_fp
    from public.tgcloner_source_messages m
    where m.source_id = v_run.source_id and m.source_message_id = v_source_id;
    if v_fp is null then
      select source_fingerprint into v_fp from public.tgcloner_clone_manifest
      where run_id = v_run.id and source_message_id = v_source_id;
    end if;

    insert into public.tgcloner_message_mappings(
      source_id, source_message_id, destination_id, destination_message_id,
      status, run_id, work_id, source_fingerprint
    ) values (
      v_run.source_id, v_source_id, v_run.destination_id, v_dest_id,
      'copied', v_run.id, v_work.id, v_fp
    )
    on conflict (source_id, source_message_id, destination_id)
    do update set destination_message_id = excluded.destination_message_id,
      status = 'copied', run_id = excluded.run_id, work_id = excluded.work_id,
      source_fingerprint = excluded.source_fingerprint, updated_at = v_now
    where public.tgcloner_message_mappings.destination_message_id is null
       or public.tgcloner_message_mappings.destination_message_id = excluded.destination_message_id;
    if not found then raise exception 'distributor_copy_mapping_conflict:%', v_source_id; end if;
  end loop;

  update public.tgcloner_clone_work
  set status = 'done', side_effect_state = 'confirmed',
      result = jsonb_build_object('operator_reconciled', true, 'destination_message_ids', v_ids),
      last_error_code = null, last_error = null, finished_at = v_now, updated_at = v_now
  where id = p_work_id returning * into v_work;
  return v_work;
end;
$$;

revoke all on function public.tgcloner_distributor_finish_copy(uuid,text,bigint,bigint[],jsonb) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_finish_edit(uuid,text,bigint,jsonb) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_prepare_catchup(uuid,integer,integer) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_set_run_control(uuid,text) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_resolve_ambiguous_copy(uuid,text,bigint[]) from public, anon, authenticated;

grant execute on function public.tgcloner_distributor_finish_copy(uuid,text,bigint,bigint[],jsonb) to service_role;
grant execute on function public.tgcloner_distributor_finish_edit(uuid,text,bigint,jsonb) to service_role;
grant execute on function public.tgcloner_distributor_prepare_catchup(uuid,integer,integer) to service_role;
grant execute on function public.tgcloner_distributor_set_run_control(uuid,text) to service_role;
grant execute on function public.tgcloner_distributor_resolve_ambiguous_copy(uuid,text,bigint[]) to service_role;
