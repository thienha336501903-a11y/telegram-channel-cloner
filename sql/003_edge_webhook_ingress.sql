-- Public Telegram webhook ingress is hosted by Supabase Edge Functions.
-- Store only SHA-256 of TELEGRAM_WEBHOOK_SECRET; plaintext stays in the Cloner runtime/Telegram.

alter table public.tgcloner_settings
  add column if not exists webhook_secret_sha256 text null;

comment on column public.tgcloner_settings.webhook_secret_sha256 is
  'SHA-256 hex of Telegram webhook secret for public Edge Function ingress; plaintext is never stored in database.';
