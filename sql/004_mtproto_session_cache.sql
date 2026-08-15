-- Persist the bot MTProto authorization between serverless cold starts without
-- exposing the portable StringSession in Git, browser code, or plaintext DB rows.
-- The application stores only AES-256-GCM ciphertext. The decryption key is
-- derived from SESSION_SECRET and remains in the runtime environment.

alter table public.tgcloner_settings
  add column if not exists mtproto_session_ciphertext text null;

comment on column public.tgcloner_settings.mtproto_session_ciphertext is
  'AES-256-GCM encrypted Teleproto StringSession for bot media cold-start reuse; decryption key stays in runtime environment.';
