# REBUILD_FROM_TELEGRAM_EXPORT — TEST pilot

This path rebuilds a course from an operator-owned Telegram Desktop HTML export
and verified local backup bytes when the original Telegram channel remains
readable but has protected-content forwarding disabled.

## Safety boundary

- The protected source channel is never written by this workflow.
- No media is downloaded, forwarded, or copied from the protected source.
- Media bytes come only from the verified local backup paths in the signed
  `tgcloner.rebuild_from_telegram_export.v1` manifest.
- The pilot only permits the first 1 or 2 rebuild units.
- The destination must be a separate TEST channel controlled by the owner.
- The selected Reader user must be admin/creator of that TEST destination.
- A first-run destination must contain no visible content.
- A local ledger is armed before each Telegram send. If the process ends while
  armed, blind retry is blocked until the destination is reconciled.
- Re-running a successful unit verifies and reuses the recorded destination
  message IDs instead of sending a duplicate.

## Owner-verified fixture

Protected source: `-1002049524573`.

The owner-side backup and read-only source audits established:

- 28 source messages, IDs 2..29;
- 24 verified local media files: 11 video + 13 photo;
- no missing or unsafe backup paths;
- 8 exact Telegram albums:
  `2,3`, `4,5`, `7,8`, `9,10`, `12,13`,
  `17,18,19,20,21`, `22,23,24,25`, `27,28,29`;
- 14 rebuild units;
- manifest SHA-256
  `2763b1ad6f7e26d4839844c0b387bcf54dc93bbef82b95604d03e6d635a33330`.

## Pilot usage

Preflight (no Telegram write):

```powershell
.\scripts\rebuild-export\run-test-pilot.ps1 \
  -Manifest "$env:LOCALAPPDATA\YeuNauAnReader\RebuildManifests\banh-bo-re-tre-mien-tay.rebuild-manifest.v1.json" \
  -DestinationTitle "REBUILD TEST - Banh Bo Re Tre" \
  -ProfileName "Reader Ngo Bi" \
  -MaxUnits 1
```

Publish exactly the first unit only after preflight passes:

```powershell
.\scripts\rebuild-export\run-test-pilot.ps1 \
  -Manifest "$env:LOCALAPPDATA\YeuNauAnReader\RebuildManifests\banh-bo-re-tre-mien-tay.rebuild-manifest.v1.json" \
  -DestinationTitle "REBUILD TEST - Banh Bo Re Tre" \
  -ProfileName "Reader Ngo Bi" \
  -MaxUnits 1 \
  -Publish
```

The wrapper requires the operator to type `PUBLISH-TEST` before any destination
write. Do not run full-course rebuild from this pilot.
