\set ON_ERROR_STOP on

-- Roles that exist in Supabase but not in a stock PostgreSQL CI service.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create role anon nologin';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'create role authenticated nologin';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'create role service_role nologin';
  end if;
end
$$;

\ir ../sql/002_shared_supabase_tgcloner_schema.sql

-- Minimal scheduler settings fixture; production owns this table through 002_shared_scheduler.sql.
create table if not exists public.tgcloner_settings (
  singleton boolean primary key default true check (singleton),
  scheduler_enabled boolean not null default false,
  scheduler_base_url text,
  updated_at timestamptz not null default now()
);
insert into public.tgcloner_settings(singleton, scheduler_enabled)
values (true, false)
on conflict (singleton) do nothing;
alter table public.tgcloner_settings enable row level security;

\ir ../sql/010_distributor_v2_durable_foundation.sql

create or replace function pg_temp.assert_true(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'integration assertion failed: %', p_message;
  end if;
end
$$;

create or replace function pg_temp.expect_stale_finish_fenced(p_work_id uuid, p_generation bigint)
returns void
language plpgsql
as $$
begin
  begin
    perform public.tgcloner_distributor_finish_work(
      p_work_id,
      'worker-one',
      p_generation,
      'known_failure', false, 30, 'old_worker', 'stale worker', '{}'::jsonb
    );
    raise exception 'integration: expected stale generation fencing';
  exception
    when others then
      if sqlerrm not like '%distributor_work_lease_fenced%' then raise; end if;
  end;
end
$$;

-- PR1 must ship disabled and keep all new tables behind RLS / server-only privileges.
do $$
declare
  v_bad integer;
begin
  if (select distributor_v2_enabled from public.tgcloner_settings where singleton) then
    raise exception 'integration: distributor_v2 must default false';
  end if;

  select count(*) into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any(array[
      'tgcloner_clone_runs','tgcloner_clone_manifest','tgcloner_source_events','tgcloner_clone_work'
    ])
    and not c.relrowsecurity;
  if v_bad <> 0 then
    raise exception 'integration: missing RLS on % distributor tables', v_bad;
  end if;

  if has_table_privilege('anon', 'public.tgcloner_clone_runs', 'select')
     or has_table_privilege('authenticated', 'public.tgcloner_clone_runs', 'select') then
    raise exception 'integration: public client table grant leaked';
  end if;

  if has_function_privilege(
       'anon',
       'public.tgcloner_distributor_create_run(uuid,uuid,text)',
       'execute'
     ) then
    raise exception 'integration: anon can execute distributor RPC';
  end if;
  if not has_function_privilege(
       'service_role',
       'public.tgcloner_distributor_create_run(uuid,uuid,text)',
       'execute'
     ) then
    raise exception 'integration: service_role cannot execute distributor RPC';
  end if;
end
$$;

insert into public.tgcloner_sources(chat_id, title, active)
values
  ('-1000000000001', 'Source A', false),
  ('-1000000000002', 'Source B', false);

select id::text as source_a from public.tgcloner_sources where chat_id = '-1000000000001' \gset
select id::text as source_b from public.tgcloner_sources where chat_id = '-1000000000002' \gset

-- Destination ownership is mandatory and new destinations default inactive.
insert into public.tgcloner_destinations(source_id, chat_id, title)
values (:'source_a'::uuid, '-1000000000101', 'Destination A');
insert into public.tgcloner_destinations(source_id, chat_id, title)
values (:'source_b'::uuid, '-1000000000201', 'Destination B');

select id::text as dest_a from public.tgcloner_destinations where chat_id = '-1000000000101' \gset
select id::text as dest_b from public.tgcloner_destinations where chat_id = '-1000000000201' \gset

do $$
begin
  if (select active from public.tgcloner_destinations where chat_id = '-1000000000101') then
    raise exception 'integration: destination must default inactive';
  end if;

  begin
    insert into public.tgcloner_destinations(chat_id, title)
    values ('-1000000000999', 'Invalid unbound destination');
    raise exception 'integration: expected destination source_id NOT NULL failure';
  exception
    when not_null_violation then null;
  end;
end
$$;

-- Feature flag blocks accidental production use.
do $$
begin
  begin
    perform public.tgcloner_distributor_create_run(
      (select id from public.tgcloner_sources where chat_id = '-1000000000001'),
      (select id from public.tgcloner_destinations where chat_id = '-1000000000101'),
      'initial_backfill'
    );
    raise exception 'integration: expected distributor_v2_disabled';
  exception
    when others then
      if sqlerrm not like '%distributor_v2_disabled%' then raise; end if;
  end;
end
$$;

update public.tgcloner_settings
set distributor_v2_enabled = true, updated_at = now()
where singleton = true;

-- Cross-source binding must fail closed.
do $$
begin
  begin
    perform public.tgcloner_distributor_create_run(
      (select id from public.tgcloner_sources where chat_id = '-1000000000001'),
      (select id from public.tgcloner_destinations where chat_id = '-1000000000201'),
      'initial_backfill'
    );
    raise exception 'integration: expected destination/source mismatch';
  exception
    when others then
      if sqlerrm not like '%distributor_destination_source_mismatch%' then raise; end if;
  end;
end
$$;

-- 1,500 rows prove manifest closure is not dependent on PostgREST page limits.
insert into public.tgcloner_source_messages(
  source_id, source_message_id, message_type, text, source_date
)
select
  :'source_a'::uuid,
  g::bigint,
  'text',
  'message ' || g::text,
  now() - make_interval(secs => 1500 - g)
from generate_series(1, 1500) as g;

-- Three manifest messages form one album copy operation.
update public.tgcloner_source_messages
set media_group_id = 'album-ci-10-12'
where source_id = :'source_a'::uuid and source_message_id between 10 and 12;

select (
  public.tgcloner_distributor_create_run(:'source_a'::uuid, :'dest_a'::uuid, 'initial_backfill')
).id::text as run_a \gset

-- A second non-terminal run for the same destination is rejected.
do $$
begin
  begin
    perform public.tgcloner_distributor_create_run(
      (select id from public.tgcloner_sources where chat_id = '-1000000000001'),
      (select id from public.tgcloner_destinations where chat_id = '-1000000000101'),
      'resync'
    );
    raise exception 'integration: expected duplicate run rejection';
  exception
    when others then
      if sqlerrm not like '%distributor_run_already_active%' then raise; end if;
  end;
end
$$;

select (
  public.tgcloner_distributor_close_manifest(
    :'run_a'::uuid,
    1500,
    (select array_agg(g::bigint order by g) from generate_series(1,1500) as g)
  )
).id;

select pg_temp.assert_true(
  (select count(*) from public.tgcloner_clone_manifest where run_id = :'run_a'::uuid) = 1500,
  'manifest did not capture all 1500 rows'
);
select pg_temp.assert_true(
  (select count(*) from public.tgcloner_clone_work where run_id = :'run_a'::uuid and phase = 'copy') = 1498,
  'copy work denominator mismatch'
);
select pg_temp.assert_true(
  (select cardinality(manifest_message_ids) from public.tgcloner_clone_work
   where run_id = :'run_a'::uuid and work_key = 'copy:album:album-ci-10-12') = 3,
  'album members were not grouped into one copy unit'
);

-- Source reconciliation/deletion cannot shrink the immutable run manifest.
delete from public.tgcloner_source_messages
where source_id = :'source_a'::uuid and source_message_id = 100;

select (
  public.tgcloner_distributor_close_manifest(
    :'run_a'::uuid,
    1500,
    (select array_agg(g::bigint order by g) from generate_series(1,1500) as g)
  )
).id;

select pg_temp.assert_true(
  (select count(*) from public.tgcloner_clone_manifest where run_id = :'run_a'::uuid) = 1500,
  'closed manifest shrank after source deletion'
);

-- Event ledger dedupes both exact event_key replay and same Bot update_id replay.
select (public.tgcloner_distributor_record_event(
  'bot:42', :'source_a'::uuid, 42, 'bot_webhook', 'message_new', 1501,
  'fp-1501', '{"kind":"new"}'::jsonb, now()
)).id;
select (public.tgcloner_distributor_record_event(
  'bot:42-retry', :'source_a'::uuid, 42, 'bot_webhook', 'message_new', 1501,
  'fp-1501', '{"kind":"retry"}'::jsonb, now()
)).id;

do $$
begin
  if (select count(*) from public.tgcloner_source_events where telegram_update_id = 42) <> 1 then
    raise exception 'integration: duplicate Bot update was persisted';
  end if;
end
$$;

-- Pause the large run so lease/fencing tests operate on isolated one-work runs.
update public.tgcloner_clone_runs set status = 'paused' where id = :'run_a'::uuid;

-- Safe stale lease recovery + generation fencing.
insert into public.tgcloner_destinations(source_id, chat_id, title)
values (:'source_a'::uuid, '-1000000000102', 'Lease Destination');
select id::text as dest_lease from public.tgcloner_destinations where chat_id = '-1000000000102' \gset
select (public.tgcloner_distributor_create_run(:'source_a'::uuid, :'dest_lease'::uuid, 'initial_backfill')).id::text as run_lease \gset
select (public.tgcloner_distributor_close_manifest(:'run_lease'::uuid, 1, array[1::bigint])).id;

select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('worker-one', 1, 30)
\gset lease_one_

update public.tgcloner_clone_work
set lease_expires_at = now() - interval '1 second'
where id = :'lease_one_id'::uuid;

select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('worker-two', 1, 30)
\gset lease_two_

select pg_temp.assert_true(
  :'lease_one_id' = :'lease_two_id',
  'stale safe work was not reclaimed as the same work item'
);
select pg_temp.assert_true(
  :'lease_two_generation'::bigint > :'lease_one_generation'::bigint,
  'lease generation did not advance'
);
select pg_temp.expect_stale_finish_fenced(:'lease_one_id'::uuid, :'lease_one_generation'::bigint);

select (public.tgcloner_distributor_arm_work(
  :'lease_two_id'::uuid,
  'worker-two',
  :'lease_two_generation'::bigint
)).id;
select (public.tgcloner_distributor_finish_work(
  :'lease_two_id'::uuid,
  'worker-two',
  :'lease_two_generation'::bigint,
  'success', false, 30, null, null, '{"ok":true}'::jsonb
)).id;

-- Expiry after side effect is armed must quarantine, never blind retry.
insert into public.tgcloner_destinations(source_id, chat_id, title)
values (:'source_a'::uuid, '-1000000000103', 'Ambiguous Destination');
select id::text as dest_amb from public.tgcloner_destinations where chat_id = '-1000000000103' \gset
select (public.tgcloner_distributor_create_run(:'source_a'::uuid, :'dest_amb'::uuid, 'initial_backfill')).id::text as run_amb \gset
select (public.tgcloner_distributor_close_manifest(:'run_amb'::uuid, 2, array[2::bigint])).id;
select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('worker-amb', 1, 30)
\gset amb_
select (public.tgcloner_distributor_arm_work(:'amb_id'::uuid, 'worker-amb', :'amb_generation'::bigint)).id;
update public.tgcloner_clone_work
set lease_expires_at = now() - interval '1 second'
where id = :'amb_id'::uuid;

-- Trigger stale recovery. There must be no claimable replacement for the ambiguous work.
select count(*)::text as count
from public.tgcloner_distributor_claim_work('worker-after-amb', 10, 30)
\gset after_amb_

select pg_temp.assert_true(:'after_amb_count'::integer = 0, 'ambiguous stale work was re-claimed');
select pg_temp.assert_true(
  (select status from public.tgcloner_clone_work where id = :'amb_id'::uuid) = 'blocked_ambiguous',
  'ambiguous stale work was not quarantined'
);
select pg_temp.assert_true(
  (select side_effect_state from public.tgcloner_clone_work where id = :'amb_id'::uuid) = 'ambiguous',
  'ambiguous side-effect state missing'
);

-- Paused run cannot be claimed.
insert into public.tgcloner_destinations(source_id, chat_id, title)
values (:'source_a'::uuid, '-1000000000104', 'Paused Destination');
select id::text as dest_pause from public.tgcloner_destinations where chat_id = '-1000000000104' \gset
select (public.tgcloner_distributor_create_run(:'source_a'::uuid, :'dest_pause'::uuid, 'initial_backfill')).id::text as run_pause \gset
select (public.tgcloner_distributor_close_manifest(:'run_pause'::uuid, 3, array[3::bigint])).id;
update public.tgcloner_clone_runs set status = 'paused' where id = :'run_pause'::uuid;

select count(*)::text as count
from public.tgcloner_distributor_claim_work('worker-paused', 10, 30)
\gset paused_

select pg_temp.assert_true(:'paused_count'::integer = 0, 'work from paused run was claimed');

-- Canonical mapping cannot point two source messages to one destination message.
insert into public.tgcloner_message_mappings(
  source_id, source_message_id, destination_id, destination_message_id, status
) values (:'source_a'::uuid, 1, :'dest_a'::uuid, 9001, 'copied');
do $$
begin
  begin
    insert into public.tgcloner_message_mappings(
      source_id, source_message_id, destination_id, destination_message_id, status
    ) values (
      (select id from public.tgcloner_sources where chat_id = '-1000000000001'),
      2,
      (select id from public.tgcloner_destinations where chat_id = '-1000000000101'),
      9001,
      'copied'
    );
    raise exception 'integration: expected destination message mapping uniqueness failure';
  exception
    when unique_violation then null;
  end;
end
$$;

-- Kill switch prevents new claims even if queued work exists.
update public.tgcloner_settings
set distributor_v2_enabled = false, updated_at = now()
where singleton = true;
select count(*)::text as count
from public.tgcloner_distributor_claim_work('worker-disabled', 10, 30)
\gset disabled_

select pg_temp.assert_true(:'disabled_count'::integer = 0, 'kill switch did not stop claims');

select 'DISTRIBUTOR_FOUNDATION_DB_TEST_PASS' as result;
