-- Optional destination-owned course index. This migration is inert until a
-- service-role caller registers an independently verified, already pinned index.
-- It does not create Telegram messages or enable the Distributor V2 queue.

alter table public.tgcloner_destinations
  add column if not exists course_index_message_id bigint,
  add column if not exists course_index_content_hash text,
  add column if not exists course_index_high_watermark bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tgcloner_destinations'::regclass
      and conname = 'tgcloner_destination_course_index_complete_chk'
  ) then
    alter table public.tgcloner_destinations
      add constraint tgcloner_destination_course_index_complete_chk check (
        (course_index_message_id is null and course_index_content_hash is null and course_index_high_watermark is null)
        or (course_index_message_id is not null and course_index_message_id > 0
            and course_index_content_hash is not null and course_index_content_hash ~ '^[0-9a-f]{64}$'
            and course_index_high_watermark is not null and course_index_high_watermark > 0)
      );
  end if;
end
$$;

create or replace function public.tgcloner_distributor_register_course_index(
  p_run_id uuid,
  p_message_id bigint,
  p_content_hash text,
  p_high_watermark bigint
)
returns public.tgcloner_destinations
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_run public.tgcloner_clone_runs;
  v_destination public.tgcloner_destinations;
  v_source_high_watermark bigint;
begin
  if p_message_id is null or p_message_id < 1 or
     p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' or
     p_high_watermark is null or p_high_watermark < 1 then
    raise exception 'distributor_course_index_evidence_invalid';
  end if;

  select * into v_run from public.tgcloner_clone_runs where id = p_run_id for update;
  if not found or v_run.status <> 'active' or v_run.manifest_closed_at is null then
    raise exception 'distributor_course_index_run_not_ready';
  end if;
  if v_run.phase not in ('backfilling','catching_up','rewriting','verifying','ready_for_new') then
    raise exception 'distributor_course_index_run_phase_invalid';
  end if;

  select * into v_destination from public.tgcloner_destinations
  where id = v_run.destination_id and source_id = v_run.source_id for update;
  if not found or v_destination.active then raise exception 'distributor_course_index_destination_must_be_inactive'; end if;
  if v_destination.course_index_message_id is not null and v_destination.course_index_message_id <> p_message_id then
    raise exception 'distributor_course_index_message_changed';
  end if;
  if v_destination.course_index_high_watermark is not null and
     v_destination.course_index_high_watermark > p_high_watermark then
    raise exception 'distributor_course_index_watermark_regressed';
  end if;

  select max(source_message_id) into v_source_high_watermark
  from public.tgcloner_source_messages where source_id = v_run.source_id;
  if v_source_high_watermark is distinct from p_high_watermark then
    raise exception 'distributor_course_index_source_drift';
  end if;
  if exists (
    select 1 from public.tgcloner_source_messages m
    where m.source_id = v_run.source_id
      and not exists (
        select 1 from public.tgcloner_message_mappings mm
        where mm.source_id = v_run.source_id and mm.destination_id = v_run.destination_id
          and mm.source_message_id = m.source_message_id
          and mm.status = 'copied' and mm.destination_message_id is not null
      )
  ) or exists (
    select 1 from public.tgcloner_clone_work w
    where w.run_id = p_run_id and w.phase in ('copy','catchup')
      and w.status not in ('done','skipped','cancelled')
  ) then raise exception 'distributor_course_index_mapping_incomplete'; end if;
  if exists (
    select 1 from public.tgcloner_message_mappings mm
    where mm.destination_id = v_run.destination_id
      and mm.destination_message_id = p_message_id
  ) then raise exception 'distributor_course_index_overlaps_copied_post'; end if;

  update public.tgcloner_destinations
  set course_index_message_id = p_message_id,
      course_index_content_hash = p_content_hash,
      course_index_high_watermark = p_high_watermark,
      updated_at = clock_timestamp()
  where id = v_run.destination_id returning * into v_destination;
  return v_destination;
end;
$$;

-- Replace only the pin-planning RPC. Default source-pin parity is unchanged;
-- destination-owned indexes take precedence only for explicitly registered
-- destinations whose source currently has no pin.
create or replace function public.tgcloner_distributor_prepare_fidelity(
  p_run_id uuid,
  p_pinned_source_message_id bigint default null
)
returns public.tgcloner_clone_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_run public.tgcloner_clone_runs;
  v_pin_destination bigint;
  v_index_message_id bigint;
  v_index_high_watermark bigint;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_run from public.tgcloner_clone_runs where id = p_run_id for update;
  if not found then raise exception 'distributor_run_not_found'; end if;
  if v_run.status <> 'active' then return v_run; end if;
  if v_run.phase <> 'rewriting' then raise exception 'distributor_run_not_rewriting'; end if;

  if exists (
    select 1 from public.tgcloner_clone_work
    where run_id = p_run_id and phase in ('copy','catchup')
      and status not in ('done','skipped','cancelled')
  ) then raise exception 'distributor_fidelity_prerequisites_incomplete'; end if;

  select course_index_message_id, course_index_high_watermark
    into v_index_message_id, v_index_high_watermark
  from public.tgcloner_destinations
  where id = v_run.destination_id and source_id = v_run.source_id;

  if v_index_message_id is not null then
    if p_pinned_source_message_id is not null then
      raise exception 'distributor_course_index_source_pin_conflict';
    end if;
    if v_index_high_watermark < coalesce(v_run.catchup_high_watermark, v_run.snapshot_high_watermark, 0)
       or exists (
         select 1 from public.tgcloner_source_messages m
         where m.source_id = v_run.source_id and m.source_message_id > v_index_high_watermark
       ) then
      raise exception 'distributor_course_index_stale';
    end if;
    v_pin_destination := v_index_message_id;
  elsif p_pinned_source_message_id is not null then
    select destination_message_id into v_pin_destination
    from public.tgcloner_message_mappings
    where source_id = v_run.source_id
      and destination_id = v_run.destination_id
      and source_message_id = p_pinned_source_message_id
      and status = 'copied'
      and destination_message_id is not null;
    if v_pin_destination is null then raise exception 'distributor_pin_mapping_missing'; end if;
  end if;

  update public.tgcloner_clone_runs
  set desired_pin_source_message_id = p_pinned_source_message_id,
      desired_pin_destination_message_id = v_pin_destination,
      updated_at = v_now,
      version = version + 1
  where id = p_run_id returning * into v_run;

  insert into public.tgcloner_clone_work(
    run_id, phase, work_key, source_message_id, manifest_message_ids,
    status, side_effect_state, sequence_no, operation_kind, source_fingerprint
  )
  select
    p_run_id,
    'rewrite',
    'rewrite:' || m.source_message_id::text || ':' || f.fingerprint,
    m.source_message_id,
    array[m.source_message_id]::bigint[],
    'queued',
    'not_started',
    m.source_message_id,
    'rewrite',
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
  where m.source_id = v_run.source_id and m.has_internal_links
  on conflict (run_id, work_key) do nothing;

  if v_index_message_id is null then
    insert into public.tgcloner_clone_work(
      run_id, phase, work_key, source_message_id, manifest_message_ids,
      status, side_effect_state, sequence_no, operation_kind
    ) values (
      p_run_id,
      'pin',
      case when p_pinned_source_message_id is null then 'pin:clear' else 'pin:set:' || p_pinned_source_message_id::text end,
      p_pinned_source_message_id,
      case when p_pinned_source_message_id is null then '{}'::bigint[] else array[p_pinned_source_message_id]::bigint[] end,
      'queued',
      'not_started',
      9223372036854775806,
      case when p_pinned_source_message_id is null then 'pin_clear' else 'pin_set' end
    ) on conflict (run_id, work_key) do nothing;
  elsif exists (
    select 1 from public.tgcloner_clone_work
    where run_id = p_run_id and phase = 'pin' and status not in ('done','skipped','cancelled')
  ) then
    raise exception 'distributor_course_index_legacy_pin_work_pending';
  end if;

  return v_run;
end;
$$;

-- The final READY transition still verifies the live Bot API pin via
-- finish_verify. This guard also refuses a stale or swapped index at commit.
create or replace function public.tgcloner_distributor_guard_ready_course_index()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_index public.tgcloner_destinations;
  v_current_high_watermark bigint;
begin
  if new.phase <> 'ready_for_new' or old.phase = 'ready_for_new' then return new; end if;
  select * into v_index from public.tgcloner_destinations
  where id = new.destination_id and source_id = new.source_id;
  if v_index.course_index_message_id is null then return new; end if;
  select max(source_message_id) into v_current_high_watermark
  from public.tgcloner_source_messages where source_id = new.source_id;
  if new.desired_pin_destination_message_id is distinct from v_index.course_index_message_id or
     new.desired_pin_source_message_id is not null or
     v_index.course_index_high_watermark is distinct from v_current_high_watermark then
    raise exception 'distributor_verify_course_index_stale';
  end if;
  return new;
end;
$$;

drop trigger if exists tgcloner_distributor_guard_ready_course_index_trg
  on public.tgcloner_clone_runs;
create trigger tgcloner_distributor_guard_ready_course_index_trg
before update of phase on public.tgcloner_clone_runs
for each row execute function public.tgcloner_distributor_guard_ready_course_index();

revoke all on function public.tgcloner_distributor_register_course_index(uuid,bigint,text,bigint) from public, anon, authenticated;
grant execute on function public.tgcloner_distributor_register_course_index(uuid,bigint,text,bigint) to service_role;
revoke all on function public.tgcloner_distributor_prepare_fidelity(uuid,bigint) from public, anon, authenticated;
grant execute on function public.tgcloner_distributor_prepare_fidelity(uuid,bigint) to service_role;
revoke all on function public.tgcloner_distributor_guard_ready_course_index() from public, anon, authenticated;
