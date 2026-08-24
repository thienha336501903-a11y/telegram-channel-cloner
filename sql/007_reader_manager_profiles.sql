-- Reader Manager: additive multi-account registry and targeted job assignment.
-- Telegram OTP, 2FA password, API hash and session material remain local on
-- the paired Windows PC. RLS is enabled without anon/authenticated policies.

create table if not exists public.tgcloner_reader_agents (
  id uuid primary key default gen_random_uuid(),
  display_name text not null default 'Máy Reader',
  token_hash text not null unique,
  platform text,
  app_version text,
  status text not null default 'online'
    check (status in ('online','offline','revoked')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tgcloner_reader_profiles (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.tgcloner_reader_agents(id) on delete cascade,
  telegram_user_id text not null,
  display_name text not null,
  masked_phone text,
  status text not null default 'ready'
    check (status in ('ready','busy','cooldown','reauth','paused','offline','revoked')),
  cooldown_until timestamptz,
  last_seen_at timestamptz,
  last_job_assigned_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, telegram_user_id)
);

create table if not exists public.tgcloner_reader_pairings (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  display_name text not null default 'Máy Reader',
  expires_at timestamptz not null,
  used_at timestamptz,
  agent_id uuid references public.tgcloner_reader_agents(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.tgcloner_reader_source_access (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.tgcloner_sources(id) on delete cascade,
  reader_profile_id uuid not null references public.tgcloner_reader_profiles(id) on delete cascade,
  status text not null default 'unknown'
    check (status in ('unknown','verified','denied')),
  checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, reader_profile_id)
);

alter table public.tgcloner_reader_jobs
  add column if not exists assigned_reader_profile_id uuid references public.tgcloner_reader_profiles(id) on delete set null,
  add column if not exists claimed_reader_profile_id uuid references public.tgcloner_reader_profiles(id) on delete set null,
  add column if not exists progress_current integer,
  add column if not exists progress_total integer,
  add column if not exists retry_after timestamptz,
  add column if not exists error_code text;

create index if not exists tgcloner_reader_agents_last_seen_idx
  on public.tgcloner_reader_agents(status, last_seen_at desc);
create index if not exists tgcloner_reader_profiles_status_idx
  on public.tgcloner_reader_profiles(status, last_job_assigned_at asc nulls first);
create index if not exists tgcloner_reader_pairings_expiry_idx
  on public.tgcloner_reader_pairings(expires_at);
create index if not exists tgcloner_reader_source_access_profile_idx
  on public.tgcloner_reader_source_access(reader_profile_id, status);
create index if not exists tgcloner_reader_jobs_assignment_idx
  on public.tgcloner_reader_jobs(status, assigned_reader_profile_id, requested_at);
create unique index if not exists tgcloner_reader_jobs_one_processing_per_profile_idx
  on public.tgcloner_reader_jobs(claimed_reader_profile_id)
  where status = 'processing' and claimed_reader_profile_id is not null;

alter table public.tgcloner_reader_agents enable row level security;
alter table public.tgcloner_reader_profiles enable row level security;
alter table public.tgcloner_reader_pairings enable row level security;
alter table public.tgcloner_reader_source_access enable row level security;
