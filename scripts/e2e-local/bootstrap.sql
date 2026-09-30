do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  else
    alter role service_role bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login password 'local-e2e';
  end if;
end
$$;

grant service_role to authenticator;
grant usage on schema public to service_role;

create table if not exists public.tgcloner_settings (
  singleton boolean primary key default true check (singleton),
  scheduler_enabled boolean not null default false,
  scheduler_base_url text,
  updated_at timestamptz not null default now()
);
insert into public.tgcloner_settings(singleton, scheduler_enabled)
values (true, false)
on conflict (singleton) do update set scheduler_enabled = false, scheduler_base_url = null;
alter table public.tgcloner_settings enable row level security;
