-- Telegram Channel Cloner shared-Supabase layout.
-- All application tables are isolated behind the tgcloner_ prefix.
-- RLS is enabled with no anon/authenticated policies; server routes use service-role only.

create extension if not exists pgcrypto;

create table if not exists public.tgcloner_sources (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null unique,
  title text,
  username text,
  private_link_id text,
  active boolean not null default true,
  indexed_at timestamptz,
  indexed_message_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tgcloner_destinations (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.tgcloner_sources(id) on delete cascade,
  chat_id text not null unique,
  title text,
  username text,
  active boolean not null default true,
  verified_at timestamptz,
  last_write_at timestamptz,
  paused_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tgcloner_source_messages (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.tgcloner_sources(id) on delete cascade,
  source_message_id bigint not null,
  media_group_id text,
  message_type text not null default 'other',
  text text,
  text_entities jsonb not null default '[]'::jsonb,
  caption text,
  caption_entities jsonb not null default '[]'::jsonb,
  reply_to_source_message_id bigint,
  is_pinned boolean not null default false,
  has_internal_links boolean not null default false,
  raw_message jsonb not null default '{}'::jsonb,
  source_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_id, source_message_id)
);
create index if not exists tgcloner_source_messages_source_order_idx on public.tgcloner_source_messages(source_id, source_message_id);
create index if not exists tgcloner_source_messages_media_group_idx on public.tgcloner_source_messages(source_id, media_group_id) where media_group_id is not null;

create table if not exists public.tgcloner_message_mappings (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.tgcloner_sources(id) on delete cascade,
  source_message_id bigint not null,
  destination_id uuid not null references public.tgcloner_destinations(id) on delete cascade,
  destination_message_id bigint,
  status text not null default 'pending' check (status in ('pending','copied','failed','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_id, source_message_id, destination_id)
);
create index if not exists tgcloner_mappings_destination_idx on public.tgcloner_message_mappings(destination_id, source_message_id);

create table if not exists public.tgcloner_clone_jobs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.tgcloner_sources(id) on delete cascade,
  destination_id uuid not null references public.tgcloner_destinations(id) on delete cascade,
  mode text not null,
  status text not null default 'queued' check (status in ('queued','running','done','failed','paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tgcloner_clone_jobs_status_idx on public.tgcloner_clone_jobs(status, created_at);

create table if not exists public.tgcloner_clone_job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.tgcloner_clone_jobs(id) on delete cascade,
  source_message_id bigint not null,
  source_message_ids jsonb not null default '[]'::jsonb,
  phase text not null default 'copy' check (phase in ('copy','rewrite','pin','verify')),
  status text not null default 'queued' check (status in ('queued','processing','done','failed','skipped')),
  attempts integer not null default 0,
  retry_after timestamptz,
  last_error text,
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tgcloner_clone_job_items_queue_idx on public.tgcloner_clone_job_items(status, retry_after, created_at);

create table if not exists public.tgcloner_internal_links (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.tgcloner_sources(id) on delete cascade,
  source_message_db_id uuid not null references public.tgcloner_source_messages(id) on delete cascade,
  source_message_id bigint not null,
  location text not null check (location in ('text','caption')),
  original_url text not null,
  created_at timestamptz not null default now(),
  unique(source_message_db_id, location, original_url)
);

create table if not exists public.tgcloner_sync_events (
  id bigint generated always as identity primary key,
  source_id uuid references public.tgcloner_sources(id) on delete set null,
  destination_id uuid references public.tgcloner_destinations(id) on delete set null,
  source_message_id bigint,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists tgcloner_sync_events_created_idx on public.tgcloner_sync_events(created_at desc);

alter table public.tgcloner_sources enable row level security;
alter table public.tgcloner_destinations enable row level security;
alter table public.tgcloner_source_messages enable row level security;
alter table public.tgcloner_message_mappings enable row level security;
alter table public.tgcloner_clone_jobs enable row level security;
alter table public.tgcloner_clone_job_items enable row level security;
alter table public.tgcloner_internal_links enable row level security;
alter table public.tgcloner_sync_events enable row level security;
