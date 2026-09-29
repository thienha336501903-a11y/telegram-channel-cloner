-- PR2 hardening: freeze the content version associated with every copy side effect
-- and fail closed if an album gains a late member after any member was mapped.

alter table public.tgcloner_clone_work
  add column if not exists source_fingerprints jsonb not null default '{}'::jsonb;

create or replace function public.tgcloner_distributor_capture_copy_fingerprints()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_source_id uuid;
  v_expected integer;
  v_captured integer;
begin
  if new.phase <> 'catchup' or new.operation_kind <> 'copy' then
    return new;
  end if;
  v_expected := cardinality(new.manifest_message_ids);
  if v_expected is null or v_expected = 0 then
    raise exception 'distributor_catchup_copy_members_missing';
  end if;

  select source_id into v_source_id
  from public.tgcloner_clone_runs
  where id = new.run_id;
  if not found then raise exception 'distributor_run_not_found'; end if;

  select
    coalesce(jsonb_object_agg(
      m.source_message_id::text,
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
      )::text)
    ), '{}'::jsonb),
    count(*)::integer
  into new.source_fingerprints, v_captured
  from public.tgcloner_source_messages m
  where m.source_id = v_source_id
    and m.source_message_id = any(new.manifest_message_ids);

  if v_captured <> v_expected then
    raise exception 'distributor_catchup_copy_fingerprint_rows_missing:%/%', v_captured, v_expected;
  end if;
  return new;
end;
$$;

drop trigger if exists tgcloner_distributor_capture_copy_fingerprints_trg
  on public.tgcloner_clone_work;
create trigger tgcloner_distributor_capture_copy_fingerprints_trg
before insert or update of manifest_message_ids, phase, operation_kind
on public.tgcloner_clone_work
for each row
execute function public.tgcloner_distributor_capture_copy_fingerprints();

create or replace function public.tgcloner_distributor_guard_late_album_member()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean := false;
  v_run record;
  v_group text := nullif(btrim(coalesce(new.media_group_id, '')), '');
  v_ids bigint[];
  v_first bigint;
begin
  if v_group is null then return new; end if;
  select coalesce(distributor_v2_enabled, false) into v_enabled
  from public.tgcloner_settings where singleton = true;
  if not coalesce(v_enabled, false) then return new; end if;

  for v_run in
    select r.id, r.destination_id
    from public.tgcloner_clone_runs r
    where r.source_id = new.source_id
      and r.status = 'active'
      and r.manifest_closed_at is not null
  loop
    -- If this exact member is already mapped, an ordinary upsert/edit is not
    -- album membership drift.
    if exists (
      select 1 from public.tgcloner_message_mappings mm
      where mm.source_id = new.source_id
        and mm.destination_id = v_run.destination_id
        and mm.source_message_id = new.source_message_id
        and mm.status = 'copied'
        and mm.destination_message_id is not null
    ) then
      continue;
    end if;

    -- A newly seen member is dangerous only after another member of the same
    -- Telegram media group has already been copied to this destination.
    if exists (
      select 1
      from public.tgcloner_source_messages sm
      join public.tgcloner_message_mappings mm
        on mm.source_id = sm.source_id
       and mm.source_message_id = sm.source_message_id
       and mm.destination_id = v_run.destination_id
       and mm.status = 'copied'
       and mm.destination_message_id is not null
      where sm.source_id = new.source_id
        and sm.media_group_id = v_group
        and sm.source_message_id <> new.source_message_id
    ) then
      select array_agg(sm.source_message_id order by sm.source_message_id), min(sm.source_message_id)
        into v_ids, v_first
      from public.tgcloner_source_messages sm
      where sm.source_id = new.source_id and sm.media_group_id = v_group;

      insert into public.tgcloner_clone_work(
        run_id, phase, work_key, source_message_id, manifest_message_ids,
        status, side_effect_state, sequence_no, operation_kind
      ) values (
        v_run.id, 'catchup', 'catchup:album-drift:' || v_group,
        coalesce(v_first, new.source_message_id), coalesce(v_ids, array[new.source_message_id]::bigint[]),
        'blocked_dependency', 'not_started', coalesce(v_first, new.source_message_id), 'copy'
      )
      on conflict (run_id, work_key) do update
        set manifest_message_ids = excluded.manifest_message_ids,
            source_message_id = excluded.source_message_id,
            sequence_no = excluded.sequence_no,
            status = 'blocked_dependency',
            last_error_code = 'late_album_member_after_copy',
            last_error = 'Telegram album membership changed after at least one member was already copied; reconciliation required.',
            updated_at = clock_timestamp();

      update public.tgcloner_clone_runs
      set status = 'blocked',
          status_reason = 'late_album_member_after_copy',
          catchup_quiescent_at = null,
          updated_at = clock_timestamp(),
          version = version + 1
      where id = v_run.id;
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists tgcloner_distributor_guard_late_album_member_trg
  on public.tgcloner_source_messages;
create trigger tgcloner_distributor_guard_late_album_member_trg
after insert or update of media_group_id
on public.tgcloner_source_messages
for each row
execute function public.tgcloner_distributor_guard_late_album_member();

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
  v_source_message_id bigint;
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
    v_source_message_id := v_work.manifest_message_ids[v_idx];
    v_dest_id := v_ids[v_idx];

    if v_work.phase = 'copy' then
      select source_fingerprint into v_fingerprint
      from public.tgcloner_clone_manifest
      where run_id = v_run.id and source_message_id = v_source_message_id;
    else
      v_fingerprint := nullif(v_work.source_fingerprints ->> v_source_message_id::text, '');
    end if;
    if v_fingerprint is null then
      raise exception 'distributor_copy_expected_fingerprint_missing:%', v_source_message_id;
    end if;

    insert into public.tgcloner_message_mappings(
      source_id, source_message_id, destination_id, destination_message_id,
      status, run_id, work_id, source_fingerprint
    ) values (
      v_run.source_id, v_source_message_id, v_run.destination_id, v_dest_id,
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
    if not found then raise exception 'distributor_copy_mapping_conflict:%', v_source_message_id; end if;
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
  v_source_message_id bigint;
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
    v_source_message_id := v_work.manifest_message_ids[v_idx];
    v_dest_id := v_ids[v_idx];
    if v_dest_id is null or v_dest_id < 1 then raise exception 'distributor_copy_destination_id_invalid'; end if;

    if v_work.phase = 'copy' then
      select source_fingerprint into v_fp
      from public.tgcloner_clone_manifest
      where run_id = v_run.id and source_message_id = v_source_message_id;
    else
      v_fp := nullif(v_work.source_fingerprints ->> v_source_message_id::text, '');
    end if;
    if v_fp is null then raise exception 'distributor_copy_expected_fingerprint_missing:%', v_source_message_id; end if;

    insert into public.tgcloner_message_mappings(
      source_id, source_message_id, destination_id, destination_message_id,
      status, run_id, work_id, source_fingerprint
    ) values (
      v_run.source_id, v_source_message_id, v_run.destination_id, v_dest_id,
      'copied', v_run.id, v_work.id, v_fp
    )
    on conflict (source_id, source_message_id, destination_id)
    do update set destination_message_id = excluded.destination_message_id,
      status = 'copied', run_id = excluded.run_id, work_id = excluded.work_id,
      source_fingerprint = excluded.source_fingerprint, updated_at = v_now
    where public.tgcloner_message_mappings.destination_message_id is null
       or public.tgcloner_message_mappings.destination_message_id = excluded.destination_message_id;
    if not found then raise exception 'distributor_copy_mapping_conflict:%', v_source_message_id; end if;
  end loop;

  update public.tgcloner_clone_work
  set status = 'done', side_effect_state = 'confirmed',
      result = jsonb_build_object('operator_reconciled', true, 'destination_message_ids', v_ids),
      last_error_code = null, last_error = null, finished_at = v_now, updated_at = v_now
  where id = p_work_id returning * into v_work;
  return v_work;
end;
$$;

revoke all on function public.tgcloner_distributor_capture_copy_fingerprints() from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_guard_late_album_member() from public, anon, authenticated;
grant execute on function public.tgcloner_distributor_capture_copy_fingerprints() to service_role;
grant execute on function public.tgcloner_distributor_guard_late_album_member() to service_role;
