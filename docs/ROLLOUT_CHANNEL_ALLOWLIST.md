# Rollout: server-side channel allowlist (`READER_CHANNEL_ALLOWLIST`)

Two separate gates, each approved by the Owner. Claude does not merge, deploy, or change Vercel variables.

## What merging puts on Production

`main` already runs K-ISS (`081d37d`, Production deployment 2026-11-04 16:03Z,
`telegram-channel-cloner-ge92qep9y.vercel.app`). Merging PR #110 adds exactly these commits:

| Commit | Change |
|---|---|
| `d144576` | `lib/channel-allowlist.js`; checks in `register-source`, admin `source`/`v4-source`, webhook, Reader job queue/claim, `ingest`; `ARCHITECTURE.md` (server MTProto session); `.env.example` |
| `6c2f764` | `overrides` zod `^4.6.6`, ip-address `^10.7.4` (Dependabot #1–#6); `/api/health.channelAllowlist`; this doc |
| `105d113` | review fixes: check before switching the MASTER off; only Telegram's username is trusted; refused queued jobs set to `failed` |
| (this commit) | build check for a mistyped list; two-phase checklist |

With the variable **unset**, runtime behaviour is unchanged.

## Allowlist rules

- Applies to **source** channels only. Destination channels and `/api/telegram/media`, `/thumbnail` (LMS playback
  of indexed posts) are not checked.
- Entries: `-100…` ids, bare ids or `@usernames`, comma-separated.
- **A mistyped entry fails the build** (`scripts/verify-env.js`): Vercel keeps the previous deployment serving, so a
  wrong list never goes live (no silent drop of one channel, no silent "off"). `/api/health.channelAllowlist`
  shows `{enabled, entries, ignored}` (counts only, no ids).

---

## Phase 1: merge the code, allowlist OFF

Gate: Owner approves "Merge PR #110".

Before merge
- [ ] PR head = `origin/feat/server-channel-allowlist` = local HEAD.
- [ ] CI on the head commit: `validate`, CodeQL, Analyze (actions, javascript-typescript, python) = success.
  Vercel **Preview** fails on every branch (Preview has no secrets; `verify-env.js` stops it): expected.
- [ ] `READER_CHANNEL_ALLOWLIST` is **not** set in Vercel (any environment).
- [ ] Note the current Production deployment (`081d37d`, `ge92qep9y`) as the rollback target.

After merge (Production deployment of the merge commit is Ready)
- [ ] `GET https://reader.yeubep.shop/api/health` → `ok: true`, `environment: "production"`, all `configured.*: true`,
  `channelAllowlist: {"enabled": false, "entries": 0, "ignored": 0}`.
- [ ] Admin dashboard `https://reader.yeubep.shop/` login works.
- [ ] Reader Manager (Windows) shows the agent online; one small Reader job on a known channel completes.
- [ ] Webhook: Telegram `getWebhookInfo` for the Cloner bot → `last_error_message` empty, `pending_update_count`
  not growing; or one TEST post in a registered TEST source appears in `tgcloner_source_messages`.
- [ ] Dependabot alerts #1–#6 close on `main`.

Rollback Phase 1: Vercel → Deployments → `081d37d` (`ge92qep9y`) → Promote / Instant Rollback.
Verify: `/api/health` has **no** `channelAllowlist` field.

---

## Phase 2: turn the allowlist ON (after a full channel inventory)

Gate: Owner approves the channel list and "Enable allowlist".

Inventory (read-only, Supabase SQL editor on Production):

```sql
select s.chat_id, s.title, s.username, s.active, s.created_at,
       (select count(*) from tgcloner_source_messages m where m.source_id = s.id) as messages,
       (select max(m.created_at) from tgcloner_source_messages m where m.source_id = s.id) as last_message_at,
       (select count(*) from lms_v4_telegram_course_sources v where v.source_id = s.id) as v4_courses,
       (select count(*) from v5_source_mappings v where v.source_id = s.id) as v5_mappings,
       (select count(*) from tgcloner_reader_jobs j where j.source_id = s.id and j.status in ('queued','processing')) as open_jobs
from tgcloner_sources s
order by last_message_at desc nulls last;
```

- [ ] Keep every channel the Owner owns or may use; at minimum every row with `active = true`, `v4_courses > 0`,
  `v5_mappings > 0`, `open_jobs > 0`, or a recent `last_message_at`.
- [ ] Owner signs off the list (ids + titles). Expected count = N.

Enable
- [ ] Vercel → `telegram-channel-cloner` → Settings → Environment Variables → **Production**:
  `READER_CHANNEL_ALLOWLIST=-100…,-100…` (N entries).
- [ ] **Redeploy** the latest Production deployment (a variable change only applies after a redeploy).
  If the build fails with `READER_CHANNEL_ALLOWLIST: … neither a channel id …`, fix the value and redeploy;
  Production keeps serving the previous deployment meanwhile.

Verify
- [ ] `/api/health` → `channelAllowlist: {"enabled": true, "entries": N, "ignored": 0}`.
- [ ] One Reader job on an allowed channel completes; the MASTER still mirrors (one TEST post).
- [ ] `tgcloner_reader_jobs` has no new `failed` rows with `last_error = 'reader_channel_not_allowlisted'` for a
  channel that should be allowed.
- [ ] Optional: registering a channel outside the list returns `403 reader_channel_not_allowlisted`.

Rollback Phase 2: delete `READER_CHANNEL_ALLOWLIST` (Production) → **Redeploy** →
`/api/health.channelAllowlist.enabled: false`. Jobs closed as `reader_channel_not_allowlisted` are not re-queued
automatically: queue them again from the dashboard if needed.
