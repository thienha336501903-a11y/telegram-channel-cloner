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
values (true, false)
on conflict (singleton) do nothing;
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

insert into public.tgcloner_sources(chat_id, title, active)
values ('-1007000000001', 'Distributor PR2 Source', false);
select id::text as source_id from public.tgcloner_sources where chat_id = '-1007000000001' \gset

insert into public.tgcloner_destinations(source_id, chat_id, title)
values (:'source_id'::uuid, '-1007000000101', 'Distributor PR2 Destination');
select id::text as destination_id from public.tgcloner_destinations where chat_id = '-1007000000101' \gset

insert into public.tgcloner_source_messages(
  source_id, source_message_id, message_type, text, text_entities,
  caption_entities, source_date, updated_at
) values
  (:'source_id'::uuid, 1, 'text', 'lesson 1', '[]'::jsonb, '[]'::jsonb, now() - interval '10 minutes', now() - interval '10 minutes'),
  (:'source_id'::uuid, 2, 'text', 'lesson 2', '[]'::jsonb, '[]'::jsonb, now() - interval '9 minutes', now() - interval '9 minutes');

update public.tgcloner_settings set distributor_v2_enabled = true where singleton = true;

select (public.tgcloner_distributor_create_run(
  :'source_id'::uuid, :'destination_id'::uuid, 'initial_backfill'
)).id::text as run_id \gset

select (public.tgcloner_distributor_close_manifest(
  :'run_id'::uuid, 2, array[1::bigint,2::bigint]
)).id;

-- Ordered work: even with limit 10, only the first source operation is claimable.
select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('pr2-worker-1', 10, 60)
\gset first_
select pg_temp.assert_true(
  (select source_message_id from public.tgcloner_clone_work where id = :'first_id'::uuid) = 1,
  'first backfill claim was not source message 1'
);
select pg_temp.assert_true(
  (select count(*) from public.tgcloner_clone_work where run_id = :'run_id'::uuid and status = 'leased') = 1,
  'more than one work item leased for one run'
);

select (public.tgcloner_distributor_arm_work(:'first_id'::uuid, 'pr2-worker-1', :'first_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_copy(
  :'first_id'::uuid, 'pr2-worker-1', :'first_generation'::bigint,
  array[9101::bigint], '{"test":"backfill-1"}'::jsonb
)).id;

select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('pr2-worker-2', 10, 60)
\gset second_
select pg_temp.assert_true(
  (select source_message_id from public.tgcloner_clone_work where id = :'second_id'::uuid) = 2,
  'second backfill claim was not source message 2'
);
select (public.tgcloner_distributor_arm_work(:'second_id'::uuid, 'pr2-worker-2', :'second_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_copy(
  :'second_id'::uuid, 'pr2-worker-2', :'second_generation'::bigint,
  array[9102::bigint], '{"test":"backfill-2"}'::jsonb
)).id;

select pg_temp.assert_true(
  (select count(*) from public.tgcloner_message_mappings
   where destination_id = :'destination_id'::uuid and status = 'copied') = 2,
  'atomic finish_copy did not persist both backfill mappings'
);
select pg_temp.assert_true(
  (select side_effect_state from public.tgcloner_clone_work where id = :'second_id'::uuid) = 'confirmed',
  'finish_copy did not confirm side effect state'
);

-- Move from completed backfill into catch-up.
select (public.tgcloner_distributor_prepare_catchup(:'run_id'::uuid, 0, 0)).id;
select pg_temp.assert_true(
  (select phase from public.tgcloner_clone_runs where id = :'run_id'::uuid) = 'catching_up',
  'run did not enter catching_up after backfill completion'
);

-- A new source message after H is found by gap scan even without relying on event cursor.
insert into public.tgcloner_source_messages(
  source_id, source_message_id, message_type, text, text_entities,
  caption_entities, source_date, updated_at
) values (
  :'source_id'::uuid, 3, 'text', 'lesson 3 original', '[]'::jsonb,
  '[]'::jsonb, now() - interval '2 minutes', now() - interval '2 minutes'
);
select (public.tgcloner_distributor_prepare_catchup(:'run_id'::uuid, 0, 0)).id;

select pg_temp.assert_true(
  (select count(*) from public.tgcloner_clone_work
   where run_id = :'run_id'::uuid and work_key = 'catchup:copy:m:3' and status = 'queued') = 1,
  'gap scan did not enqueue source message 3'
);
select pg_temp.assert_true(
  (select source_fingerprints ? '3' from public.tgcloner_clone_work
   where run_id = :'run_id'::uuid and work_key = 'catchup:copy:m:3'),
  'catch-up copy did not freeze source fingerprint at scheduling time'
);

select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('pr2-worker-3', 10, 60)
\gset third_
select (public.tgcloner_distributor_arm_work(:'third_id'::uuid, 'pr2-worker-3', :'third_generation'::bigint)).id;

-- Simulate an edit racing after Telegram copy started but before DB commit. The
-- mapping must retain the pre-copy expected fingerprint so catch-up sees drift.
update public.tgcloner_source_messages
set text = 'lesson 3 edited during copy', updated_at = clock_timestamp()
where source_id = :'source_id'::uuid and source_message_id = 3;

select (public.tgcloner_distributor_finish_copy(
  :'third_id'::uuid, 'pr2-worker-3', :'third_generation'::bigint,
  array[9103::bigint], '{"test":"catchup-copy-3"}'::jsonb
)).id;

select pg_temp.assert_true(
  (select mm.source_fingerprint = w.source_fingerprints ->> '3'
   from public.tgcloner_message_mappings mm
   join public.tgcloner_clone_work w on w.id = :'third_id'::uuid
   where mm.destination_id = :'destination_id'::uuid and mm.source_message_id = 3),
  'mapping did not retain frozen copy fingerprint'
);

select (public.tgcloner_distributor_prepare_catchup(:'run_id'::uuid, 0, 0)).id;
select pg_temp.assert_true(
  (select count(*) from public.tgcloner_clone_work
   where run_id = :'run_id'::uuid and operation_kind = 'edit'
     and source_message_id = 3 and status = 'queued') = 1,
  'fingerprint drift did not enqueue catch-up edit'
);

select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('pr2-worker-edit', 10, 60)
\gset edit_
select (public.tgcloner_distributor_arm_work(:'edit_id'::uuid, 'pr2-worker-edit', :'edit_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_edit(
  :'edit_id'::uuid, 'pr2-worker-edit', :'edit_generation'::bigint,
  '{"test":"edit-3"}'::jsonb
)).id;
select pg_temp.assert_true(
  (select mm.source_fingerprint = w.source_fingerprint
   from public.tgcloner_message_mappings mm
   join public.tgcloner_clone_work w on w.id = :'edit_id'::uuid
   where mm.destination_id = :'destination_id'::uuid and mm.source_message_id = 3),
  'finish_edit did not advance mapping fingerprint atomically'
);

-- Two clean scans with quiet=0 advance to rewriting.
select (public.tgcloner_distributor_prepare_catchup(:'run_id'::uuid, 0, 0)).id;
select (public.tgcloner_distributor_prepare_catchup(:'run_id'::uuid, 0, 0)).id;
select pg_temp.assert_true(
  (select phase from public.tgcloner_clone_runs where id = :'run_id'::uuid) = 'rewriting',
  'quiescence gate did not advance to rewriting'
);

-- Durable event can invalidate a quiescent phase, but correctness does not rely
-- on this event because the gap/fingerprint scan above is authoritative.
select (public.tgcloner_distributor_record_event(
  'bot:pr2-edit-3', :'source_id'::uuid, 70003, 'bot_webhook', 'message_edit', 3,
  null, '{"test":true}'::jsonb, now()
)).id;
select pg_temp.assert_true(
  (select phase from public.tgcloner_clone_runs where id = :'run_id'::uuid) = 'catching_up',
  'content event did not return run to catching_up'
);

-- Pause/resume is fail-closed and keeps work durable.
select (public.tgcloner_distributor_set_run_control(:'run_id'::uuid, 'pause')).id;
select pg_temp.assert_true(
  (select status from public.tgcloner_clone_runs where id = :'run_id'::uuid) = 'paused',
  'pause did not change run status'
);
select (public.tgcloner_distributor_set_run_control(:'run_id'::uuid, 'resume')).id;
select pg_temp.assert_true(
  (select status from public.tgcloner_clone_runs where id = :'run_id'::uuid) = 'active',
  'resume did not reactivate clean run'
);

-- Ambiguous copy can only continue after explicit reconciliation.
insert into public.tgcloner_source_messages(
  source_id, source_message_id, message_type, text, text_entities,
  caption_entities, source_date, updated_at
) values (
  :'source_id'::uuid, 4, 'text', 'lesson 4', '[]'::jsonb,
  '[]'::jsonb, now() - interval '1 minute', now() - interval '1 minute'
);
select (public.tgcloner_distributor_prepare_catchup(:'run_id'::uuid, 0, 0)).id;
select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('pr2-worker-amb', 10, 60)
\gset amb_
select (public.tgcloner_distributor_arm_work(:'amb_id'::uuid, 'pr2-worker-amb', :'amb_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_work(
  :'amb_id'::uuid, 'pr2-worker-amb', :'amb_generation'::bigint,
  'ambiguous', false, 30, 'transport_lost', 'response lost after request',
  '{"observed":false}'::jsonb
)).id;
select pg_temp.assert_true(
  (select status from public.tgcloner_clone_work where id = :'amb_id'::uuid) = 'blocked_ambiguous',
  'ambiguous copy was not quarantined'
);

-- Operator verifies no Telegram side effect: safe to requeue.
select (public.tgcloner_distributor_resolve_ambiguous_copy(
  :'amb_id'::uuid, 'not_applied', null
)).id;
select pg_temp.assert_true(
  (select status from public.tgcloner_clone_work where id = :'amb_id'::uuid) = 'queued',
  'not_applied reconciliation did not requeue work'
);

select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('pr2-worker-amb2', 10, 60)
\gset amb2_
select (public.tgcloner_distributor_arm_work(:'amb2_id'::uuid, 'pr2-worker-amb2', :'amb2_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_work(
  :'amb2_id'::uuid, 'pr2-worker-amb2', :'amb2_generation'::bigint,
  'ambiguous', false, 30, 'response_lost', 'Telegram result must be reconciled', '{}'::jsonb
)).id;

-- Operator finds the actual destination message: confirm without Telegram retry.
select (public.tgcloner_distributor_resolve_ambiguous_copy(
  :'amb2_id'::uuid, 'confirmed', array[9104::bigint]
)).id;
select pg_temp.assert_true(
  (select destination_message_id from public.tgcloner_message_mappings
   where destination_id = :'destination_id'::uuid and source_message_id = 4) = 9104,
  'confirmed ambiguous copy did not persist reconciled mapping'
);
select pg_temp.assert_true(
  (select status from public.tgcloner_clone_work where id = :'amb2_id'::uuid) = 'done',
  'confirmed ambiguous copy did not finish work'
);

-- Album members that are present together are one atomic catch-up copy operation.
insert into public.tgcloner_source_messages(
  source_id, source_message_id, media_group_id, message_type, caption,
  text_entities, caption_entities, source_date, updated_at
) values
  (:'source_id'::uuid, 5, 'album-pr2', 'photo', 'album 5', '[]'::jsonb, '[]'::jsonb, now() - interval '30 seconds', now() - interval '30 seconds'),
  (:'source_id'::uuid, 6, 'album-pr2', 'photo', 'album 6', '[]'::jsonb, '[]'::jsonb, now() - interval '29 seconds', now() - interval '29 seconds');
select (public.tgcloner_distributor_prepare_catchup(:'run_id'::uuid, 5, 0)).id;
select pg_temp.assert_true(
  (select cardinality(manifest_message_ids) from public.tgcloner_clone_work
   where run_id = :'run_id'::uuid and work_key = 'catchup:copy:album:album-pr2') = 2,
  'stable catch-up album was not grouped atomically'
);
select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('pr2-worker-album', 10, 60)
\gset album_
select (public.tgcloner_distributor_arm_work(:'album_id'::uuid, 'pr2-worker-album', :'album_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_copy(
  :'album_id'::uuid, 'pr2-worker-album', :'album_generation'::bigint,
  array[9105::bigint,9106::bigint], '{"album":true}'::jsonb
)).id;

-- A late third member after any album member was already copied blocks the run;
-- it must never be silently copied as a second/partial album.
insert into public.tgcloner_source_messages(
  source_id, source_message_id, media_group_id, message_type, caption,
  text_entities, caption_entities, source_date, updated_at
) values (
  :'source_id'::uuid, 7, 'album-pr2', 'photo', 'late album 7',
  '[]'::jsonb, '[]'::jsonb, now(), now()
);
select pg_temp.assert_true(
  (select status from public.tgcloner_clone_runs where id = :'run_id'::uuid) = 'blocked',
  'late album member did not block run'
);
select pg_temp.assert_true(
  (select status from public.tgcloner_clone_work
   where run_id = :'run_id'::uuid and work_key = 'catchup:album-drift:album-pr2') = 'blocked_dependency',
  'late album drift did not create explicit blocked dependency'
);
select pg_temp.assert_true(
  not exists (
    select 1 from public.tgcloner_message_mappings
    where destination_id = :'destination_id'::uuid and source_message_id = 7
  ),
  'late album member was copied/mapped automatically'
);

select 'DISTRIBUTOR_SAFE_COPY_DB_TEST_PASS' as result;
