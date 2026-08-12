# Implementation status

## Implemented

- 1 MASTER → N destination data model.
- Shared Supabase isolation using only `tgcloner_*` application tables.
- RLS enabled on every `tgcloner_*` table with no anon/authenticated policies.
- Runtime guard refuses database access to non-`tgcloner_*` tables.
- Admin password/session endpoint.
- Dashboard skeleton.
- Telegram Bot API wrapper.
- Destination verification via `getChat` and automatic binding to the active MASTER.
- Historical reader ingestion endpoints.
- Local reader CLI skeleton.
- Source internal-link detection.
- Per-destination internal-link rewrite + entity offset shifting.
- Source → destination message mapping table.
- Full-clone album grouping through `copyMessages`.
- Pin replication queue phase.
- Clone job queue + conservative tick limits.
- `429 retry_after` handling.
- Live `channel_post` ingestion and fan-out queue creation.
- Edited post path updates an existing mapped destination message rather than copying a new one.
- Idempotent mapping check before copying.
- Destination consistency checker for missing mappings, unresolved link targets, pinned messages and incomplete albums.
- CI checks for tests, JS/Python syntax and secret/session leakage.

## Infrastructure now prepared

- GitHub repository: `thienha336501903-a11y/telegram-channel-cloner`.
- Vercel project: `telegram-channel-cloner`.
- Supabase shared project: `yyiavtiwtekkocqpephr`.
- Applied migration: `tgcloner_initial_schema`.

## Intentionally deferred until real credentials / test channels

- Vercel environment variables containing Supabase service-role key and private runtime secrets.
- Telegram Bot token and webhook registration.
- Historical reader login (needs Telegram API ID/hash and interactive Telegram sign-in).
- Real MASTER registration and first historical index.
- Real destination channel verification.
- Live album debounce/grouping test; full historical clone albums are already grouped.
- End-to-end verification that rewritten links open the corresponding destination messages.
- Production deployment after Preview E2E passes.
