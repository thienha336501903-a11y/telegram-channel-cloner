# Register the owner-verified pinned TEST index in the retained local V2 DB.
# No Telegram send/edit/pin, source write, Production call, or Docker reset.
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$expectedRun = '023c3197-fe64-4ddf-9229-2632a2fad4a9'
$expectedSource = '-1003535777660'
$expectedDestination = '-1004492904064'
$backupDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'YeuNauAnReader\E2EBackups'
$ledger = Join-Path $backupDir 'course-index--1004492904064.json'
if (-not (Test-Path -LiteralPath $ledger)) { throw 'Existing TEST index ledger is missing. No migration applied.' }
$indexState = Get-Content -Raw -LiteralPath $ledger | ConvertFrom-Json
if ($indexState.version -ne 1 -or $indexState.runId -ne $expectedRun -or
    $indexState.sourceChatId -ne $expectedSource -or $indexState.destinationChatId -ne $expectedDestination -or
    $indexState.phase -ne 'published' -or $indexState.messageId -ne 67 -or
    $indexState.contentHash -ne 'c4b195a11bfeaeae5b8860f1b68bb4bd27d8d4df8482f3e127d52aa58793d61d') {
  throw 'Existing TEST index ledger does not match the owner-verified message #67. No migration applied.'
}
docker exec tgcloner-e2e-db pg_isready -U postgres -d postgres *> $null
if ($LASTEXITCODE -ne 0) { throw 'Retained local DB is unavailable. Open Docker Desktop; do not reset it.' }

$identitySql = "select count(*) from public.tgcloner_clone_runs r join public.tgcloner_sources s on s.id=r.source_id join public.tgcloner_destinations d on d.id=r.destination_id where r.id='$expectedRun'::uuid and s.chat_id='$expectedSource' and d.chat_id='$expectedDestination' and not s.active and not d.active and r.status='active' and r.manifest_closed_at is not null and r.snapshot_high_watermark=56"
$identity = @(docker exec tgcloner-e2e-db psql -U postgres -d postgres -X -A -t -v ON_ERROR_STOP=1 -c $identitySql)
if ($LASTEXITCODE -ne 0 -or $identity.Count -ne 1 -or $identity[0].Trim() -ne '1') {
  throw 'Retained TEST DB identity does not match the verified 53-post run. No migration applied.'
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$containerDump = "/tmp/tgcloner-before-index-pin-$stamp.dump"
$backup = Join-Path $backupDir "before-index-pin-$stamp.dump"
docker exec tgcloner-e2e-db pg_dump -U postgres -d postgres -Fc -f $containerDump
if ($LASTEXITCODE -ne 0) { throw 'Local DB checkpoint failed. No migration applied.' }
try {
  docker cp "tgcloner-e2e-db`:$containerDump" $backup
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $backup)) { throw 'Local DB checkpoint copy failed. No migration applied.' }
}
finally { docker exec tgcloner-e2e-db rm -f $containerDump *> $null }
Write-Host "E2E_LOCAL_DB_CHECKPOINT $backup"

$migration = Join-Path $repoRoot 'sql\017_distributor_v2_destination_course_index_pin.sql'
Get-Content -Raw -LiteralPath $migration | docker exec -i tgcloner-e2e-db psql -U postgres -d postgres -X -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'Local migration 017 failed. Keep the checkpoint and do not run the old clone command.' }
docker exec tgcloner-e2e-db psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -c "NOTIFY pgrst, 'reload schema';" *> $null
if ($LASTEXITCODE -ne 0) { throw 'Local schema cache refresh failed. Index registration has not started.' }

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'publish-course-index.ps1') -RegisterOnly
if ($LASTEXITCODE -ne 0) { throw 'Existing TEST pin was not registered. It was not reposted; preserve the DB and ledger.' }
