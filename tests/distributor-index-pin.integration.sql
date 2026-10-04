\set ON_ERROR_STOP on

-- Fresh CI-only database. The destination index is an already verified fake
-- Telegram message; this test makes no Bot API, Supabase or Production call.
create database tgcloner_index_pin_pilot;
\connect tgcloner_index_pin_pilot

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then execute 'create role anon nologin'; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'create role authenticated nologin'; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then execute 'create role service_role nologin'; end if;
end
$$;

\ir ../sql/002_shared_supabase_tgcloner_schema.sql
create table public.tgcloner_settings (
  singleton boolean primary key default true check (singleton),
  scheduler_enabled boolean not null default false,
  scheduler_base_url text,
  updated_at timestamptz not null default now()
);
insert into public.tgcloner_settings(singleton, scheduler_enabled) values (true, false);
alter table public.tgcloner_settings enable row level security;

\ir ../sql/010_distributor_v2_durable_foundation.sql
\ir ../sql/011_distributor_v2_safe_copy_catchup.sql
\ir ../sql/012_distributor_v2_copy_fingerprint_album_guard.sql
\ir ../sql/013_distributor_v2_fidelity_verification.sql
\ir ../sql/014_distributor_v2_final_verify_guards.sql
\ir ../sql/015_distributor_v2_text_link_backfill_portable.sql
\ir ../sql/016_distributor_v2_progress_center.sql
\ir ../sql/017_distributor_v2_destination_course_index_pin.sql

create or replace function pg_temp.assert_true(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'index pin test failed: %', p_message; end if;
end
$$;

create or replace function pg_temp.expect_error(p_expected text, p_sql text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'expected %', p_expected;
  exception when others then
    if sqlerrm not like ('%' || p_expected || '%') then raise; end if;
  end;
end
$$;

select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.tgcloner_distributor_register_course_index(uuid,bigint,text,bigint)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.tgcloner_distributor_register_course_index(uuid,bigint,text,bigint)', 'EXECUTE'),
  'untrusted roles can register an index'
);

insert into public.tgcloner_sources(chat_id, title, active)
values ('-1009000000300', 'Disposable source', false);
select id::text as source_index from public.tgcloner_sources where chat_id='-1009000000300' \gset
insert into public.tgcloner_destinations(source_id, chat_id, title, active)
values (:'source_index'::uuid, '-1009000000301', 'Disposable destination', false);
select id::text as dest_index from public.tgcloner_destinations where chat_id='-1009000000301' \gset
insert into public.tgcloner_source_messages(source_id, source_message_id, message_type, text, source_date)
values (:'source_index'::uuid, 1, 'text', 'First lesson', now());
update public.tgcloner_settings set distributor_v2_enabled=true where singleton=true;

select (public.tgcloner_distributor_create_run(:'source_index'::uuid, :'dest_index'::uuid, 'initial_backfill')).id::text as run_index \gset
select (public.tgcloner_distributor_close_manifest(:'run_index'::uuid, 1, array[1::bigint])).id;
select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('index-worker', 1, 60) \gset copy_
select (public.tgcloner_distributor_arm_work(:'copy_id'::uuid, 'index-worker', :'copy_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_copy(
  :'copy_id'::uuid, 'index-worker', :'copy_generation'::bigint,
  array[14::bigint], '{"synthetic_bot_result":true}'::jsonb
)).id;

select pg_temp.expect_error('distributor_course_index_source_drift',
  format('select public.tgcloner_distributor_register_course_index(%L::uuid,67,%L,2)', :'run_index', repeat('a',64)));
select pg_temp.expect_error('distributor_course_index_overlaps_copied_post',
  format('select public.tgcloner_distributor_register_course_index(%L::uuid,14,%L,1)', :'run_index', repeat('a',64)));
select (public.tgcloner_distributor_register_course_index(
  :'run_index'::uuid, 67, repeat('a',64), 1
)).course_index_message_id;
select pg_temp.expect_error('distributor_course_index_message_changed',
  format('select public.tgcloner_distributor_register_course_index(%L::uuid,68,%L,1)', :'run_index', repeat('a',64)));

select (public.tgcloner_distributor_prepare_catchup(:'run_index'::uuid, 0, 0)).id;
select (public.tgcloner_distributor_prepare_catchup(:'run_index'::uuid, 0, 0)).id;
select pg_temp.assert_true((select phase='rewriting' from public.tgcloner_clone_runs where id=:'run_index'::uuid),
  'clean indexed run did not reach rewriting');
select pg_temp.expect_error('distributor_course_index_source_pin_conflict',
  format('select public.tgcloner_distributor_prepare_fidelity(%L::uuid,1)', :'run_index'));
select (public.tgcloner_distributor_prepare_fidelity(:'run_index'::uuid, null)).id;
select pg_temp.assert_true(
  (select desired_pin_destination_message_id=67 and desired_pin_source_message_id is null
   from public.tgcloner_clone_runs where id=:'run_index'::uuid)
  and not exists (select 1 from public.tgcloner_clone_work where run_id=:'run_index'::uuid and phase='pin'),
  'destination index was not preserved without pin work'
);

select (public.tgcloner_distributor_prepare_verification(:'run_index'::uuid)).id;
select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('index-verifier', 1, 60) \gset verify_
select pg_temp.assert_true((select operation_kind='verify' from public.tgcloner_clone_work where id=:'verify_id'::uuid),
  'indexed run did not claim verification');
select pg_temp.expect_error('distributor_verify_pin_mismatch',
  format('select public.tgcloner_distributor_finish_verify(%L::uuid,%L,%s,68,%L::jsonb)',
    :'verify_id', 'index-verifier', :'verify_generation', '{"test":"wrong_pin"}'));
select (public.tgcloner_distributor_finish_verify(
  :'verify_id'::uuid, 'index-verifier', :'verify_generation'::bigint,
  67, '{"test":"verified_index"}'::jsonb
)).id;
select pg_temp.assert_true(
  (select phase='ready_for_new' and verification_summary->>'actual_pin_destination_message_id'='67'
   from public.tgcloner_clone_runs where id=:'run_index'::uuid),
  'indexed run did not reach READY with the verified destination pin'
);

select 'DISTRIBUTOR_INDEX_PIN_DB_TEST_PASS' as result;
