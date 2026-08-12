-- Telegram Channel Cloner shared-DB scheduler.
-- All application-owned objects remain under the tgcloner_* prefix.
-- Safe to run on the shared Clone database; no Commerce/LMS tables are touched.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table if not exists public.tgcloner_scheduler_nonces (
  token_hash text primary key,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists tgcloner_scheduler_nonces_expiry_idx
  on public.tgcloner_scheduler_nonces(expires_at);

create table if not exists public.tgcloner_settings (
  singleton boolean primary key default true check (singleton),
  scheduler_enabled boolean not null default false,
  scheduler_base_url text,
  updated_at timestamptz not null default now()
);

insert into public.tgcloner_settings(singleton, scheduler_enabled)
values (true, false)
on conflict (singleton) do nothing;

alter table public.tgcloner_scheduler_nonces enable row level security;
alter table public.tgcloner_settings enable row level security;

create or replace function public.tgcloner_dispatch_tick()
returns bigint
language plpgsql
security definer
set search_path = public, extensions, net, pg_catalog
as $$
declare
  v_base_url text;
  v_token text;
  v_hash text;
  v_request_id bigint;
begin
  select scheduler_base_url
    into v_base_url
  from public.tgcloner_settings
  where singleton = true
    and scheduler_enabled = true;

  if v_base_url is null or btrim(v_base_url) = '' then
    return null;
  end if;

  delete from public.tgcloner_scheduler_nonces
  where expires_at < now() - interval '10 minutes'
     or used_at < now() - interval '10 minutes';

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  insert into public.tgcloner_scheduler_nonces(token_hash, expires_at)
  values (v_hash, now() + interval '2 minutes');

  select net.http_post(
    url := rtrim(btrim(v_base_url), '/') || '/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-tgcloner-scheduler-token', v_token
    ),
    body := jsonb_build_object('source', 'supabase_cron', 'time', now()),
    timeout_milliseconds := 5000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.tgcloner_dispatch_tick() from public, anon, authenticated;

select cron.schedule(
  'tgcloner-queue-tick',
  '* * * * *',
  'select public.tgcloner_dispatch_tick();'
);
