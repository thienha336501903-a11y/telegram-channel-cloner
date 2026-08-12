# Architecture

## Principle

One MASTER channel can fan out to any number of destination channels. The code does not hard-code a destination count. Safety controls bound *concurrency*, not the total number of configured channels.

## Historical clone

1. Run `reader-cli` locally with a dedicated Telegram user account.
2. Reader indexes source messages and their text/caption/entities. It does **not** download media.
3. Create a full-clone job for one destination.
4. Clone engine calls Bot API `copyMessage`/`copyMessages`, recording `source_message_id → destination_message_id`.
5. After mappings exist, messages containing source-channel links enter `rewrite` phase.
6. Rewriter substitutes each source link with the correct destination-specific link and edits the copied message.
7. Pin/verification phases are added after the first real-channel POC validates message behavior.

## Live mirror

Telegram Bot API webhook receives `channel_post` / `edited_channel_post` for the MASTER. Each message is indexed and enqueued for all active destinations. Queue processing is deliberately conservative and honors Telegram `retry_after` responses.

## Security

- Dashboard session: HMAC-signed, HttpOnly, Secure cookie.
- Supabase service-role key: server-side only.
- Telegram bot token: server-side only.
- Reader ingestion: separate bearer secret.
- Telegram webhook: `X-Telegram-Bot-Api-Secret-Token` required.
- RLS enabled with no anon/authenticated policies.
- Dedicated Telegram reader account recommended; its local session is never deployed.
