# Distributor V2 — Real Telegram E2E harness

The full E2E fixture uses **System B test channels only**. A separate opt-in copy-only check can read one old text post from an owner-controlled source with learners, but writes only to an isolated local DB and a confirmed disposable destination. Neither mode uses Supabase B Production, the Production bot/webhook, `reader.yeubep.shop`, learner records, or System A.

## What it proves

The existing CI synthetic pilot proves database/RPC behavior only. This harness adds the missing real Telegram gates:

- Reader history import from a disposable source channel into an isolated local DB;
- actual Bot API `copyMessage` / `copyMessages` to disposable destinations;
- album grouping, video accessibility, literal TOC link rewrite and hidden `text_link` rewrite;
- pin parity;
- 1→1 then concurrent 1→3;
- a real new source post delivered by the **test bot webhook** during 1→3 and caught up through the durable V2 event ledger;
- read-only Telethon verification of destination messages and mapped media.

A real 429 is **not** forced. CI already covers known 429 retry semantics and Telegram must not be spammed to manufacture one.

## Safety defaults

`run.ps1` creates a fresh local PostgreSQL 17 + PostgREST stack with Docker and applies only:

- `002_shared_supabase_tgcloner_schema.sql`;
- a local `tgcloner_settings` row with scheduler disabled;
- migrations `010` through `016`;
- local-only grants required by PostgREST.

The local server maps the Supabase `/rest/v1/` URL to PostgREST's root routes and checks both paths before using Telegram. Docker publishes the database ports only on `127.0.0.1`. Each run creates a new local REST key, which the server requires even when a temporary test webhook tunnel is open.
The harness selects a free loopback port for PostgREST and prints `E2E_POSTGREST_PORT`, avoiding collisions with another service on `54321`. Docker startup failures stop the run before the Telegram smoke step.

The script sets `TGCLONER_READER_NO_SOURCE_MUTATION=true`. If Reader media metadata is not sufficient, ingestion fails instead of using the legacy self-forward/delete hydration path. The V2 webhook bridge is also opt-in through `DISTRIBUTOR_V2_EVENT_BRIDGE_ENABLED=true`; Production remains unchanged unless a later rollout explicitly enables it after migrations/review.

## Copy one existing text post from a source with learners

Use `-ExistingTextOnly` when posting to the source is inappropriate. The Reader Telegram account reads history and selects the newest accessible plain-text post without media or links. The harness indexes that single post in its disposable local DB and uses the verified TEST bot to copy it to destination A. It never sends, edits, pins or deletes a source post, and it does not set or delete a webhook. **Destination A must be disposable and have no learners.**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/e2e-local/run.ps1 `
  -Mode 1to1 -ExistingTextOnly -DestinationConfirmedDisposable `
  -Source '-100SOURCE' -Destinations '-100DEST_A'
```

Enter the TEST bot token and the Reader API ID/hash locally. This run uses its own `telegram-cloner-e2e-reader` session, not a Reader Manager session. Telethon may ask for a one-time login code if the E2E session does not exist. No token, hash or code belongs in chat. `E2E_EXISTING_TEXT_COPY_PASS` reports the original and destination message IDs; `E2E_EXISTING_TEXT_COPY_AUTOMATED_PASS` means the Bot API copy and durable local mapping succeeded. Manually open destination A and compare the copied text. This is a **copy-only smoke**, not a READY/fidelity or live catch-up gate.

## Quick 1→1 smoke gate (no Reader API credentials)

Use `-SmokeOnly` **only with a disposable source that has no learners**. This intentionally does **not** read or export the encrypted Reader Manager API hash/session. It uses only the dedicated TEST bot and a new plain-text source post.

The smoke script verifies that the supplied token belongs to `@yeubep_distributor_test_bot`. It then clears stale pending updates for that dedicated TEST bot, registers the disposable source against the isolated local DB, and waits for one new plain-text `channel_post` from the source through Bot API `getUpdates`. The captured real Telegram update is sent through the same local webhook handler/V2 event bridge, then the distributor performs an actual Telegram copy to destination A and drives the run to `READY_FOR_NEW`.

From PowerShell at repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/e2e-local/run.ps1 `
  -Mode 1to1 `
  -SmokeOnly -DisposableSourceConfirmed `
  -Source '-100SOURCE' `
  -Destinations '-100DEST_A'
```

Only the **TEST bot token** is prompted. When the harness prints `E2E_POST_SMOKE_MESSAGE_NOW`, post exactly one new plain-text message in the source test channel. The automated smoke gate ends with `E2E_SMOKE_DB_AND_BOT_WORKER_PASS` and `E2E_SMOKE_AUTOMATED_GATE_PASS mode=1to1`. Manually open destination A and confirm the new text appears there.

A smoke PASS proves the real TEST bot → Telegram update → local V2 event/index → Bot API copy → mapping/READY path for a new text post. It does **not** prove history import, albums, video media, hidden/literal link rewriting, pin parity, or Telethon read-only fidelity. Those remain the full E2E gate below.

## Telegram fixture for full E2E

Use one private source plus four private destinations:

- A: independent 1→1;
- B/C/D: concurrent 1→3.

The source should contain at least:

1. one text post;
2. one two-photo album sent as a single album;
3. one short video;
4. one TOC post with a literal direct link to the video, pinned;
5. one post with a hidden `text_link` pointing to an internal source post.

Use a dedicated test bot. Add it as admin to the source and all destinations with the permissions needed to post/edit/pin. The Reader Telegram user must be a member of all test channels. Do not use course content or learners.

## Full 1→1

From PowerShell at repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/e2e-local/run.ps1 `
  -Mode 1to1 `
  -Source '-100SOURCE' `
  -Destinations '-100DEST_A'
```

The full gate prompts locally for the **test bot token** and, if not already present in environment variables, the Reader API ID/hash. Do not paste bot tokens, OTPs, session strings or API hash into ChatGPT.

The harness keeps the generated local DB credentials and Reader variables in the same process and automatically runs `verify_telegram.py` immediately after the DB/Bot worker gate. Do not launch a second verifier command from a new PowerShell process.

The automated gate is PASS only after the output contains both the DB/Bot worker success marker and `E2E_TELEGRAM_READONLY_VERIFICATION_PASS`, followed by `E2E_AUTOMATED_GATE_PASS mode=1to1`. A manual Telegram-app check is still required: the short video must play and the rewritten TOC links must open inside destination A.

## 1→3 catch-up

For a real webhook without changing the Production webhook, expose only the local test server through a temporary HTTPS tunnel, for example Cloudflare Quick Tunnel:

```powershell
cloudflared tunnel --url http://127.0.0.1:8787
```

Use the temporary `https://...trycloudflare.com` URL returned by cloudflared:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/e2e-local/run.ps1 `
  -Mode 1to3 -DisposableSourceConfirmed `
  -Source '-100SOURCE' `
  -Destinations '-100DEST_B','-100DEST_C','-100DEST_D' `
  -PublicUrl 'https://TEMP.trycloudflare.com'
```

The harness sets the webhook only on the **test bot**. When it prints:

`E2E_POST_LATE_MESSAGE_NOW`

post exactly one new text message into the source test channel. The run waits for both the indexed source row and a durable `bot_webhook` event before continuing. The webhook is deleted from the test bot in the script's `finally` block.

The same `run.ps1` process automatically performs the read-only Telegram verification before cleanup. Pass requires all three runs to reach `READY_FOR_NEW`, Progress Center ledger to show no unresolved lag/block/retry, 3/3 Telegram destinations to pass read-only verification, `E2E_AUTOMATED_GATE_PASS mode=1to3`, and manual app checks of video/TOC on the destinations.

## What this does not authorize

A PASS here does **not** authorize applying migrations 010–016 to Supabase B Production, enabling the Production V2 queue/event bridge, changing `reader.yeubep.shop`, changing the Production Telegram webhook, activating destinations for learners, or merging PR #100 without owner confirmation. Those remain separate review gates.
