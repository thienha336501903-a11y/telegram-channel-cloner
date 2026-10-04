-- PR4: read-only, service-role-only ledger progress. No queue, Telegram action,
-- or Production toggle is changed by this migration.
create or replace function public.tgcloner_distributor_progress(p_limit integer default 50)
returns jsonb
language sql stable
security invoker
set search_path = pg_catalog, public
as $$
  with latest as (
    select distinct on (r.destination_id) r.*
    from public.tgcloner_clone_runs r
    where r.status <> 'superseded'
    order by r.destination_id, r.created_at desc, r.id desc
  ), stats as (
    select
      r.id, r.source_id, r.destination_id, r.mode, r.phase, r.status,
      r.status_reason, r.created_at, r.updated_at, r.manifest_closed_at,
      r.last_verified_at, r.ready_at,
      s.title as source_title, d.title as destination_title,
      coalesce(mf.messages, 0) as manifest_messages,
      coalesce(mf.copy_units, 0) as manifest_copy_units,
      coalesce(mf.album_members, 0) as album_members,
      coalesce(mf.albums, 0) as albums,
      coalesce(mp.copied_messages, 0) as copied_messages,
      coalesce(mp.verified_messages, 0) as verified_messages,
      coalesce(w.work_total, 0) + case
        when r.phase not in ('ready_for_new','live_sync')
          and not coalesce(w.has_verification, false) then 1 else 0 end as known_units,
      coalesce(w.work_done, 0) as completed_units,
      coalesce(w.work_retry, 0) as retry_items,
      coalesce(w.work_blocked, 0) as blocked_items,
      coalesce(w.work_queued, 0) as queued_items,
      coalesce(w.phases, '{}'::jsonb) as work_phases,
      coalesce(ev.pending_events, 0) as lag_events,
      coalesce(sm.pending_messages, 0) as lag_messages
    from latest r
    join public.tgcloner_sources s on s.id = r.source_id
    join public.tgcloner_destinations d on d.id = r.destination_id
    left join lateral (
      select count(*) as messages,
        count(distinct copy_unit_key) as copy_units,
        count(*) filter (where media_group_id is not null) as album_members,
        count(distinct media_group_id) filter (where media_group_id is not null) as albums
      from public.tgcloner_clone_manifest m where m.run_id = r.id
    ) mf on true
    left join lateral (
      select count(*) filter (where mm.status = 'copied' and mm.destination_message_id is not null) as copied_messages,
        count(*) filter (where mm.status = 'copied' and mm.destination_message_id is not null
          and mm.verified_at is not null) as verified_messages
      from public.tgcloner_clone_manifest m
      left join public.tgcloner_message_mappings mm
        on mm.source_id = r.source_id and mm.destination_id = r.destination_id
       and mm.source_message_id = m.source_message_id
      where m.run_id = r.id
    ) mp on true
    left join lateral (
      select sum(total) as work_total, sum(done) as work_done,
        sum(retry) as work_retry, sum(blocked) as work_blocked,
        sum(queued) as work_queued,
        bool_or(phase = 'verify' and total > 0) as has_verification,
        jsonb_object_agg(phase, jsonb_build_object(
          'total', total, 'done', done, 'retry', retry,
          'blocked', blocked, 'queued', queued
        )) as phases
      from (
        select w.phase,
          count(*) filter (where w.status not in ('skipped','cancelled')) as total,
          count(*) filter (where w.status = 'done') as done,
          count(*) filter (where w.status = 'retry_wait') as retry,
          count(*) filter (where w.status in ('blocked_dependency','blocked_ambiguous','failed')) as blocked,
          count(*) filter (where w.status in ('queued','leased')) as queued
        from public.tgcloner_clone_work w where w.run_id = r.id
        group by w.phase
      ) by_phase
    ) w on true
    left join lateral (
      select count(*) as pending_events
      from public.tgcloner_source_events e
      where e.source_id = r.source_id
        and e.id > coalesce(r.catchup_barrier_event_id, r.snapshot_event_cursor, 0)
    ) ev on true
    left join lateral (
      select count(*) as pending_messages
      from public.tgcloner_source_messages m
      where m.source_id = r.source_id
        and m.source_message_id > coalesce(r.catchup_high_watermark, r.snapshot_high_watermark, 0)
    ) sm on true
  ), course_rows as (
    select source_id, max(source_title) as source_title,
      count(*) as destinations,
      count(*) filter (where manifest_closed_at is null) as open_manifests,
      sum(known_units) as known_units, sum(completed_units) as completed_units,
      count(*) filter (where phase in ('ready_for_new','live_sync') and last_verified_at is not null
        and status = 'active' and blocked_items = 0 and retry_items = 0
        and lag_events = 0 and lag_messages = 0 and completed_units = known_units
        and verified_messages = manifest_messages) as verified_destinations,
      sum(blocked_items) as blocked_items, sum(retry_items) as retry_items,
      sum(lag_events) as lag_events, sum(lag_messages) as lag_messages
    from stats group by source_id
  )
  select jsonb_build_object(
    'overall', (select jsonb_build_object(
      'destinations', count(*),
      'open_manifests', count(*) filter (where manifest_closed_at is null),
      'known_units', coalesce(sum(known_units),0),
      'completed_units', coalesce(sum(completed_units),0),
      'verified_destinations', count(*) filter (where phase in ('ready_for_new','live_sync')
        and last_verified_at is not null and status = 'active'
        and blocked_items = 0 and retry_items = 0 and lag_events = 0
        and lag_messages = 0 and completed_units = known_units
        and verified_messages = manifest_messages),
      'blocked_items', coalesce(sum(blocked_items),0),
      'retry_items', coalesce(sum(retry_items),0),
      'lag_events', coalesce(sum(lag_events),0),
      'lag_messages', coalesce(sum(lag_messages),0)
    ) from stats),
    'courses', coalesce((select jsonb_agg(to_jsonb(c) order by c.source_title, c.source_id)
      from course_rows c), '[]'::jsonb),
    'runs', coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc, x.id desc)
      from (select * from stats order by updated_at desc, id desc
        limit least(100, greatest(1, coalesce(p_limit,50)))) x), '[]'::jsonb)
  );
$$;

revoke all on function public.tgcloner_distributor_progress(integer) from public, anon, authenticated;
grant execute on function public.tgcloner_distributor_progress(integer) to service_role;
