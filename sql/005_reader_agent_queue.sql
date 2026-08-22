-- Background history-reader job queue.
-- Telegram user sessions remain local on the owner's Windows reader PC.
-- Server/admin routes enqueue jobs; the local reader agent claims them using
-- READER_INGEST_SECRET. RLS stays enabled with no anon/authenticated policies.

create table if not exists public.tgcloner_reader_jobs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.tgcloner_sources(id) on delete cascade,
  channel_ref text not null,
  status text not null default 'queued'
    check (status in ('queued','processing','done','failed','cancelled')),
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  attempts integer not null default 0,
  message_count integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tgcloner_reader_jobs_queue_idx
  on public.tgcloner_reader_jobs(status, requested_at);

create index if not exists tgcloner_reader_jobs_source_idx
  on public.tgcloner_reader_jobs(source_id, created_at desc);

create unique index if not exists tgcloner_reader_jobs_one_active_per_source_idx
  on public.tgcloner_reader_jobs(source_id)
  where status in ('queued','processing');

alter table public.tgcloner_reader_jobs enable row level security;
