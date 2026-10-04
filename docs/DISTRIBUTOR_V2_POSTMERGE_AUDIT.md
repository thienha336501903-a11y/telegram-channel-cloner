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
