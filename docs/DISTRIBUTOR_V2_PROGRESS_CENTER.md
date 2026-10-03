# Distributor V2 Progress Center (PR4)

`sql/016_distributor_v2_progress_center.sql` adds a read-only, service-role-only
RPC. Apply it after `010`–`015` in an isolated System B test database before
the synthetic pilot. Applying `016` does not enable the V2 worker, allocate a
learner, register a webhook, or send a Telegram message. Production database
migration and live queue activation remain separate gates.

The admin route `GET /api/admin/distributor-progress` requires an admin session.
It rolls up the latest non-superseded run per destination and returns all course
and overall totals, plus at most 50 recent destination rows. A missing migration
is shown as unavailable; unrelated database errors remain errors. The dashboard
refreshes this route every two minutes while visible, and on manual refresh.

Counts come from the immutable manifest, confirmed mappings, and V2 work ledger.
An album is one copy work unit and retains its member count. Retry attempts never
add completed units. Skipped and cancelled work is excluded from the work total.
One verification unit is reserved until verification work exists. The denominator
can grow as link, pin, and catch-up work is discovered. An open manifest has no
percentage. A run or rollup reaches 100% only with READY verification, complete
manifest mappings, no unresolved work, and no known source event/message lag.
Reader import is displayed separately from destination cloning. Telegram Bot API
copy does not expose a byte-level media transfer percentage.

CI executes the migration and integration assertions for READY, open manifest,
retry, blocker, source lag, and album grouping. A separate PostgreSQL database
in the same CI job runs `tests/distributor-synthetic-pilot.integration.sql` for
1→1 and concurrent 1→3. It covers album grouping, a pinned TOC, video, a late
source post, a known 429 retry, ambiguous-copy reconciliation, and the final
3/3 READY ledger. It uses synthetic message IDs and simulated Telegram results;
it sends nothing to Telegram and needs no Supabase project or paid branch.

This database pilot does not prove actual Bot API copy, media fidelity, link
rewriting, pin state, or webhook delivery. The next gate is a real 1→1 then 1→3
pilot on disposable test channels with the bot as admin and isolated test data.
Only after both gates pass should V2 migrations/queue be considered for the
System B Production database, followed by a separate allocation review. Keep
the existing Production domain, webhook, Original, learners, and System A
untouched during these tests.
