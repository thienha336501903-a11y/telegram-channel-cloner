\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then execute 'create role anon nologin'; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'create role authenticated nologin'; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then execute 'create role service_role nologin'; end if;
end
$$;

\ir ../sql/002_shared_supabase_tgcloner_schema.sql

create table if not exists public.tgcloner_settings (
  singleton boolean primary key default true check (singleton),
  scheduler_enabled boolean not null default false,
  scheduler_base_url text,
  updated_at timestamptz not null default now()
);
insert into public.tgcloner_settings(singleton, scheduler_enabled)
values (true, false) on conflict (singleton) do nothing;
alter table public.tgcloner_settings enable row level security;

\ir ../sql/010_distributor_v2_durable_foundation.sql
\ir ../sql/011_distributor_v2_safe_copy_catchup.sql
\ir ../sql/012_distributor_v2_copy_fingerprint_album_guard.sql

create or replace function pg_temp.assert_true(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'integration assertion failed: %', p_message; end if;
end
$$;

insert into public.tgcloner_sources(chat_id, title, private_link_id, active)
values ('-100111', 'Source Fidelity', '111', false);
select id::text as source_a from public.tgcloner_sources where chat_id = '-100111' \gset

insert into public.tgcloner_destinations(source_id, chat_id, title)
values (:'source_a'::uuid, '-100222', 'Destination Fidelity');
select id::text as dest_a from public.tgcloner_destinations where chat_id = '-100222' \gset

-- Message 2 uses a hidden MessageEntityTextUrl but starts with the legacy flag false.
insert into public.tgcloner_source_messages(
  source_id, source_message_id, message_type, text, text_entities,
  caption_entities, has_internal_links, source_date
) values
  (:'source_a'::uuid, 1, 'text', 'Lesson 1', '[]'::jsonb, '[]'::jsonb, false, now()),
  (:'source_a'::uuid, 2, 'text', 'Bài 1',
    '[{"type":"text_link","offset":0,"length":5,"url":"https://t.me/c/111/1"}]'::jsonb,
    '[]'::jsonb, false, now());

\ir ../sql/013_distributor_v2_fidelity_verification.sql
\ir ../sql/014_distributor_v2_final_verify_guards.sql

select pg_temp.assert_true(
  (select has_internal_links from public.tgcloner_source_messages where source_id = :'source_a'::uuid and source_message_id = 2),
  'hidden text_link was not backfilled as internal'
);

update public.tgcloner_settings set distributor_v2_enabled = true, updated_at = now() where singleton = true;

select (public.tgcloner_distributor_create_run(:'source_a'::uuid, :'dest_a'::uuid, 'initial_backfill')).id::text as run_a \gset
select (public.tgcloner_distributor_close_manifest(:'run_a'::uuid, 2, array[1::bigint,2::bigint])).id;

-- Complete the two ordered copy operations through the real fenced RPCs.
select id::text as id, lease_generation::text as generation, source_message_id::text as source_id
from public.tgcloner_distributor_claim_work('copy-worker', 1, 60) \gset copy_one_
select (public.tgcloner_distributor_arm_work(:'copy_one_id'::uuid, 'copy-worker', :'copy_one_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_copy(
  :'copy_one_id'::uuid, 'copy-worker', :'copy_one_generation'::bigint,
  array[1001::bigint], '{"db_test":true}'::jsonb
)).id;

select id::text as id, lease_generation::text as generation, source_message_id::text as source_id
from public.tgcloner_distributor_claim_work('copy-worker', 1, 60) \gset copy_two_
select (public.tgcloner_distributor_arm_work(:'copy_two_id'::uuid, 'copy-worker', :'copy_two_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_copy(
  :'copy_two_id'::uuid, 'copy-worker', :'copy_two_generation'::bigint,
  array[1002::bigint], '{"db_test":true}'::jsonb
)).id;

-- PR2 catch-up is already separately tested; move this isolated fixture to the
-- fidelity phase after proving copy mappings are complete.
update public.tgcloner_clone_runs
set phase = 'rewriting', catchup_high_watermark = 2, catchup_barrier_event_id = 0, updated_at = now()
where id = :'run_a'::uuid;

select (public.tgcloner_distributor_prepare_fidelity(:'run_a'::uuid, 1)).id;
select pg_temp.assert_true(
  (select count(*) from public.tgcloner_clone_work where run_id = :'run_a'::uuid and phase = 'rewrite') = 1,
  'expected one hidden-link rewrite work item'
);
select pg_temp.assert_true(
  (select desired_pin_destination_message_id from public.tgcloner_clone_runs where id = :'run_a'::uuid) = 1001,
  'pin mapping did not resolve to destination message'
);

select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('rewrite-worker', 1, 60) \gset rewrite_
select pg_temp.assert_true(
  (select operation_kind from public.tgcloner_clone_work where id = :'rewrite_id'::uuid) = 'rewrite',
  'rewrite work was not claimed before pin'
);
select (public.tgcloner_distributor_arm_work(:'rewrite_id'::uuid, 'rewrite-worker', :'rewrite_generation'::bigint)).id;

do $$
begin
  begin
    perform public.tgcloner_distributor_finish_rewrite(
      :'rewrite_id'::uuid, 'rewrite-worker', :'rewrite_generation'::bigint,
      '{"actual_verified":false}'::jsonb
    );
    raise exception 'integration: expected actual verification requirement';
  exception when others then
    if sqlerrm not like '%distributor_rewrite_actual_verification_required%' then raise; end if;
  end;
end
$$;

select (public.tgcloner_distributor_finish_rewrite(
  :'rewrite_id'::uuid, 'rewrite-worker', :'rewrite_generation'::bigint,
  '{"actual_verified":true,"rewritten_links":1}'::jsonb
)).id;

select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('pin-worker', 1, 60) \gset pin_
select pg_temp.assert_true(
  (select operation_kind from public.tgcloner_clone_work where id = :'pin_id'::uuid) = 'pin_set',
  'pin work was not claimed after rewrite'
);
select (public.tgcloner_distributor_arm_work(:'pin_id'::uuid, 'pin-worker', :'pin_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_pin(
  :'pin_id'::uuid, 'pin-worker', :'pin_generation'::bigint,
  '{"destination_message_id":1001}'::jsonb
)).id;

select (public.tgcloner_distributor_prepare_verification(:'run_a'::uuid)).id;
select pg_temp.assert_true(
  (select phase from public.tgcloner_clone_runs where id = :'run_a'::uuid) = 'verifying',
  'run did not enter verifying'
);

select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('verify-worker', 1, 60) \gset verify_

do $$
begin
  begin
    perform public.tgcloner_distributor_finish_verify(
      :'verify_id'::uuid, 'verify-worker', :'verify_generation'::bigint,
      9999, '{"test":"bad_pin"}'::jsonb
    );
    raise exception 'integration: expected destination pin mismatch';
  exception when others then
    if sqlerrm not like '%distributor_verify_pin_mismatch%' then raise; end if;
  end;
end
$$;

-- Same-message content drift does not change the high watermark. The READY
-- trigger must still refuse it based on mapping fingerprint evidence.
update public.tgcloner_source_messages
set text = 'Lesson 1 edited after verification started', updated_at = now()
where source_id = :'source_a'::uuid and source_message_id = 1;

do $$
begin
  begin
    perform public.tgcloner_distributor_finish_verify(
      :'verify_id'::uuid, 'verify-worker', :'verify_generation'::bigint,
      1001, '{"test":"fingerprint_drift"}'::jsonb
    );
    raise exception 'integration: expected source fingerprint drift rejection';
  exception when others then
    if sqlerrm not like '%distributor_verify_source_fingerprint_drift%' then raise; end if;
  end;
end
$$;

update public.tgcloner_source_messages
set text = 'Lesson 1', updated_at = now()
where source_id = :'source_a'::uuid and source_message_id = 1;

select (public.tgcloner_distributor_finish_verify(
  :'verify_id'::uuid, 'verify-worker', :'verify_generation'::bigint,
  1001, '{"test":"ready"}'::jsonb
)).id;

select pg_temp.assert_true(
  (select phase from public.tgcloner_clone_runs where id = :'run_a'::uuid) = 'ready_for_new',
  'clean destination did not reach READY_FOR_NEW'
);
select pg_temp.assert_true(
  (select ready_at is not null and last_verified_at is not null from public.tgcloner_clone_runs where id = :'run_a'::uuid),
  'READY_FOR_NEW timestamps missing'
);
select pg_temp.assert_true(
  (select count(*) from public.tgcloner_message_mappings where source_id = :'source_a'::uuid and destination_id = :'dest_a'::uuid and verified_at is not null) = 2,
  'verified mapping evidence incomplete'
);

select 'DISTRIBUTOR_FIDELITY_DB_TEST_PASS' as result;
