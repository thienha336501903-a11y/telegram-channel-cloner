# Distributor V2: post-merge TEST audit

PR #100 is merged, but V2 remains disabled in Production. The isolated
1→2 run reached READY with 60 mapped posts in each learner-free destination.
An additional 60 unmapped posts appeared in destination 2 during the first
run and were removed after fingerprint reconciliation. Their writer is still
unknown. Do not publish a new index, run another copy, or enable V2 until the
writer is identified or conclusively isolated.

## Read-only evidence from System B

On 2026-10-04, Supabase project `yyiavtiwtekkocqpephr` had no registered
TEST source `-1004320185488` or destinations `-1003933578709` and
`-1004492904064`, no legacy clone jobs created between 04:00 and 04:35 UTC
on 2026-10-03, and `scheduler_enabled=false`. Its organization is on the
Free plan; database size was 37 MB. This rules out that database's legacy
clone job queue as the writer of this TEST stream at that time. It does not
identify a separate Windows process, another bot session, or another service.

## One Windows read-only audit

Run on the Windows computer that retains `tgcloner-e2e-1to2-db` and the
TEST Reader session, after updating to the reviewed audit branch:

```powershell
& powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-local\audit-two-writers.ps1
```

It checks the Docker Compose identity, counts V2 copy attempts per run,
compares current Telegram posts to the 60 mappings in each destination,
and prints relevant running process names and scheduled-task identities.
It also looks for Task Scheduler history in the duplicate window
04:05–04:25 UTC on 2026-10-03 (11:05–11:25 Vietnam time). It never prints
task arguments, process command lines, Telegram content, Reader credentials,
or a bot token. It makes no Telegram/DB/channel writes. Send the `AUDIT_*`
output for interpretation. A missing Task Scheduler history is inconclusive.

`copy_retried=0` in the retained V2 run would mean its ledger recorded no
second copy attempt; it would not prove who wrote the unmapped posts. If any
new `extra_visible` appears, stop; do not delete it without a fresh content,
actor, and mapping reconciliation.

## Two-destination index preview

Only after reviewing the audit, the following command performs a second
read-only source/destination reconciliation and generates separate index
drafts for the two destinations:

```powershell
& powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-local\preview-two-course-index.ps1
```

It requires the same 60-post source inventory (H=61, recorded SHA-256),
59-message closed baseline in each run, READY verification, 60 clean mappings
and no extra visible or pinned destination posts. Each draft groups the ten
albums and links only to that destination's mapped messages. No bot token,
index send, edit, pin, migration, source post, or new Vercel deployment is
performed by either local command. If an appendix begins at a known source
post, pass `-AppendixStartSourceId <id>`; it must start at a lesson boundary,
not in the middle of an album. Without that evidence, the preview makes no
guessed appendix divider.

The current index publisher is restricted to the older 53-post 1→1 fixture.
Publishing/maintaining two destination-owned indexes needs a separately
reviewed, idempotent write path and migration 017 in the isolated DB. Neither
is performed by this audit branch.

## Gate before one more live TEST post

The owner read the live Bot API administrator lists. The dedicated TEST bot
`@yeubep_distributor_test_bot` and the System C bot
`@daubepnho_system_c_bot` both had `can_post_messages=true` in **both**
learner-free TEST destinations on 2026-10-04. This establishes a second
possible writer; it does not identify who wrote the earlier duplicates. The
Telegram administrator history for the earlier 11:10 Vietnam-time window was
unavailable, so do not repeat that request.

The owner, using the creator account, should remove **Post Messages** from the
System C bot in just `-1003933578709` and `-1004492904064`, or remove that bot
from just those two TEST destinations. Keep the dedicated TEST bot's post/edit
rights. Do not change the source, Production, System A or the System C bot's
permissions elsewhere. The `verify-two-test-bot-access.mjs` preflight now asks
for *all* administrators including bots and checks the System C bot directly;
it stops before Docker, webhook setup or a Telegram copy if any other admin
can post. The gate runs before starting the retained local DB and again
immediately before webhook setup.

Only after that permission change, and after the PR code is available on the
Windows computer, use `-ContinueTwoOnePost` with the exact verified 60-post
inventory. Start a temporary Cloudflare Quick Tunnel to local port 8788 in a
separate window, keep it running, then from the reviewed branch run:

```powershell
& .\scripts\e2e-local\run.ps1 `
  -Mode 1to2 -ContinueTwoOnePost -DisposableSourceConfirmed `
  -Source '-1004320185488' `
  -Destinations @('-1003933578709', '-1004492904064') `
  -ExpectedHistoryCount 60 -ExpectedHighWatermark 61 `
  -ExpectedInventorySha256 '2903f3050010c9106866be85f11e08506785e618e3f7f222b75d4fddcb7fa7bd' `
  -PublicUrl 'https://YOUR-CURRENT-TUNNEL.trycloudflare.com'
```

Enter the TEST bot token only in the local prompt. Wait for
`E2E_POST_ONE_NEW_MESSAGE_NOW`, then post **one plain-text message** in the
learner-free TEST source. The mode reuses the two existing READY runs and the
59-post closed manifests; it cannot create another run or replay the 60 mapped
posts. It requires source post #62, maps it once to each destination, checks
both new 61-post channels and removes only its own temporary webhook. If the
run stops after #62, preserve the DB and both destinations and inspect them
before any retry; the same command deliberately refuses a changed source
inventory. Do not rerun a fresh full-copy command.

After `E2E_AUTOMATED_GATE_PASS`, the index *preview* can be regenerated from
the 61-post source with `preview-two-course-index.ps1 -AfterOne`. It remains
read-only and does not publish an index or enable V2 in Production.


## Verified one-post gate and destination-owned index publish pilot

Owner-side Windows evidence on 2026-10-04 at exact HEAD `b118f63ea47c9630fcaac867863a55b9000ab7bb` closed
the one-post catch-up gate. Source post #62 was captured as durable
`bot_webhook` event 2, both retained runs returned to `ready_for_new`, both
destinations passed read-only Telegram verification with 61 mappings, and the
source passed at 61 visible posts with H=62. The automated harness ended with
`E2E_AUTOMATED_GATE_PASS mode=1to2` and removed its temporary TEST webhook.

The independent `preview-two-course-index.ps1 -AfterOne` reconciliation then
confirmed 61 mapped/visible posts in both destinations, no extra/missing/pinned
posts, 26 index entries and 10 albums per destination. The generated
destination-specific hashes were
`8fb4d444dadb850945e8b0bfbd7fe0ff64419a98b9a436ad752ed845e077549f`
for `-1003933578709` and
`6ee7ce50beaa3ebd48af0611f143bd95c20a72d0c7545b5a1621cca1b6bef4b9`
for `-1004492904064`. Preview made no Telegram write.

The next TEST-only gate is `publish-two-course-index.ps1 -AfterOne -Publish`.
It is restricted to the retained `tgcloner-e2e-1to2-db` fixture. Before any
Telegram index send it creates a local PostgreSQL checkpoint, applies the
already-reviewed inert migration 017 only to that TEST database, runs a strict
61-post reconciliation, rechecks the dedicated TEST bot/writer inventory, and
uses a durable local per-destination ledger. A transport-ambiguous send leaves
the ledger armed and blocks blind retry, preventing a second index post. A
successful post must be pinned, independently verified, and registered to its
own destination/run through
`tgcloner_distributor_register_course_index`.

This is deliberately a first-publish TEST path, not full Production index
maintenance. If source content changes after H=62, content-hash drift is
fail-closed until a separately reviewed edit-in-place maintenance path exists.
Keep PR #101 draft and Distributor V2 disabled in Production after this pilot.
