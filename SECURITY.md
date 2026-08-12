# Security policy

This repository is intentionally safe to keep public **only if secrets remain outside Git history**.

Never commit:

- `TELEGRAM_BOT_TOKEN`
- Telegram `api_id` / `api_hash` credentials
- MTProto/Telethon/TDLib session files
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`, `READER_INGEST_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, or `CRON_SECRET`
- Vercel access tokens

Runtime secrets belong in Vercel Environment Variables or another secret store. Historical-reader session material stays on the machine running `reader-cli` and must never be uploaded to Vercel or GitHub.

Before every release, run a secret scan and verify `.env*` (except `.env.example`) and `*.session*` are ignored.
