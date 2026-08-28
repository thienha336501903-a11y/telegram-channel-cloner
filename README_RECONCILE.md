# Explicit Telegram deletion reconciliation

Telegram Bot API channel webhooks do not emit a reliable delete event for old channel posts. The Cloner therefore uses the local Windows Reader Agent to reconcile deletions without uploading the Telegram user session.

Reconcile is **explicit/manual only**. Reader Agent polling never creates time-based reconcile jobs and there is no automatic 6-hour cycle.

Flow:

1. An Admin/workflow explicitly queues a `reconcile` Reader job for a registered source.
2. Reader Agent polls `/api/reader/complete?action=claim` and may claim only an already-queued job.
3. For managed Reader profiles, automatic assignment prefers a profile already verified for that source; profiles known `denied` are excluded. An explicitly selected profile remains available for a deliberate access re-check.
4. The local reconciler requests a plan containing the database `upper_bound_message_id` before scanning Telegram.
5. The local Telegram session enumerates message IDs and verifies the resolved Telegram `chat_id` matches the registered source.
6. The server deletes only indexed rows whose IDs are `<= upper_bound_message_id` and are absent from the Telegram snapshot.
7. Rows created after the plan are outside the frozen upper bound and cannot be deleted by that reconcile run.
8. The source indexed count is recomputed exactly and `last_reconciled_at` is updated.

The Telegram session, OTP, 2FA password, API hash and reader secret stay on the Windows reader PC.
