# Isolated 1→2 Telegram E2E pilot

This pilot is restricted to the owner-supplied learner-free TEST source
`-1004320185488` and two TEST destinations `-1003933578709`,
`-1004492904064`. The owner reported manually deleting the content in the
second destination. The old local course run, its 53 mappings and the ledger
for the formerly pinned index #67 are historical evidence only: they no longer
describe that destination's Telegram state. Preserve the old
`tgcloner-e2e-db` container and its backups.

The new pilot uses the separate Docker project `tgcloner-e2e-1to2` with
`tgcloner-e2e-1to2-db`, `tgcloner-e2e-1to2-rest`, loopback port 8788 for its
local API and dynamically chosen loopback database/PostgREST ports. It never
runs `docker compose down -v` on either project. Supabase B Production, System A,
the Production bot/webhook, domain and learner allocation are out of scope.

## Read-only gate

The TEST Reader account must be a member of all three channels. Before entering
a bot token, run this from the exact reviewed branch on the Windows computer
with the existing TEST Reader session:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-local\run.ps1 `
  -Mode 1to2 -InspectTwoDestinationOnly `
  -Source '-1004320185488' `
  -Destinations '-1003933578709','-1004492904064'
```

It inventories every visible source post, prints `count`, `high_watermark`
and `sha256`, and checks both destinations have no visible or pinned posts.
It prints `E2E_1TO2_READONLY_PREFLIGHT_PASS` only after both are empty.
No Docker, TEST bot token or Telegram write is used. If either destination has
posts or the Reader cannot access it, reconcile membership/channel content
first; do not start a copy. The full run repeats this check and requires the
same source inventory values before any destination write.

## Full TEST copy and one live update

The dedicated `@yeubep_distributor_test_bot` must be an admin of the source
and both destinations with post/edit/pin permissions. Confirm the bot has no
active webhook. In a separate PowerShell window, start a temporary HTTPS tunnel
to **8788**, for example:

```powershell
cloudflared tunnel --url http://127.0.0.1:8788
```

Use the resulting `https://...trycloudflare.com` URL and replace the three
inventory placeholders with the *exact* read-only output:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-local\run.ps1 `
  -Mode 1to2 -DisposableSourceConfirmed `
  -Source '-1004320185488' `
  -Destinations '-1003933578709','-1004492904064' `
  -ExpectedHistoryCount <count> -ExpectedHighWatermark <high_watermark> `
  -ExpectedInventorySha256 '<sha256>' `
  -PublicUrl 'https://TEMP.trycloudflare.com'
```

The script prompts *locally* for the TEST bot token. Never paste the token,
Telegram app hash, Reader session or login code into chat. It verifies bot
identity and that its webhook is unset, imports the source snapshot read-only
into the isolated DB, copies it to both empty destinations, and waits until
both baseline mappings are complete. Only when it prints
`E2E_POST_LATE_MESSAGE_NOW` should the owner post exactly one new **plain text**
TEST message to the learner-free source. The temporary webhook captures that
update for both destinations. The script removes only the webhook it set in
its `finally` block and retains the isolated DB for inspection.

The automated Telegram readback checks all mapped posts, albums, internal
links and pin parity, and samples up to two videos per destination by reading
the first 64 KiB instead of downloading whole course videos. Manually play a
video and open any rewritten links in both destinations. This pilot does not
create or maintain a new course index automatically, and its PASS does not
enable Production live sync or merge the PR.

If a Telegram 429, interruption or uncertain side effect stops the run, keep
both Docker projects and all destination posts. **Do not rerun the fresh
command**: it refuses an existing isolated project. Before the late post has
been created and while the source inventory is unchanged, use the same
arguments plus `-ResumeTwoDestination`. That path rereads existing mappings
from Telegram and blocks ambiguous/armed work before continuing. If the late
post was already made, use the guarded recovery below only for the documented
source message #61. Mapped messages deleted from Telegram, an unexpected post,
or an uncertain/armed work item still require reconciliation; never reset or
recopy blindly.

## Continue after the captured late post #61

The first 1→2 run on 2026-10-03 completed its 59-post baseline to both
destinations and durably captured `bot_webhook` event #1 for new plain-text
source post #61. It then hit `distributor_run_not_catchup_phase`: the first
catch-up RPC had advanced a run to `rewriting`, and the repository called the
phase-limited RPC a second time. The TEST webhook was deleted by `finally`.
The repository now returns immediately when the first RPC advances beyond
catch-up. No SQL migration or Vercel deployment is required for this local
worker fix.

From the updated exact branch HEAD, use direct invocation in the existing
PowerShell session (PowerShell 5.1 needs this for the destination array):

```powershell
& .\scripts\e2e-local\run.ps1 `
  -Mode 1to2 -RecoverTwoAfterLate `
  -Source '-1004320185488' `
  -Destinations @('-1003933578709', '-1004492904064') `
  -ExpectedHistoryCount 59 -ExpectedHighWatermark 60 `
  -ExpectedInventorySha256 '4ff2094c75792dac943d2874541f5c8a4bd2e0dca465e0fc4993dab4ee5314a3' `
  -ExpectedLateSourceMessageId 61
```

This mode requires the live Reader inventory to equal the original 59-post
SHA plus exactly one plain-text post #61, and the retained local source/event
ledger to contain exactly that webhook event. It checks both closed manifests,
all baseline mappings and their Telegram readback, destination post sets,
work state and TEST webhook absence. It saves a local `pg_dump` checkpoint,
restarts the retained containers without recreating them, and advances those
same two runs. It neither imports history nor asks for a new source post, sets
a webhook, or needs a tunnel. The usual final Telegram verifier checks both
60-post destinations and prints `E2E_AUTOMATED_GATE_PASS mode=1to2` only after
READY and readback. Keep the DB and post any failure output for reconciliation.
