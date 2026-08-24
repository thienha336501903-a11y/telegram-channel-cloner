-- Additive Reader job telemetry for the Commerce V4 workflow.
-- No Telegram credentials or local session material are stored here.

alter table public.tgcloner_reader_jobs
  add column if not exists progress_stage text,
  add column if not exists progress_detail text;

create index if not exists tgcloner_reader_jobs_profile_completed_idx
  on public.tgcloner_reader_jobs(claimed_reader_profile_id, completed_at desc)
  where claimed_reader_profile_id is not null;

create index if not exists tgcloner_reader_jobs_profile_created_idx
  on public.tgcloner_reader_jobs(claimed_reader_profile_id, created_at desc)
  where claimed_reader_profile_id is not null;
