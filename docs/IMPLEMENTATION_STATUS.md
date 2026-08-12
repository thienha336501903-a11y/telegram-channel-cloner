# Implementation status

## Implemented in scaffold

- 1 → N destination data model.
- Admin password/session endpoint.
- Dashboard skeleton.
- Supabase schema with RLS.
- Telegram Bot API wrapper.
- Destination verification via `getChat`.
- Historical reader ingestion endpoints.
- Local reader CLI skeleton.
- Source internal-link detection.
- Per-destination link rewrite + entity offset shifting.
- Message mapping table.
- Clone job queue + conservative tick limits.
- `429 retry_after` handling.
- Live `channel_post` ingestion and fan-out queue creation.
- Idempotent mapping check before copying.
- Node unit tests for core link behavior.

## Intentionally deferred until real test channel / credentials

- Telegram webhook registration.
- Historical reader login (needs Telegram API ID/hash and interactive sign-in).
- Album-preserving `copyMessages` grouping in job engine; current POC copies messages individually.
- Pin replication.
- Full consistency checker / zero-source-link audit.
- Edited live post de-duplication (current webhook queues a copy; needs mapping-aware edit path).
- Production DB and Vercel environment variables.
- Production deployment.
