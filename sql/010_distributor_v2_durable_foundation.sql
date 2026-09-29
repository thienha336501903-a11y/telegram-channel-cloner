-- System B Telegram Course Channel Distributor V2 durable data foundation.
-- PR1 is deliberately data-only/safety-first: it does not call Telegram, enable
-- the scheduler, create production clone runs, or alter Reader/V5 behavior.

-- Fail closed if this database is not the expected tgcloner layout.
do $$
begin
  if to_regclass('public.tgcloner_sources') is null
     or to_regclass('public.tgcloner_destinations') is null
     or to_regclass('public.tgcloner_source_messages') is null
     or to_regclass('public.tgcloner_message_mappings') is null
     or to_regclass('public.tgcloner_settings') is null then
    raise exception 'distributor_v2_required_tgcloner_schema_missing';
  end if;

  if exists (
    select 1 from public.tgcloner_destinations where source_id is null
  ) then
    raise exception 'distributor_v2_unbound_destination_preflight_failed';
  end if;
end
$$;

alter table public.tgcloner_destinations
  alter column source_id set not null,
  alter column active set default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.tgcloner_destinations'::regclass
      and conname = 'tgcloner_destinations_id_source_id_key'
  ) then
    alter table public.tgcloner_destinations
      add constraint tgcloner_destinations_id_source_id_key unique (id, source_id);
  end if;
end
$$;

alter table public.tgcloner_settings
  add column if not exists distributor_v2_enabled boolean not null default false;

create table if not exists public.tgcloner_clone_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.tgcloner_sources(id) on delete cascade,
  destination_id uuid not null,
  mode text not null default 'initial_backfill'
    check (mode in ('initial_backfill','resync')),
  phase text not null default 'registered'
    check (phase in (
      'registered','snapshotting','backfilling','rewriting','catching_up',
      'verifying','ready_for_new','live_sync'
    )),
  status text not null default 'active'
    check (status in ('active','paused','blocked','failed','cancelled','superseded')),
  status_reason text,
  snapshot_high_watermark bigint,
  snapshot_event_cursor bigint,
  catchup_barrier_event_id bigint,
  manifest_closed_at timestamptz,
  last_verified_at timestamptz,
  ready_at timestamptz,
  live_at timestamptz,
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tgcloner_clone_runs_destination_source_fk
    foreign key (destination_id, source_id)
    references public.tgcloner_destinations(id, source_id)
    on delete cascade
);

create unique index if not exists tgcloner_clone_runs_one_live_per_destination_idx
  on public.tgcloner_clone_runs(destination_id)
  where status not in ('failed','cancelled','superseded');
create index if not exists tgcloner_clone_runs_source_idx
  on public.tgcloner_clone_runs(source_id, created_at desc);
create index if not exists tgcloner_clone_runs_status_idx
  on public.tgcloner_clone_runs(status, phase, updated_at);

create table if not exists public.tgcloner_clone_manifest (
  run_id uuid not null references public.tgcloner_clone_runs(id) on delete cascade,
  source_message_id bigint not null,
  copy_unit_key text not null check (btrim(copy_unit_key) <> ''),
  media_group_id text,
  message_type text not null,
  source_date timestamptz,
  has_internal_links boolean not null default false,
  is_pinned boolean not null default false,
  source_fingerprint text not null,
  snapshot_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, source_message_id)
);
create index if not exists tgcloner_clone_manifest_copy_unit_idx
  on public.tgcloner_clone_manifest(run_id, copy_unit_key, source_message_id);

create table if not exists public.tgcloner_source_events (
  id bigint generated always as identity primary key,
  event_key text not null unique check (btrim(event_key) <> ''),
  source_id uuid not null references public.tgcloner_sources(id) on delete cascade,
  telegram_update_id bigint,
  origin text not null
    check (origin in ('bot_webhook','reader_gap','reader_reconcile','admin')),
  event_kind text not null
    check (event_kind in ('message_new','message_edit','pin_change','delete_detected')),
  source_message_id bigint,
  source_fingerprint text,
  payload jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists tgcloner_source_events_origin_update_key
  on public.tgcloner_source_events(origin, telegram_update_id)
  where telegram_update_id is not null;
create index if not exists tgcloner_source_events_source_cursor_idx
  on public.tgcloner_source_events(source_id, id);
create index if not exists tgcloner_source_events_source_message_idx
  on public.tgcloner_source_events(source_id, source_message_id, id)
  where source_message_id is not null;

create table if not exists public.tgcloner_clone_work (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.tgcloner_clone_runs(id) on delete cascade,
  phase text not null
    check (phase in ('copy','rewrite','pin','catchup','verify')),
  work_key text not null check (btrim(work_key) <> ''),
  source_message_id bigint,
  manifest_message_ids bigint[] not null default '{}'::bigint[],
  event_id bigint references public.tgcloner_source_events(id) on delete set null,
  status text not null default 'queued'
    check (status in (
      'queued','leased','retry_wait','done','skipped','blocked_dependency',
      'blocked_ambiguous','failed','cancelled'
    )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),
  next_attempt_at timestamptz,
  lease_owner text,
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_expires_at timestamptz,
  side_effect_state text not null default 'not_started'
    check (side_effect_state in ('not_started','armed','confirmed','ambiguous','not_applicable')),
  side_effect_started_at timestamptz,
  last_error_code text,
  last_error text,
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tgcloner_clone_work_run_key unique (run_id, work_key),
  constraint tgcloner_clone_work_lease_shape_check check (
    (status = 'leased' and lease_owner is not null and lease_expires_at is not null)
    or
    (status <> 'leased' and lease_owner is null and lease_expires_at is null)
  )
);
create index if not exists tgcloner_clone_work_queue_idx
  on public.tgcloner_clone_work(status, next_attempt_at, created_at);
create index if not exists tgcloner_clone_work_lease_idx
  on public.tgcloner_clone_work(lease_expires_at)
  where status = 'leased';
create index if not exists tgcloner_clone_work_run_phase_idx
  on public.tgcloner_clone_work(run_id, phase, status);

alter table public.tgcloner_message_mappings
  add column if not exists run_id uuid,
  add column if not exists work_id uuid,
  add column if not exists source_fingerprint text,
  add column if not exists verified_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tgcloner_message_mappings'::regclass
      and conname = 'tgcloner_message_mappings_run_id_fkey'
  ) then
    alter table public.tgcloner_message_mappings
      add constraint tgcloner_message_mappings_run_id_fkey
      foreign key (run_id) references public.tgcloner_clone_runs(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tgcloner_message_mappings'::regclass
      and conname = 'tgcloner_message_mappings_work_id_fkey'
  ) then
    alter table public.tgcloner_message_mappings
      add constraint tgcloner_message_mappings_work_id_fkey
      foreign key (work_id) references public.tgcloner_clone_work(id) on delete set null;
  end if;
end
$$;

create unique index if not exists tgcloner_mappings_destination_message_unique_idx
  on public.tgcloner_message_mappings(destination_id, destination_message_id)
  where destination_message_id is not null;

alter table public.tgcloner_clone_runs enable row level security;
alter table public.tgcloner_clone_manifest enable row level security;
alter table public.tgcloner_source_events enable row level security;
alter table public.tgcloner_clone_work enable row level security;

revoke all on table public.tgcloner_clone_runs from public, anon, authenticated;
revoke all on table public.tgcloner_clone_manifest from public, anon, authenticated;
revoke all on table public.tgcloner_source_events from public, anon, authenticated;
revoke all on table public.tgcloner_clone_work from public, anon, authenticated;
revoke all on sequence public.tgcloner_source_events_id_seq from public, anon, authenticated;

grant select, insert, update, delete on table public.tgcloner_clone_runs to service_role;
grant select, insert, update, delete on table public.tgcloner_clone_manifest to service_role;
grant select, insert, update, delete on table public.tgcloner_source_events to service_role;
grant select, insert, update, delete on table public.tgcloner_clone_work to service_role;
grant usage, select on sequence public.tgcloner_source_events_id_seq to service_role;

create or replace function public.tgcloner_distributor_create_run(
  p_source_id uuid,
  p_destination_id uuid,
  p_mode text
)
returns public.tgcloner_clone_runs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean := false;
  v_destination_source uuid;
  v_destination_active boolean;
  v_existing uuid;
  v_run public.tgcloner_clone_runs;
begin
  select coalesce(distributor_v2_enabled, false)
    into v_enabled
  from public.tgcloner_settings
  where singleton = true;

  if not coalesce(v_enabled, false) then
    raise exception 'distributor_v2_disabled';
  end if;
  if p_source_id is null or p_destination_id is null then
    raise exception 'distributor_source_and_destination_required';
  end if;
  if p_mode not in ('initial_backfill','resync') then
    raise exception 'distributor_run_mode_invalid';
  end if;

  perform 1 from public.tgcloner_sources where id = p_source_id;
  if not found then
    raise exception 'distributor_source_not_found';
  end if;

  select source_id, active
    into v_destination_source, v_destination_active
  from public.tgcloner_destinations
  where id = p_destination_id
  for update;
  if not found then
    raise exception 'distributor_destination_not_found';
  end if;
  if v_destination_source is distinct from p_source_id then
    raise exception 'distributor_destination_source_mismatch';
  end if;
  if v_destination_active then
    raise exception 'distributor_destination_must_be_inactive';
  end if;

  select id into v_existing
  from public.tgcloner_clone_runs
  where destination_id = p_destination_id
    and status not in ('failed','cancelled','superseded')
  limit 1;
  if found then
    raise exception 'distributor_run_already_active';
  end if;

  insert into public.tgcloner_clone_runs(source_id, destination_id, mode, phase, status)
  values (p_source_id, p_destination_id, p_mode, 'registered', 'active')
  returning * into v_run;
  return v_run;
exception
  when unique_violation then
    raise exception 'distributor_run_already_active';
end;
$$;

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
    select 1
    from public.tgcloner_source_messages m
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
    run_id,
    source_message_id,
    copy_unit_key,
    media_group_id,
    message_type,
    source_date,
    has_internal_links,
    is_pinned,
    source_fingerprint,
    snapshot_payload
  )
  select
    p_run_id,
    m.source_message_id,
    case
      when nullif(btrim(coalesce(m.media_group_id, '')), '') is not null
        then 'album:' || m.media_group_id
      else 'm:' || m.source_message_id::text
    end,
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
    run_id,
    phase,
    work_key,
    source_message_id,
    manifest_message_ids,
    status,
    side_effect_state
  )
  select
    p_run_id,
    'copy',
    'copy:' || copy_unit_key,
    min(source_message_id),
    array_agg(source_message_id order by source_message_id),
    'queued',
    'not_started'
  from public.tgcloner_clone_manifest
  where run_id = p_run_id
  group by copy_unit_key
  on conflict (run_id, work_key) do nothing;

  update public.tgcloner_clone_runs
  set snapshot_high_watermark = p_high_watermark,
      snapshot_event_cursor = v_event_cursor,
      manifest_closed_at = v_now,
      phase = 'backfilling',
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

  if found then
    return v_event;
  end if;

  select * into v_event
  from public.tgcloner_source_events
  where event_key = v_key
     or (
       p_telegram_update_id is not null
       and origin = p_origin
       and telegram_update_id = p_telegram_update_id
     )
  order by id
  limit 1;

  if not found then
    raise exception 'distributor_event_dedupe_conflict_unresolved';
  end if;
  if v_event.source_id is distinct from p_source_id then
    raise exception 'distributor_event_identity_conflict';
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
  select coalesce(distributor_v2_enabled, false)
    into v_enabled
  from public.tgcloner_settings
  where singleton = true;
  if not coalesce(v_enabled, false) then
    return;
  end if;
  if v_worker = '' then
    raise exception 'distributor_worker_id_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'distributor_claim_limit_invalid';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 900 then
    raise exception 'distributor_lease_seconds_invalid';
  end if;

  update public.tgcloner_clone_work
  set status = 'blocked_ambiguous',
      side_effect_state = 'ambiguous',
      last_error_code = 'lease_expired_after_side_effect_armed',
      last_error = 'Lease expired after external side effect was armed; reconciliation required.',
      lease_owner = null,
      lease_expires_at = null,
      updated_at = v_now
  where status = 'leased'
    and lease_expires_at <= v_now
    and side_effect_state in ('armed','confirmed','ambiguous');

  update public.tgcloner_clone_work
  set status = 'queued',
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = null,
      last_error_code = 'lease_expired_before_side_effect',
      last_error = null,
      updated_at = v_now
  where status = 'leased'
    and lease_expires_at <= v_now
    and side_effect_state in ('not_started','not_applicable');

  update public.tgcloner_clone_work
  set status = 'failed',
      last_error_code = coalesce(last_error_code, 'max_attempts_exhausted'),
      last_error = coalesce(last_error, 'Maximum work attempts exhausted.'),
      finished_at = coalesce(finished_at, v_now),
      updated_at = v_now
  where status in ('queued','retry_wait')
    and attempt_count >= max_attempts;

  return query
  with candidates as (
    select w.id
    from public.tgcloner_clone_work w
    join public.tgcloner_clone_runs r on r.id = w.run_id
    where r.status = 'active'
      and w.status in ('queued','retry_wait')
      and w.attempt_count < w.max_attempts
      and (w.next_attempt_at is null or w.next_attempt_at <= v_now)
    order by w.created_at, w.id
    for update of w skip locked
    limit p_limit
  )
  update public.tgcloner_clone_work w
  set status = 'leased',
      attempt_count = w.attempt_count + 1,
      next_attempt_at = null,
      lease_owner = v_worker,
      lease_generation = w.lease_generation + 1,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      started_at = coalesce(w.started_at, v_now),
      updated_at = v_now
  from candidates c
  where w.id = c.id
  returning w.*;
end;
$$;

create or replace function public.tgcloner_distributor_arm_work(
  p_work_id uuid,
  p_worker_id text,
  p_lease_generation bigint
)
returns public.tgcloner_clone_work
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean := false;
  v_work public.tgcloner_clone_work;
  v_now timestamptz := clock_timestamp();
begin
  select coalesce(distributor_v2_enabled, false)
    into v_enabled
  from public.tgcloner_settings
  where singleton = true;
  if not coalesce(v_enabled, false) then
    raise exception 'distributor_v2_disabled';
  end if;

  update public.tgcloner_clone_work
  set side_effect_state = 'armed',
      side_effect_started_at = coalesce(side_effect_started_at, v_now),
      updated_at = v_now
  where id = p_work_id
    and status = 'leased'
    and lease_owner = btrim(coalesce(p_worker_id, ''))
    and lease_generation = p_lease_generation
    and lease_expires_at > v_now
    and side_effect_state in ('not_started','armed')
  returning * into v_work;

  if not found then
    raise exception 'distributor_work_lease_fenced';
  end if;
  return v_work;
end;
$$;

create or replace function public.tgcloner_distributor_finish_work(
  p_work_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_outcome text,
  p_retryable boolean,
  p_retry_after_seconds integer,
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
  v_retry_seconds integer := least(3600, greatest(5, coalesce(p_retry_after_seconds, 30)));
begin
  select * into v_work
  from public.tgcloner_clone_work
  where id = p_work_id
  for update;
  if not found then
    raise exception 'distributor_work_not_found';
  end if;
  if v_work.status <> 'leased'
     or v_work.lease_owner is distinct from btrim(coalesce(p_worker_id, ''))
     or v_work.lease_generation is distinct from p_lease_generation
     or v_work.lease_expires_at is null
     or v_work.lease_expires_at <= v_now then
    raise exception 'distributor_work_lease_fenced';
  end if;
  if p_outcome not in ('success','known_failure','ambiguous') then
    raise exception 'distributor_work_outcome_invalid';
  end if;

  if p_outcome = 'success' then
    if v_work.phase in ('copy','rewrite','pin','catchup')
       and v_work.side_effect_state <> 'armed' then
      raise exception 'distributor_side_effect_not_armed';
    end if;

    update public.tgcloner_clone_work
    set status = 'done',
        side_effect_state = case
          when side_effect_state = 'armed' then 'confirmed'
          else 'not_applicable'
        end,
        result = coalesce(p_result, '{}'::jsonb),
        last_error_code = null,
        last_error = null,
        lease_owner = null,
        lease_expires_at = null,
        next_attempt_at = null,
        finished_at = v_now,
        updated_at = v_now
    where id = p_work_id
    returning * into v_work;
    return v_work;
  end if;

  if p_outcome = 'ambiguous' then
    update public.tgcloner_clone_work
    set status = 'blocked_ambiguous',
        side_effect_state = 'ambiguous',
        result = coalesce(p_result, result),
        last_error_code = coalesce(nullif(btrim(coalesce(p_error_code, '')), ''), 'ambiguous_external_result'),
        last_error = left(coalesce(p_error, 'External side effect result is ambiguous; reconciliation required.'), 2000),
        lease_owner = null,
        lease_expires_at = null,
        next_attempt_at = null,
        updated_at = v_now
    where id = p_work_id
    returning * into v_work;
    return v_work;
  end if;

  if coalesce(p_retryable, false) and v_work.attempt_count < v_work.max_attempts then
    update public.tgcloner_clone_work
    set status = 'retry_wait',
        side_effect_state = 'not_started',
        side_effect_started_at = null,
        last_error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
        last_error = left(coalesce(p_error, 'Known external failure.'), 2000),
        lease_owner = null,
        lease_expires_at = null,
        next_attempt_at = v_now + make_interval(secs => v_retry_seconds),
        updated_at = v_now
    where id = p_work_id
    returning * into v_work;
  else
    update public.tgcloner_clone_work
    set status = 'failed',
        side_effect_state = 'not_started',
        side_effect_started_at = null,
        last_error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
        last_error = left(coalesce(p_error, 'Known external failure.'), 2000),
        lease_owner = null,
        lease_expires_at = null,
        next_attempt_at = null,
        finished_at = v_now,
        updated_at = v_now
    where id = p_work_id
    returning * into v_work;
  end if;

  return v_work;
end;
$$;

revoke all on function public.tgcloner_distributor_create_run(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_close_manifest(uuid,bigint,bigint[]) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_record_event(text,uuid,bigint,text,text,bigint,text,jsonb,timestamptz) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_claim_work(text,integer,integer) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_arm_work(uuid,text,bigint) from public, anon, authenticated;
revoke all on function public.tgcloner_distributor_finish_work(uuid,text,bigint,text,boolean,integer,text,text,jsonb) from public, anon, authenticated;

grant execute on function public.tgcloner_distributor_create_run(uuid,uuid,text) to service_role;
grant execute on function public.tgcloner_distributor_close_manifest(uuid,bigint,bigint[]) to service_role;
grant execute on function public.tgcloner_distributor_record_event(text,uuid,bigint,text,text,bigint,text,jsonb,timestamptz) to service_role;
grant execute on function public.tgcloner_distributor_claim_work(text,integer,integer) to service_role;
grant execute on function public.tgcloner_distributor_arm_work(uuid,text,bigint) to service_role;
grant execute on function public.tgcloner_distributor_finish_work(uuid,text,bigint,text,boolean,integer,text,text,jsonb) to service_role;
