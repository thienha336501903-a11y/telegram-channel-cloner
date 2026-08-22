-- Automatic Telegram deletion reconciliation for V4 sources.
-- The local Reader Agent periodically snapshots the message ids that still exist
-- in Telegram. Server-side reconciliation deletes only indexed rows at or below
-- a pre-scan upper bound, so messages arriving during the scan are never removed.

alter table public.tgcloner_sources
  add column if not exists last_reconciled_at timestamptz;

alter table public.tgcloner_reader_jobs
  add column if not exists job_type text not null default 'import';

alter table public.tgcloner_reader_jobs
  add column if not exists deleted_count integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.tgcloner_reader_jobs'::regclass
      and conname = 'tgcloner_reader_jobs_job_type_check'
  ) then
    alter table public.tgcloner_reader_jobs
      add constraint tgcloner_reader_jobs_job_type_check
      check (job_type in ('import','reconcile'));
  end if;
end
$$;

create index if not exists tgcloner_sources_reconcile_due_idx
  on public.tgcloner_sources(last_reconciled_at, created_at)
  where indexed_at is not null;
