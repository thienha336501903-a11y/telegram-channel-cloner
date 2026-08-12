# Telegram Channel Cloner

Safe, destination-aware Telegram course channel mirroring:

- 1 MASTER → N destination channels.
- Historical backfill and live mirroring.
- Text/photo/video/document/caption copy through Telegram server-side APIs.
- Mapping of source message IDs to destination message IDs.
- Rewrites internal `t.me/c/.../<message_id>` or public channel links so each clone's table of contents points to its own messages.
- Conservative queue rate limiting and Telegram `retry_after` handling.

## Current stage

This repository is an implementation scaffold for the first POC. It is safe to deploy as a dashboard/API after Supabase and Telegram secrets are configured, but **do not point it at production course channels before POC validation on a test channel**.

See `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION_STATUS.md`.

## Local validation

```bash
npm test
npm run check
```

## Infrastructure

- Vercel: dashboard, API, Telegram webhook, queue ticks.
- Supabase: mapping/job/index database.
- Local `reader-cli`: one-time historical indexing using a dedicated Telegram user session. The session stays on the local machine.

## First real deployment sequence

1. Create a dedicated Supabase project and apply `sql/001_initial_schema.sql`.
2. Create/deploy the Vercel project and set `.env.example` values.
3. Create Telegram bot and add it as admin to one MASTER test channel and one destination test channel.
4. Register Bot API webhook with the configured secret token.
5. Run `reader-cli` against the MASTER test channel.
6. Start one full-clone job, then verify mappings and rewritten links.
7. Only after PASS: add album/pin/consistency phases and scale destinations gradually.
