-- System B Telegram Course Channel Distributor V2 fidelity/final verification layer.
-- PR3 remains disabled by default. It adds no scheduler and performs no Telegram
-- side effects by itself.

alter table public.tgcloner_clone_runs
  add column if not exists desired_pin_source_message_id bigint,
  add column if not exists desired_pin_destination_message_id bigint,
  add column if not exists verification_summary jsonb not null default '{}'::jsonb;

-- Backfill hidden MessageEntityTextUrl links that the legacy indexer could not see.
-- This is metadata-only and intentionally limited to URLs that point back into the
-- registered source channel.
update public.tgcloner_source_messages m
set has_internal_links = true,
    updated_at = now()
from public.tgcloner_sources s
where s.id = m.source_id
  and not m.has_internal_links
  and (
    exists (
      select 1 from jsonb_array_elements(coalesce(m.text_entities, '[]'::jsonb)) e
      where e->>'type' = 'text_link'
        and (
          (s.private_link_id is not null and e->>'url' ~ ('^https?://(t\\.me|telegram\\.me)/c/' || s.private_link_id || '/[0-9]+'))
          or
          (s.username is not null and lower(e->>'url') ~ ('^https?://(t\\.me|telegram\\.me)/(s/)?' || lower(regexp_replace(s.username, '^@', '')) || '/[0-9]+'))
        )
    )
    or exists (
      select 1 from jsonb_array_elements(coalesce(m.caption_entities, '[]'::jsonb)) e
      where e->>'type' = 'text_link'
        and (
          (s.private_link_id is not null and e->>'url' ~ ('^https?://(t\\.me|telegram\\.me)/c/' || s.private_link_id || '/[0-9]+'))
          or
          (s.username is not null and lower(e->>'url') ~ ('^https?://(t\\.me|telegram\\.me)/(s/)?' || lower(regexp_replace(s.username, '^@', '')) || '/[0-9]+'))
        )
    )
  );

create or replace function public.tgcloner_distributor_promote_link_dependencies(p_run_id uuid)
returns public.tgcloner_clone_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_run public.tgcloner_clone_runs;
  v_remaining integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_run from public.tgcloner_clone_runs where id = p_run_id for update;
  if not found then raise exception 'distributor_run_not_found'; end if;

  update public.tgcloner_clone_work w
  set status = 'skipped',
      side_effect_state = 'not_applicable',
      result = coalesce(w.result, '{}'::jsonb) || jsonb_build_object('promoted_to_rewrite', true),
      last_error_code = null,
      last_error = null,
      finished_at = coalesce(w.finished_at, v_now),
      updated_at = v_now
  from public.tgcloner_source_messages m
  where w.run_id = p_run_id
    and w.phase = 'catchup'
    and w.operation_kind = 'edit'
    and w.status = 'blocked_dependency'
    and m.source_id = v_run.source_id
    and m.source_message_id = w.source_message_id
    and m.has_internal_links;

  select count(*) into v_remaining
  from public.tgcloner_clone_work
  where run_id = p_run_id and status in ('blocked_ambiguous','blocked_dependency','failed');

  if v_run.status = 'blocked'
     and v_run.status_reason = 'catchup_requires_attention'
     and v_remaining = 0 then
    update public.tgcloner_clone_runs
    set status = 'active', status_reason = null, updated_at = v_now, version = version + 1
    where id = p_run_id returning * into v_run;
  else
    select * into v_run from public.tgcloner_clone_runs where id = p_run_id;
  end if;
  return v_run;
end;
$$;

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

  if p_pinned_source_message_id is not null then
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
  where id = p_run_id
  returning * into v_run;

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

  return v_run;
end;
$$;

create or replace function public.tgcloner_distributor_block_dependency(
  p_work_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_error_code text,
  p_error text,
  p_result jsonb
)
returns public.tgcloner_clone_work
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_work public.tgcloner_clone_work;
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
  if v_work.side_effect_state <> 'not_started' then raise exception 'distributor_dependency_after_side_effect'; end if;

  update public.tgcloner_clone_work
  set status = 'blocked_dependency',
      result = coalesce(p_result, '{}'::jsonb),
      last_error_code = coalesce(nullif(btrim(coalesce(p_error_code,'')),''), 'dependency_blocked'),
      last_error = left(coalesce(p_error, 'Dependency not satisfied.'), 2000),
      lease_owner = null, lease_expires_at = null, next_attempt_at = null,
      updated_at = v_now
  where id = p_work_id returning * into v_work;
  return v_work;
end;
$$;

create or replace function public.tgcloner_distributor_finish_rewrite(
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
  if v_work.phase <> 'rewrite' or v_work.operation_kind <> 'rewrite' then raise exception 'distributor_rewrite_work_required'; end if;
  if v_work.side_effect_state <> 'armed' then raise exception 'distributor_side_effect_not_armed'; end if;
  if coalesce((p_result->>'actual_verified')::boolean, false) is not true then raise exception 'distributor_rewrite_actual_verification_required'; end if;

  select * into v_run from public.tgcloner_clone_runs where id = v_work.run_id;
  if not found then raise exception 'distributor_run_not_found'; end if;

  update public.tgcloner_message_mappings
  set source_fingerprint = v_work.source_fingerprint,
      verified_at = v_now,
      run_id = v_run.id,
      work_id = v_work.id,
      updated_at = v_now
  where source_id = v_run.source_id
    and destination_id = v_run.destination_id
    and source_message_id = v_work.source_message_id
    and status = 'copied'
    and destination_message_id is not null;
  if not found then raise exception 'distributor_rewrite_mapping_missing'; end if;

  update public.tgcloner_clone_work
  set status = 'done', side_effect_state = 'confirmed', result = coalesce(p_result, '{}'::jsonb),
      last_error_code = null, last_error = null, lease_owner = null, lease_expires_at = null,
      next_attempt_at = null, finished_at = v_now, updated_at = v_now
  where id = p_work_id returning * into v_work;
  return v_work;
end;
$$;

create or replace function public.tgcloner_distributor_finish_pin(
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
  if v_work.phase <> 'pin' or v_work.operation_kind not in ('pin_set','pin_clear') then raise exception 'distributor_pin_work_required'; end if;
  if v_work.side_effect_state <> 'armed' then raise exception 'distributor_side_effect_not_armed'; end if;

  update public.tgcloner_clone_work
  set status = 'done', side_effect_state = 'confirmed', result = coalesce(p_result, '{}'::jsonb),
      last_error_code = null, last_error = null, lease_owner = null, lease_expires_at = null,
      next_attempt_at = null, finished_at = v_now, updated_at = v_now
  where id = p_work_id returning * into v_work;
  return v_work;
end;
$$;

create or replace function public.tgcloner_distributor_prepare_verification(p_run_id uuid)
returns public.tgcloner_clone_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_run public.tgcloner_clone_runs;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_run from public.tgcloner_clone_runs where id = p_run_id for update;
  if not found then raise exception 'distributor_run_not_found'; end if;
  if v_run.status <> 'active' then return v_run; end if;
  if v_run.phase <> 'rewriting' then return v_run; end if;

  if exists (
    select 1 from public.tgcloner_clone_work
    where run_id = p_run_id and phase in ('rewrite','pin')
      and status in ('blocked_ambiguous','blocked_dependency','failed')
  ) then
    update public.tgcloner_clone_runs
    set status = 'blocked', status_reason = 'fidelity_requires_attention', updated_at = v_now, version = version + 1
    where id = p_run_id returning * into v_run;
    return v_run;
  end if;

  if exists (
    select 1 from public.tgcloner_clone_work
    where run_id = p_run_id and phase in ('rewrite','pin')
      and status not in ('done','skipped','cancelled')
  ) then return v_run; end if;

  -- Every currently indexed internal-link message with a mapping must have a
  -- successful rewrite for its current fingerprint.
  if exists (
    select 1
    from public.tgcloner_source_messages m
    join public.tgcloner_message_mappings mm
      on mm.source_id = v_run.source_id and mm.destination_id = v_run.destination_id
     and mm.source_message_id = m.source_message_id and mm.status = 'copied'
     and mm.destination_message_id is not null
    cross join lateral (
      select md5(jsonb_build_object(
        'message_type', m.message_type, 'text', m.text, 'text_entities', m.text_entities,
        'caption', m.caption, 'caption_entities', m.caption_entities,
        'media_group_id', m.media_group_id, 'is_pinned', m.is_pinned,
        'has_internal_links', m.has_internal_links, 'source_date', m.source_date
      )::text) as fp
    ) f
    where m.source_id = v_run.source_id and m.has_internal_links
      and not exists (
        select 1 from public.tgcloner_clone_work w
        where w.run_id = p_run_id and w.phase = 'rewrite' and w.operation_kind = 'rewrite'
          and w.source_message_id = m.source_message_id and w.source_fingerprint = f.fp
          and w.status = 'done' and coalesce((w.result->>'actual_verified')::boolean, false)
      )
  ) then raise exception 'distributor_rewrite_coverage_incomplete'; end if;

  insert into public.tgcloner_clone_work(
    run_id, phase, work_key, status, side_effect_state, sequence_no, operation_kind
  ) values (
    p_run_id, 'verify', 'verify:final:' || v_run.version::text,
    'queued', 'not_applicable', 9223372036854775807, 'verify'
  ) on conflict (run_id, work_key) do nothing;

  update public.tgcloner_clone_runs
  set phase = 'verifying', updated_at = v_now, version = version + 1
  where id = p_run_id returning * into v_run;
  return v_run;
end;
$$;

create or replace function public.tgcloner_distributor_finish_verify(
  p_work_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_actual_pinned_destination_message_id bigint,
  p_summary jsonb
)
returns public.tgcloner_clone_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_work public.tgcloner_clone_work;
  v_run public.tgcloner_clone_runs;
  v_now timestamptz := clock_timestamp();
  v_source_barrier bigint := 0;
  v_event_barrier bigint := 0;
begin
  select * into v_work from public.tgcloner_clone_work where id = p_work_id for update;
  if not found then raise exception 'distributor_work_not_found'; end if;
  if v_work.status <> 'leased'
     or v_work.lease_owner is distinct from btrim(coalesce(p_worker_id, ''))
     or v_work.lease_generation is distinct from p_lease_generation
     or v_work.lease_expires_at is null or v_work.lease_expires_at <= v_now then
    raise exception 'distributor_work_lease_fenced';
  end if;
  if v_work.phase <> 'verify' or v_work.operation_kind <> 'verify' then raise exception 'distributor_verify_work_required'; end if;

  select * into v_run from public.tgcloner_clone_runs where id = v_work.run_id for update;
  if not found then raise exception 'distributor_run_not_found'; end if;
  if v_run.status <> 'active' or v_run.phase <> 'verifying' then raise exception 'distributor_run_not_verifying'; end if;

  select coalesce(max(source_message_id), coalesce(v_run.snapshot_high_watermark,0)) into v_source_barrier
  from public.tgcloner_source_messages where source_id = v_run.source_id;
  select coalesce(max(id),0) into v_event_barrier
  from public.tgcloner_source_events where source_id = v_run.source_id;

  if v_source_barrier > coalesce(v_run.catchup_high_watermark, v_run.snapshot_high_watermark, 0)
     or v_event_barrier > coalesce(v_run.catchup_barrier_event_id, v_run.snapshot_event_cursor, 0) then
    update public.tgcloner_clone_work
    set status = 'skipped', side_effect_state = 'not_applicable',
        result = jsonb_build_object('verification_stale', true),
        lease_owner = null, lease_expires_at = null, finished_at = v_now, updated_at = v_now
    where id = p_work_id;
    update public.tgcloner_clone_runs
    set phase = 'catching_up', last_verified_at = null, ready_at = null,
        updated_at = v_now, version = version + 1
    where id = v_run.id returning * into v_run;
    return v_run;
  end if;

  if exists (
    select 1 from public.tgcloner_clone_manifest mf
    where mf.run_id = v_run.id
      and not exists (
        select 1 from public.tgcloner_message_mappings mm
        where mm.source_id = v_run.source_id and mm.destination_id = v_run.destination_id
          and mm.source_message_id = mf.source_message_id
          and mm.status = 'copied' and mm.destination_message_id is not null
      )
  ) then raise exception 'distributor_verify_manifest_mapping_missing'; end if;

  if exists (
    select 1 from public.tgcloner_source_messages m
    where m.source_id = v_run.source_id
      and m.source_message_id > coalesce(v_run.snapshot_high_watermark,0)
      and m.source_message_id <= coalesce(v_run.catchup_high_watermark,0)
      and not exists (
        select 1 from public.tgcloner_message_mappings mm
        where mm.source_id = v_run.source_id and mm.destination_id = v_run.destination_id
          and mm.source_message_id = m.source_message_id
          and mm.status = 'copied' and mm.destination_message_id is not null
      )
  ) then raise exception 'distributor_verify_catchup_mapping_missing'; end if;

  if exists (
    select 1 from public.tgcloner_clone_work
    where run_id = v_run.id and id <> p_work_id
      and status in ('queued','leased','retry_wait','blocked_dependency','blocked_ambiguous','failed')
  ) then raise exception 'distributor_verify_work_not_clean'; end if;

  if v_run.desired_pin_destination_message_id is distinct from p_actual_pinned_destination_message_id then
    raise exception 'distributor_verify_pin_mismatch';
  end if;

  update public.tgcloner_message_mappings
  set verified_at = coalesce(verified_at, v_now), updated_at = v_now
  where source_id = v_run.source_id and destination_id = v_run.destination_id and status = 'copied';

  update public.tgcloner_clone_work
  set status = 'done', side_effect_state = 'not_applicable',
      result = coalesce(p_summary, '{}'::jsonb) || jsonb_build_object('actual_pin_verified', true),
      lease_owner = null, lease_expires_at = null, finished_at = v_now, updated_at = v_now
  where id = p_work_id;

  update public.tgcloner_clone_runs
  set phase = 'ready_for_new', last_verified_at = v_now, ready_at = v_now,
      verification_summary = coalesce(p_summary, '{}'::jsonb) || jsonb_build_object(
        'source_high_watermark', v_source_barrier,
        'event_barrier', v_event_barrier,
        'actual_pin_destination_message_id', p_actual_pinned_destination_message_id
      ),
      status_reason = null, updated_at = v_now, version = version + 1
  where id = v_run.id returning * into v_run;
  return v_run;
end;
$$;

revoke all on function public.tgcloner_distributor_promote_link_dependencies(uuid) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_prepare_fidelity(uuid,bigint) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_block_dependency(uuid,text,bigint,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_finish_rewrite(uuid,text,bigint,jsonb) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_finish_pin(uuid,text,bigint,jsonb) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_prepare_verification(uuid) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_finish_verify(uuid,text,bigint,bigint,jsonb) from public, anon, authenticated;

grant execute on function public.tgcloner_distributor_promote_link_dependencies(uuid) to service_role;
grant execute on function public.tgcloner_distributor_prepare_fidelity(uuid,bigint) to service_role;
grant execute on function public.tgcloner_distributor_block_dependency(uuid,text,bigint,text,text,jsonb) to service_role;
grant execute on function public.tgcloner_distributor_finish_rewrite(uuid,text,bigint,jsonb) to service_role;
grant execute on function public.tgcloner_distributor_finish_pin(uuid,text,bigint,jsonb) to service_role;
grant execute on function public.tgcloner_distributor_prepare_verification(uuid) to service_role;
grant execute on function public.tgcloner_distributor_finish_verify(uuid,text,bigint,bigint,jsonb) to service_role;
