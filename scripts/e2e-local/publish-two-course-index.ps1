param([switch]$Publish, [switch]$AfterOne, [switch]$UpdateExisting)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dbName = 'tgcloner-e2e-1to2-db'
if (-not $AfterOne) { throw 'This path is only for the verified 61-post/H=62 TEST state; add -AfterOne.' }
if ($UpdateExisting -and -not $Publish) { throw '-UpdateExisting requires -Publish.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue) -or -not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw 'Docker, Node.js and Python are required on the retained Windows TEST machine.'
}

$labelsJson = docker inspect --format '{{json .Config.Labels}}' $dbName
if ($LASTEXITCODE -ne 0) { throw 'Retained isolated DB is missing. Do not reset or recreate it.' }
$labels = $labelsJson | ConvertFrom-Json
$project = $labels.PSObject.Properties['com.docker.compose.project']
if (-not $project -or [string]$project.Value -ne 'tgcloner-e2e-1to2') { throw 'Unrecognized Docker container.' }
docker exec $dbName pg_isready -U postgres -d postgres *> $null
if ($LASTEXITCODE -ne 0) { throw 'Start the retained DB container without recreating it.' }

function Read-PlainSecret([string]$PromptText) {
  $secure = Read-Host $PromptText -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Push-Location $repoRoot
try {
  if (-not $Publish) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\e2e-local\preview-two-course-index.ps1 -AfterOne
    if ($LASTEXITCODE -ne 0) { throw 'Two-destination index preview failed.' }
    return
  }

  $backupDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'YeuNauAnReader\E2EBackups'
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $backupPath = Join-Path $backupDir ('before-1to2-index-publish-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump')
  docker exec $dbName pg_dump -U postgres -d postgres -Fc -f /tmp/tgcloner-e2e-1to2-before-index.dump
  if ($LASTEXITCODE -ne 0) { throw 'Could not checkpoint the retained TEST DB; no migration or Telegram write started.' }
  docker cp "${dbName}:/tmp/tgcloner-e2e-1to2-before-index.dump" $backupPath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $backupPath)) { throw 'Could not save the TEST DB checkpoint.' }
  Write-Host "E2E_1TO2_INDEX_DB_CHECKPOINT $backupPath"

  Get-Content -Raw (Join-Path $repoRoot 'sql\017_distributor_v2_destination_course_index_pin.sql') |
    docker exec -i $dbName psql -U postgres -d postgres -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw 'Migration 017 failed in the retained TEST DB; no Telegram index write started.' }
  Write-Host 'E2E_1TO2_INDEX_MIGRATION_017_PASS'

  python scripts/e2e-local/audit-two-writers.py --require-clean --after-one --allow-registered-index
  if ($LASTEXITCODE -ne 0) { throw 'Post-migration read-only reconciliation failed; no Telegram index write started.' }

  Remove-Item Env:TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
  $env:TELEGRAM_BOT_TOKEN = Read-PlainSecret 'Dán token @yeubep_distributor_test_bot (chỉ bot TEST)'
  $env:E2E_1TO2_INDEX_STATE_DIR = Join-Path $backupDir 'course-index-1to2'
  $nodeArgs = @('scripts/e2e-local/publish-two-course-index.mjs', '--after-one', '--publish')
  if ($UpdateExisting) { $nodeArgs += '--update-existing' }
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw '1to2 index publish/update stopped. Preserve DB/channels/state and do not blindly retry an ambiguous send.' }
}
finally {
  Remove-Item Env:TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:E2E_1TO2_INDEX_STATE_DIR -ErrorAction SilentlyContinue
  Pop-Location
}
