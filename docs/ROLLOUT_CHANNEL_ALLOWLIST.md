# Rollout: server-side channel allowlist (`READER_CHANNEL_ALLOWLIST`)

Owner approves each step. Claude does not merge, deploy, or change Vercel variables.

## What merging changes on Production

`main` already runs K-ISS (`081d37d`, Production deployment 2026-11-04). Merging this PR adds only:

- `lib/channel-allowlist.js` and its checks in `register-source`, admin `source`/`v4-source`, webhook, Reader job queue/claim and `ingest`;
- `channelAllowlist` counts in `/api/health`;
- dependency overrides `zod ^4.6.6`, `ip-address ^10.7.4` (Dependabot #1–#6);
- docs.

With the variable **unset**, behaviour is unchanged: every check returns "allowed".

## Scope of the allowlist

- Applies to **source** channels (the channels the Reader reads). Destination channels are not checked.
- Not checked: `/api/telegram/media` and `/thumbnail` (LMS playback of already-indexed posts keeps working).
- Entries: `-100…` ids, bare ids or `@usernames`, comma-separated. Entries that are neither are ignored and counted
  in `/api/health` → `channelAllowlist.ignored`. If no entry is valid, the restriction stays **off** (never locks all).

## Checklist

1. **Before merge.** CI `validate`, CodeQL green on the PR. Vercel Preview fails on every branch (Preview has no
   secrets, `scripts/verify-env.js` stops the build): expected, not caused by this PR.
2. **Merge** (Owner). Wait for the Production deployment, then:
   `GET https://reader.yeubep.shop/api/health` → `ok: true`, `channelAllowlist: {"enabled": false, ...}`.
   Note the new deployment URL, and the previous one (`telegram-channel-cloner-ge92qep9y.vercel.app`, `081d37d`).
3. **Build the list** (read-only, Supabase SQL editor on Production):

   ```sql
   select s.chat_id, s.title, s.username, s.active, s.created_at,
          (select count(*) from tgcloner_source_messages m where m.source_id = s.id) as messages,
          (select max(m.created_at) from tgcloner_source_messages m where m.source_id = s.id) as last_message_at,
          (select count(*) from lms_v4_telegram_course_sources v where v.source_id = s.id) as v4_courses,
          (select count(*) from v5_source_mappings v where v.source_id = s.id) as v5_mappings
   from tgcloner_sources s
   order by last_message_at desc nulls last;
   ```

   Keep every channel the Owner owns or may use, at least every row with `v4_courses > 0`, `v5_mappings > 0` or a
   recent `last_message_at`. Anything left out stops receiving live posts and Reader jobs.
4. **Set the variable** in Vercel → Project `telegram-channel-cloner` → Settings → Environment Variables →
   Production: `READER_CHANNEL_ALLOWLIST=-100…,-100…`. **A Vercel variable change only takes effect after a
   redeploy**: Deployments → latest Production → Redeploy.
5. **Verify** after the redeploy:
   - `/api/health` → `channelAllowlist.enabled: true`, `entries` = the number of ids set, `ignored: 0`;
   - Reader Manager: one Reader job on an allowed channel completes;
   - optional: registering a channel outside the list returns `403 reader_channel_not_allowlisted`.

## Rollback (verifiable)

- **Turn the allowlist off:** delete `READER_CHANNEL_ALLOWLIST` (or set it empty) in Vercel Production, then
  **Redeploy**. Check `/api/health` → `channelAllowlist.enabled: false`.
- **Undo the code:** Vercel → Deployments → the previous Production deployment (`081d37d`,
  `telegram-channel-cloner-ge92qep9y.vercel.app`) → Promote / Instant Rollback. Check `/api/health` no longer has a
  `channelAllowlist` field.
