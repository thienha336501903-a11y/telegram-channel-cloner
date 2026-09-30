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

create or replace function pg_temp.expect_rewrite_actual_verification(p_work_id uuid, p_generation bigint)
returns void language plpgsql as $$
begin
  begin
    perform public.tgcloner_distributor_finish_rewrite(
      p_work_id, 'rewrite-worker', p_generation, '{"actual_verified":false}'::jsonb
    );
    raise exception 'integration: expected actual verification requirement';
  exception when others then
    if sqlerrm not like '%distributor_rewrite_actual_verification_required%' then raise; end if;
  end;
end
$$;

create or replace function pg_temp.expect_verify_error(
  p_work_id uuid,
  p_generation bigint,
  p_pin bigint,
  p_summary jsonb,
  p_expected text
)
returns void language plpgsql as $$
begin
  begin
    perform public.tgcloner_distributor_finish_verify(
      p_work_id, 'verify-worker', p_generation, p_pin, p_summary
    );
    raise exception 'integration: expected verify failure %', p_expected;
  exception when others then
    if sqlerrm not like ('%' || p_expected || '%') then raise; end if;
  end;
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
\ir ../sql/015_distributor_v2_text_link_backfill_portable.sql

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

select pg_temp.expect_rewrite_actual_verification(:'rewrite_id'::uuid, :'rewrite_generation'::bigint);

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

select pg_temp.expect_verify_error(
  :'verify_id'::uuid, :'verify_generation'::bigint, 9999,
  '{"test":"bad_pin"}'::jsonb, 'distributor_verify_pin_mismatch'
);

-- Same-message content drift does not change the high watermark. The READY
-- trigger must still refuse it based on mapping fingerprint evidence.
update public.tgcloner_source_messages
set text = 'Lesson 1 edited after verification started', updated_at = now()
where source_id = :'source_a'::uuid and source_message_id = 1;

select pg_temp.expect_verify_error(
  :'verify_id'::uuid, :'verify_generation'::bigint, 1001,
  '{"test":"fingerprint_drift"}'::jsonb, 'distributor_verify_source_fingerprint_drift'
);

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

\ir ../sql/016_distributor_v2_progress_center.sql

select pg_temp.assert_true(
  (select (r->>'completed_units')::integer = (r->>'known_units')::integer
    and (r->>'verified_messages')::integer = (r->>'manifest_messages')::integer
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'runs') r
   where r->>'id' = :'run_a')
  and (select (c->>'verified_destinations')::integer = 1
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'courses') c
   where c->>'source_id' = :'source_a'),
  'READY run must have a fully verified ledger'
);
update public.tgcloner_message_mappings set verified_at = null
where source_id = :'source_a'::uuid and destination_id = :'dest_a'::uuid and source_message_id = 1;
select pg_temp.assert_true(
  (select (c->>'verified_destinations')::integer = 0
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'courses') c
   where c->>'source_id' = :'source_a'),
  'a missing verified mapping must revoke 100%'
);
update public.tgcloner_message_mappings set verified_at = now()
where source_id = :'source_a'::uuid and destination_id = :'dest_a'::uuid and source_message_id = 1;

insert into public.tgcloner_destinations(source_id, chat_id, title)
values (:'source_a'::uuid, '-100223', 'Destination still scanning');
select id::text as dest_b from public.tgcloner_destinations where chat_id = '-100223' \gset
select (public.tgcloner_distributor_create_run(:'source_a'::uuid, :'dest_b'::uuid, 'initial_backfill')).id::text as run_b \gset
select pg_temp.assert_true(
  (select (c->>'open_manifests')::integer = 1 and (c->>'destinations')::integer = 2
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'courses') c
   where c->>'source_id' = :'source_a'),
  'open manifest must keep the source rollup indeterminate'
);
select (public.tgcloner_distributor_close_manifest(:'run_b'::uuid, 2, array[1::bigint,2::bigint])).id;
select pg_temp.assert_true(
  (select (r->>'known_units')::integer = 3 and (r->>'completed_units')::integer = 0
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'runs') r
   where r->>'id' = :'run_b'),
  'closed manifest must count two copy units plus the reserved verification unit'
);

update public.tgcloner_clone_work
set status = 'retry_wait', attempt_count = 1, next_attempt_at = now() + interval '5 minutes'
where run_id = :'run_b'::uuid and phase = 'copy' and source_message_id = 1;
select pg_temp.assert_true(
  (select (r->>'retry_items')::integer = 1 and (r->>'completed_units')::integer = 0
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'runs') r
   where r->>'id' = :'run_b'),
  'retry must not inflate completed work'
);
update public.tgcloner_clone_work
set status = 'blocked_ambiguous', next_attempt_at = null, side_effect_state = 'ambiguous'
where run_id = :'run_b'::uuid and phase = 'copy' and source_message_id = 1;

insert into public.tgcloner_source_messages(source_id, source_message_id, message_type, text)
values (:'source_a'::uuid, 3, 'text', 'Late lesson');
insert into public.tgcloner_source_events(event_key, source_id, origin, event_kind, source_message_id)
values ('progress-test:late-lesson', :'source_a'::uuid, 'admin', 'message_new', 3);
select pg_temp.assert_true(
  (select (r->>'blocked_items')::integer = 1 and (r->>'lag_events')::integer = 1
    and (r->>'lag_messages')::integer = 1
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'runs') r
   where r->>'id' = :'run_b'),
  'block and actual catch-up lag must be visible for the destination'
);
select pg_temp.assert_true(
  (select (c->>'verified_destinations')::integer = 0
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'courses') c
   where c->>'source_id' = :'source_a'),
  'new source activity must remove stale 100% from an earlier READY run'
);

insert into public.tgcloner_sources(chat_id, title, active)
values ('-100333', 'Album source', false);
select id::text as source_b from public.tgcloner_sources where chat_id = '-100333' \gset
insert into public.tgcloner_destinations(source_id, chat_id, title)
values (:'source_b'::uuid, '-100444', 'Album destination');
select id::text as dest_c from public.tgcloner_destinations where chat_id = '-100444' \gset
insert into public.tgcloner_source_messages(source_id, source_message_id, media_group_id, message_type)
values (:'source_b'::uuid, 11, 'album-1', 'photo'), (:'source_b'::uuid, 12, 'album-1', 'photo');
select (public.tgcloner_distributor_create_run(:'source_b'::uuid, :'dest_c'::uuid, 'initial_backfill')).id::text as run_c \gset
select (public.tgcloner_distributor_close_manifest(:'run_c'::uuid, 12, array[11::bigint,12::bigint])).id;
select pg_temp.assert_true(
  (select (r->>'manifest_messages')::integer = 2 and (r->>'manifest_copy_units')::integer = 1
    and (r->>'album_members')::integer = 2 and (r->>'albums')::integer = 1
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'runs') r
   where r->>'id' = :'run_c'),
  'album must count as one copy unit while preserving two member messages'
);

select 'DISTRIBUTOR_FIDELITY_DB_TEST_PASS' as result;
