-- Migration: Support lease fencing generation (p_attempt) in finish_v5_telegram_mirror_job
-- Date: 2026-09-17
-- System: System B (LMS & Reader)

create or replace function public.finish_v5_telegram_mirror_job(
  p_job_id uuid,
  p_agent_id text,
  p_ok boolean,
  p_object_key text default null,
  p_bytes bigint default null,
  p_etag text default null,
  p_error text default null,
  p_attempt integer default null
)
returns public.v5_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  j public.v5_jobs;
  now_ts timestamptz := now();
begin
  select * into j
    from public.v5_jobs
   where id = p_job_id
     and job_type = 'telegram_mirror'
     and status = 'running'
     and locked_by = btrim(p_agent_id)
   for update;

  if not found then
    raise exception 'v5_mirror_job_not_owned';
  end if;

  -- Lease fencing: verify that the caller's attempt matches the active lease generation
  if p_attempt is not null and j.attempts is distinct from p_attempt then
    raise exception 'v5_mirror_lease_fenced:expected_attempt_%_got_%', j.attempts, p_attempt;
  end if;

  if p_ok then
    if coalesce(btrim(p_object_key),'') = '' then
      raise exception 'r2_object_key_required';
    end if;

    update public.v5_media_assets
       set provider = 'r2',
           r2_object_key = btrim(p_object_key),
           bytes = coalesce(p_bytes, bytes),
           status = 'ready',
           uploaded_at = now_ts,
           last_verified_at = now_ts,
           last_error = null,
           metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'telegram_mirrored', true,
             'r2_etag', nullif(btrim(coalesce(p_etag,'')), '')
           ),
           updated_at = now_ts
     where id = j.asset_id;

    update public.v5_posts p
       set status = 'ready',
           metadata = coalesce(p.metadata,'{}'::jsonb) || jsonb_build_object('pending_attachments', false),
           updated_at = now_ts
     where exists (
       select 1 from public.v5_post_assets pa
        where pa.post_id = p.id and pa.asset_id = j.asset_id
     )
       and not exists (
         select 1
           from public.v5_post_assets pa2
           join public.v5_media_assets a2 on a2.id = pa2.asset_id
          where pa2.post_id = p.id
            and a2.status not in ('ready','archived')
       );

    update public.v5_jobs
       set status = 'success',
           progress_current = coalesce(p_bytes, progress_total, progress_current),
           progress_total = coalesce(p_bytes, progress_total),
           result = jsonb_build_object('object_key', btrim(p_object_key), 'bytes', p_bytes, 'etag', p_etag),
           last_error = null,
           finished_at = now_ts,
           locked_at = null,
           locked_by = null,
           updated_at = now_ts
     where id = j.id
     returning * into j;

    return j;
  else
    update public.v5_jobs
       set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
           locked_at = null,
           locked_by = null,
           last_error = coalesce(btrim(p_error), 'v5_mirror_failed'),
           finished_at = case when attempts >= max_attempts then now_ts else null end,
           available_at = case when attempts >= max_attempts then available_at else now_ts + interval '30 seconds' end,
           updated_at = now_ts
     where id = j.id
     returning * into j;

    return j;
  end if;
end;
$$;

revoke all on function public.finish_v5_telegram_mirror_job(uuid,text,boolean,text,bigint,text,text,integer) from public, anon, authenticated;
grant execute on function public.finish_v5_telegram_mirror_job(uuid,text,boolean,text,bigint,text,text,integer) to service_role;
