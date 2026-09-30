-- PR3 final hardening: read-only verify work may block without a side effect,
-- and READY_FOR_NEW is forbidden when current source content drifted after the
-- mapping/rewrite evidence was recorded.

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
  if v_work.side_effect_state not in ('not_started','not_applicable') then
    raise exception 'distributor_dependency_after_side_effect';
  end if;

  update public.tgcloner_clone_work
  set status = 'blocked_dependency',
      side_effect_state = case when side_effect_state = 'not_applicable' then 'not_applicable' else 'not_started' end,
      result = coalesce(p_result, '{}'::jsonb),
      last_error_code = coalesce(nullif(btrim(coalesce(p_error_code,'')),''), 'dependency_blocked'),
      last_error = left(coalesce(p_error, 'Dependency not satisfied.'), 2000),
      lease_owner = null, lease_expires_at = null, next_attempt_at = null,
      updated_at = v_now
  where id = p_work_id returning * into v_work;
  return v_work;
end;
$$;

create or replace function public.tgcloner_distributor_guard_ready_fingerprints()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.phase <> 'ready_for_new' or old.phase = 'ready_for_new' then
    return new;
  end if;

  if exists (
    select 1
    from public.tgcloner_source_messages m
    join public.tgcloner_message_mappings mm
      on mm.source_id = new.source_id
     and mm.destination_id = new.destination_id
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
    where m.source_id = new.source_id
      and mm.source_fingerprint is distinct from f.fingerprint
  ) then
    raise exception 'distributor_verify_source_fingerprint_drift';
  end if;

  return new;
end;
$$;

drop trigger if exists tgcloner_distributor_guard_ready_fingerprints_trg
  on public.tgcloner_clone_runs;
create trigger tgcloner_distributor_guard_ready_fingerprints_trg
before update of phase on public.tgcloner_clone_runs
for each row
execute function public.tgcloner_distributor_guard_ready_fingerprints();

revoke all on function public.tgcloner_distributor_block_dependency(uuid,text,bigint,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tgcloner_distributor_block_dependency(uuid,text,bigint,text,text,jsonb) to service_role;
