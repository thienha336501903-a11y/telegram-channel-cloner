# REBUILD_FROM_TELEGRAM_EXPORT — local TEST pilot

This path rebuilds an owner-controlled Telegram course from a previously exported
local backup. It does **not** download, forward, copy, or otherwise retrieve media
bytes from a protected source channel.

## Verified fixture

The initial fixture is the protected source `-1002049524573`, with a locally
verified manifest containing 28 source posts, 24 local media files, eight exact
Telegram albums and six single-message units. The manifest is generated outside
the repository and its SHA-256 is verified before any destination operation.

## Safety boundary

- Source Telegram is not opened by the uploader.
- All media bytes must match the size and SHA-256 recorded in the manifest.
- Destination must be a broadcast channel visible to a configured Reader profile
  that has creator/post-message rights.
- A destination with visible messages not owned by the local rebuild ledger is
  rejected.
- Dry-run is the default.
- `--publish` is explicit and the first pilot is capped at one or two units.
- Links and replies are rejected in this first pilot; there is no silent
  fidelity downgrade.
- Before a send, the unit is persisted as `armed`. If the outcome is ambiguous,
  the state remains inflight and blind retry is blocked.
- Successful destination message IDs are verified live and recorded locally.
  A rerun verifies and reuses completed units instead of posting them again.
- No Supabase, Vercel, Production Distributor V2, System A, or protected-source
  mutation is part of this pilot.

## Windows

Dry-run:

```powershell
.\reader-cli\rebuild_from_export_windows.ps1 \
  -Manifest "$env:LOCALAPPDATA\YeuNauAnReader\RebuildManifests\banh-bo-re-tre-mien-tay.rebuild-manifest.v1.json" \
  -DestinationTitle "TEST REBUILD BÁNH BÒ RỄ TRE" \
  -MaxUnits 2
```

Only after the dry-run is reviewed, repeat with `-Publish`.

The TEST destination should be newly created and empty. Add the intended Reader
account as an administrator with permission to post messages before running the
pilot.
