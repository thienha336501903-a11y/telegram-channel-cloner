# Automatic Telegram deletion reconciliation

Telegram Bot API channel webhooks do not emit a reliable delete event for old channel posts. The Cloner therefore uses the local Windows Reader Agent to reconcile deletions without uploading the Telegram user session.

Flow:

1. Reader Agent polls `/api/reader/complete?action=claim`.
2. If no explicit import job is queued, the server may enqueue one due `reconcile` job (default every 6 hours per indexed source; configurable with `READER_RECONCILE_INTERVAL_HOURS`).
3. The local reconciler requests a plan containing the database `upper_bound_message_id` before scanning Telegram.
4. The local Telegram session enumerates message IDs and verifies the resolved Telegram `chat_id` matches the registered source.
5. The server deletes only indexed rows whose IDs are `<= upper_bound_message_id` and are absent from the Telegram snapshot.
6. Rows created after the plan are outside the frozen upper bound and cannot be deleted by that reconcile run.
7. The source indexed count is recomputed exactly and `last_reconciled_at` is updated.

The Telegram session, OTP, 2FA password, API hash and reader secret stay on the Windows reader PC.
