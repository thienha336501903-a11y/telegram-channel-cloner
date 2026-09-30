# Distributor V2 — Real Telegram E2E harness

This harness is for **System B test channels only**. It never uses Supabase B Production, the Production bot/webhook, `reader.yeubep.shop`, learner data, or System A.

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

The script sets `TGCLONER_READER_NO_SOURCE_MUTATION=true`. If Reader media metadata is not sufficient, ingestion fails instead of using the legacy self-forward/delete hydration path. The V2 webhook bridge is also opt-in through `DISTRIBUTOR_V2_EVENT_BRIDGE_ENABLED=true`; Production remains unchanged unless a later rollout explicitly enables it after migrations/review.

## Telegram fixture

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

## 1→1

From PowerShell at repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/e2e-local/run.ps1 `
  -Mode 1to1 `
  -Source '-100SOURCE' `
  -Destinations '-100DEST_A'
```

The script prompts locally for the **test bot token** and, if not already present in environment variables, the Reader API ID/hash. Do not paste bot tokens, OTPs, session strings or API hash into ChatGPT.

After `E2E_DB_AND_BOT_WORKER_PASS`, run the read-only verifier in the same PowerShell session/environment:

```powershell
python scripts/e2e-local/verify_telegram.py
```

The gate is PASS only after both `E2E_DB_AND_BOT_WORKER_PASS` and `E2E_TELEGRAM_READONLY_VERIFICATION_PASS` are present, plus a manual Telegram-app check that the short video plays and the TOC links open inside destination A.

## 1→3 catch-up

For a real webhook without changing the Production webhook, expose only the local test server through a temporary HTTPS tunnel, for example Cloudflare Quick Tunnel:

```powershell
cloudflared tunnel --url http://127.0.0.1:8787
```

Use the temporary `https://...trycloudflare.com` URL returned by cloudflared:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/e2e-local/run.ps1 `
  -Mode 1to3 `
  -Source '-100SOURCE' `
  -Destinations '-100DEST_B','-100DEST_C','-100DEST_D' `
  -PublicUrl 'https://TEMP.trycloudflare.com'
```

The harness sets the webhook only on the **test bot**. When it prints:

`E2E_POST_LATE_MESSAGE_NOW`

post exactly one new text message into the source test channel. The run waits for both the indexed source row and a durable `bot_webhook` event before continuing. The webhook is deleted from the test bot in the script's `finally` block.

Then run:

```powershell
python scripts/e2e-local/verify_telegram.py
```

Pass requires all three runs to reach `READY_FOR_NEW`, Progress Center ledger to show no unresolved lag/block/retry, 3/3 Telegram destinations to pass read-only verification, and manual app checks of video/TOC on the destinations.

## What this does not authorize

A PASS here does **not** authorize applying migrations 010–016 to Supabase B Production, enabling the Production V2 queue/event bridge, changing `reader.yeubep.shop`, changing the Production Telegram webhook, activating destinations for learners, or merging PR #100 without owner confirmation. Those remain separate review gates.
