\set ON_ERROR_STOP on

-- A fresh CI-only database. No Supabase project, Production queue or Telegram
-- channel is used here. The destination ids below stand in for Bot API results.
create database tgcloner_synthetic_pilot;
\connect tgcloner_synthetic_pilot

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

create or replace function pg_temp.assert_true(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'synthetic pilot failed: %', p_message; end if;
end
$$;

create or replace function pg_temp.finish_claimed(p_work public.tgcloner_clone_work)
returns void language plpgsql as $$
declare
  v_chat_id text;
  v_destination_message_ids bigint[];
  v_pin bigint;
begin
  select d.chat_id into v_chat_id
  from public.tgcloner_clone_runs r
  join public.tgcloner_destinations d on d.id = r.destination_id
  where r.id = p_work.run_id;
  -- Fixture chat ids end in 1, 2, 3, 4; each fake destination gets its own
  -- disjoint Telegram message-id range.
  select array_agg((right(v_chat_id, 1)::bigint * 1000 + x.message_id) order by x.ordinal)
    into v_destination_message_ids
  from unnest(p_work.manifest_message_ids) with ordinality as x(message_id, ordinal);
  select mm.destination_message_id into v_pin
  from public.tgcloner_clone_runs r
  join public.tgcloner_message_mappings mm
    on mm.source_id = r.source_id and mm.destination_id = r.destination_id
   and mm.source_message_id = 1
  where r.id = p_work.run_id;

  if p_work.phase in ('copy','catchup') then
    perform public.tgcloner_distributor_arm_work(p_work.id, 'synthetic-worker', p_work.lease_generation);
    perform public.tgcloner_distributor_finish_copy(
      p_work.id, 'synthetic-worker', p_work.lease_generation,
      v_destination_message_ids, '{"synthetic_bot_response":true}'::jsonb
    );
  elsif p_work.phase = 'rewrite' then
    perform public.tgcloner_distributor_arm_work(p_work.id, 'synthetic-worker', p_work.lease_generation);
    perform public.tgcloner_distributor_finish_rewrite(
      p_work.id, 'synthetic-worker', p_work.lease_generation,
      '{"actual_verified":true,"synthetic_destination_read":true}'::jsonb
    );
  elsif p_work.phase = 'pin' then
    perform public.tgcloner_distributor_arm_work(p_work.id, 'synthetic-worker', p_work.lease_generation);
    perform public.tgcloner_distributor_finish_pin(
      p_work.id, 'synthetic-worker', p_work.lease_generation,
      jsonb_build_object('destination_message_id', v_pin)
    );
  elsif p_work.phase = 'verify' then
    perform public.tgcloner_distributor_finish_verify(
      p_work.id, 'synthetic-worker', p_work.lease_generation,
      v_pin, '{"synthetic_destination_read":true}'::jsonb
    );
  else
    raise exception 'unexpected synthetic work phase: %', p_work.phase;
  end if;
end
$$;

create or replace function pg_temp.drain_work()
returns integer language plpgsql as $$
declare
  v_work public.tgcloner_clone_work;
  v_batch integer;
  v_total integer := 0;
begin
  for i in 1..40 loop
    v_batch := 0;
    for v_work in select * from public.tgcloner_distributor_claim_work('synthetic-worker', 3, 60) loop
      perform pg_temp.finish_claimed(v_work);
      v_batch := v_batch + 1;
    end loop;
    v_total := v_total + v_batch;
    if v_batch = 0 then return v_total; end if;
  end loop;
  raise exception 'synthetic work drain exceeded bounded iterations';
end
$$;

-- The Original is a source only. One source contains a pinned TOC, a two-post
-- album, and a video; the second source uses the same fixture for concurrent 1→3.
insert into public.tgcloner_sources(chat_id, title, private_link_id, active)
values ('-1009000000001', 'Synthetic Original 1 to 1', '9000000001', false),
       ('-1009000000002', 'Synthetic Original 1 to 3', '9000000002', false);

insert into public.tgcloner_source_messages(
  source_id, source_message_id, message_type, text, media_group_id,
  is_pinned, has_internal_links, source_date
)
select s.id, fixture.message_id, fixture.message_type,
       replace(fixture.body, '{source}', s.private_link_id),
       fixture.album_id, fixture.pinned, fixture.internal_link, now()
from public.tgcloner_sources s
cross join (values
  (1::bigint, 'text', 'Mục lục: https://t.me/c/{source}/4', null::text, true, true),
  (2::bigint, 'photo', 'Ảnh 1', 'album-a', false, false),
  (3::bigint, 'photo', 'Ảnh 2', 'album-a', false, false),
  (4::bigint, 'video', 'Bài video', null::text, false, false)
) as fixture(message_id, message_type, body, album_id, pinned, internal_link)
where s.chat_id in ('-1009000000001','-1009000000002');

insert into public.tgcloner_destinations(source_id, chat_id, title, active)
select s.id, '-1009000000101', 'Synthetic destination 1', false
from public.tgcloner_sources s where s.chat_id = '-1009000000001';
insert into public.tgcloner_destinations(source_id, chat_id, title, active)
select s.id, '-100900000020' || n::text, 'Synthetic destination ' || n::text, false
from public.tgcloner_sources s cross join generate_series(2,4) n
where s.chat_id = '-1009000000002';

update public.tgcloner_settings set distributor_v2_enabled = true where singleton = true;

-- Stage 1: one destination. Inject response loss after side effect is armed,
-- quarantine it and reconcile the observed mapping without a second copy.
select (public.tgcloner_distributor_create_run(s.id, d.id, 'initial_backfill')).id::text as run_one
from public.tgcloner_sources s join public.tgcloner_destinations d on d.source_id = s.id
where s.chat_id = '-1009000000001' \gset
select (public.tgcloner_distributor_close_manifest(:'run_one'::uuid, 4, array[1::bigint,2,3,4])).id;
select id::text as id, lease_generation::text as generation
from public.tgcloner_distributor_claim_work('synthetic-worker', 1, 60) \gset uncertain_
select (public.tgcloner_distributor_arm_work(:'uncertain_id'::uuid, 'synthetic-worker', :'uncertain_generation'::bigint)).id;
select (public.tgcloner_distributor_finish_work(
  :'uncertain_id'::uuid, 'synthetic-worker', :'uncertain_generation'::bigint,
  'ambiguous', false, 30, 'response_lost', 'Synthetic response lost after copy', '{}'::jsonb
)).id;
select pg_temp.assert_true(
  (select status = 'blocked_ambiguous' and attempt_count = 1
   from public.tgcloner_clone_work where id = :'uncertain_id'::uuid)
  and (select count(*) = 0 from public.tgcloner_message_mappings
       where destination_id = (select destination_id from public.tgcloner_clone_runs where id = :'run_one'::uuid)),
  'ambiguous copy must not invent a mapping or retry'
);
select (public.tgcloner_distributor_resolve_ambiguous_copy(
  :'uncertain_id'::uuid, 'confirmed', array[1001::bigint]
)).id;
select pg_temp.assert_true(pg_temp.drain_work() = 2, '1→1 remaining album/video copy count');
select (public.tgcloner_distributor_prepare_catchup(:'run_one'::uuid, 0, 0)).id;
select (public.tgcloner_distributor_prepare_catchup(:'run_one'::uuid, 0, 0)).id;
select (public.tgcloner_distributor_prepare_fidelity(:'run_one'::uuid, 1)).id;
select pg_temp.assert_true(pg_temp.drain_work() = 2, '1→1 rewrite and pin count');
select (public.tgcloner_distributor_prepare_verification(:'run_one'::uuid)).id;
select pg_temp.assert_true(pg_temp.drain_work() = 1, '1→1 final verification count');
select pg_temp.assert_true(
  (select phase = 'ready_for_new' and last_verified_at is not null
   from public.tgcloner_clone_runs where id = :'run_one'::uuid),
  '1→1 failed to reach verified READY'
);

-- Stage 2: three destinations concurrently, each with its own run and mapping.
select (public.tgcloner_distributor_create_run(s.id, d.id, 'initial_backfill')).id
from public.tgcloner_sources s join public.tgcloner_destinations d on d.source_id = s.id
where s.chat_id = '-1009000000002';
select (public.tgcloner_distributor_close_manifest(r.id, 4, array[1::bigint,2,3,4])).id
from public.tgcloner_clone_runs r join public.tgcloner_sources s on s.id = r.source_id
where s.chat_id = '-1009000000002';

-- First concurrent claim yields one operation for each destination. Simulate
-- a known 429 on one destination while the other two complete their work.
create temp table pilot_first_batch as
select * from public.tgcloner_distributor_claim_work('synthetic-worker', 3, 60);
select pg_temp.assert_true((select count(*) from pilot_first_batch) = 3,
  '1→3 first batch must claim three distinct runs');
select pg_temp.assert_true((select count(distinct run_id) from pilot_first_batch) = 3,
  '1→3 claim must not double-lease a destination');
select pg_temp.finish_claimed(w)
from public.tgcloner_clone_work w
join pilot_first_batch b on b.id = w.id
join public.tgcloner_clone_runs r on r.id = w.run_id
join public.tgcloner_destinations d on d.id = r.destination_id
where right(d.chat_id,1) <> '4';
select (public.tgcloner_distributor_finish_work(
  w.id, 'synthetic-worker', w.lease_generation,
  'known_failure', true, 5, 'telegram_429', 'Synthetic retry-after', '{}'::jsonb
)).id
from pilot_first_batch w
join public.tgcloner_clone_runs r on r.id = w.run_id
join public.tgcloner_destinations d on d.id = r.destination_id
where right(d.chat_id,1) = '4';
select pg_temp.assert_true(
  (select status = 'retry_wait' and attempt_count = 1 from public.tgcloner_clone_work
   where id = (select w.id from pilot_first_batch w join public.tgcloner_clone_runs r on r.id = w.run_id
               join public.tgcloner_destinations d on d.id = r.destination_id
               where right(d.chat_id,1) = '4')),
  'known 429 must wait without a confirmed mapping'
);
-- Advance only the synthetic clock for the test row; do not sleep or retry a
-- real Telegram request. The other two destinations have already progressed.
update public.tgcloner_clone_work set next_attempt_at = now() - interval '1 second'
where id in (select w.id from pilot_first_batch w
             join public.tgcloner_clone_runs r on r.id = w.run_id
             join public.tgcloner_destinations d on d.id = r.destination_id
             where right(d.chat_id,1) = '4');
select pg_temp.assert_true(pg_temp.drain_work() = 7,
  '1→3 remaining copy units (including the known retry)');

-- Source receives one new post during backfill/catch-up. Each destination
-- catches it up once. Event ledger and gap scan share the same barrier.
insert into public.tgcloner_source_messages(source_id, source_message_id, message_type, text, source_date)
select id, 5, 'text', 'Bài mới khi đang clone', now()
from public.tgcloner_sources where chat_id = '-1009000000002';
insert into public.tgcloner_source_events(event_key, source_id, origin, event_kind, source_message_id)
select 'synthetic:late:5', id, 'admin', 'message_new', 5
from public.tgcloner_sources where chat_id = '-1009000000002';
select (public.tgcloner_distributor_prepare_catchup(r.id, 0, 0)).id
from public.tgcloner_clone_runs r join public.tgcloner_sources s on s.id = r.source_id
where s.chat_id = '-1009000000002';
select (public.tgcloner_distributor_prepare_catchup(r.id, 0, 0)).id
from public.tgcloner_clone_runs r join public.tgcloner_sources s on s.id = r.source_id
where s.chat_id = '-1009000000002';
select pg_temp.assert_true(pg_temp.drain_work() = 3, 'catch-up must copy late post to each destination');
select (public.tgcloner_distributor_prepare_catchup(r.id, 0, 0)).id
from public.tgcloner_clone_runs r join public.tgcloner_sources s on s.id = r.source_id
where s.chat_id = '-1009000000002';
select (public.tgcloner_distributor_prepare_catchup(r.id, 0, 0)).id
from public.tgcloner_clone_runs r join public.tgcloner_sources s on s.id = r.source_id
where s.chat_id = '-1009000000002';
select (public.tgcloner_distributor_prepare_fidelity(r.id, 1)).id
from public.tgcloner_clone_runs r join public.tgcloner_sources s on s.id = r.source_id
where s.chat_id = '-1009000000002';
select pg_temp.assert_true(pg_temp.drain_work() = 6, 'three rewrites and three pins expected');
select (public.tgcloner_distributor_prepare_verification(r.id)).id
from public.tgcloner_clone_runs r join public.tgcloner_sources s on s.id = r.source_id
where s.chat_id = '-1009000000002';
select pg_temp.assert_true(pg_temp.drain_work() = 3, 'three final verifications expected');

select pg_temp.assert_true(
  (select count(*) = 3 from public.tgcloner_clone_runs r
   join public.tgcloner_sources s on s.id = r.source_id
   where s.chat_id = '-1009000000002' and r.phase = 'ready_for_new'
     and r.last_verified_at is not null),
  'all three destinations must be verified READY'
);
select pg_temp.assert_true(
  (select count(*) = 15 from public.tgcloner_message_mappings mm
   join public.tgcloner_sources s on s.id = mm.source_id
   where s.chat_id = '-1009000000002' and mm.status = 'copied'
     and mm.verified_at is not null),
  '1→3 must keep five verified mappings per destination'
);
select pg_temp.assert_true(
  (select count(*) = 0 from public.tgcloner_destinations d
   join public.tgcloner_sources s on s.id = d.source_id
   where s.chat_id = '-1009000000002' and d.active),
  'synthetic destination must not be activated for learners'
);
select pg_temp.assert_true(
  (select (c->>'verified_destinations')::integer = 3
      and (c->>'completed_units')::integer = (c->>'known_units')::integer
      and (c->>'lag_events')::integer = 0
   from jsonb_array_elements(public.tgcloner_distributor_progress()->'courses') c
   join public.tgcloner_sources s on s.id::text = c->>'source_id'
   where s.chat_id = '-1009000000002'),
  'ledger must show 3/3 READY and 100% without lag'
);
select pg_temp.assert_true(
  (select count(*) = 0 from public.tgcloner_clone_work w
   join public.tgcloner_clone_runs r on r.id = w.run_id
   join public.tgcloner_sources s on s.id = r.source_id
   where s.chat_id = '-1009000000002' and w.status in
     ('queued','leased','retry_wait','blocked_ambiguous','blocked_dependency','failed')),
  'pilot must finish with no unresolved work'
);

select 'SYNTHETIC_1_TO_1_AND_1_TO_3_DB_PILOT_PASS' as result;
