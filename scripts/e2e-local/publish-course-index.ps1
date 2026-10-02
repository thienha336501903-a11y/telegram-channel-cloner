param(
  [switch]$Publish,
  [long]$AppendixStartSourceId = 0
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($AppendixStartSourceId -lt 0) { throw 'AppendixStartSourceId must be a source message ID or zero.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue) -or -not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js and Docker Desktop are required on the same Windows machine as the retained 53-post E2E database.'
}
docker exec tgcloner-e2e-db pg_isready -U postgres -d postgres *> $null
if ($LASTEXITCODE -ne 0) { throw 'Local E2E database is unavailable; open Docker Desktop. Do not reset or recopy the course.' }

function Read-PlainSecret([string]$promptText) {
  $secure = Read-Host $promptText -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$env:E2E_INDEX_APPENDIX_START = [string]$AppendixStartSourceId
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$env:E2E_INDEX_STATE_PATH = Join-Path $localAppData 'YeuNauAnReader\E2EBackups\course-index--1004492904064.json'
Push-Location $repoRoot
try {
  if ($Publish) {
    # Always prompt locally. Never reuse a Production token from this shell.
    Remove-Item Env:TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
    $env:TELEGRAM_BOT_TOKEN = Read-PlainSecret 'Dán token @yeubep_distributor_test_bot (chỉ bot TEST)'
    node scripts/e2e-local/publish-course-index.mjs --publish
  }
  else {
    node scripts/e2e-local/publish-course-index.mjs
  }
  if ($LASTEXITCODE -ne 0) { throw 'Index preview/publish stopped. Preserve the local DB and state; do not blindly retry an ambiguous send.' }
}
finally {
  Remove-Item Env:TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:E2E_INDEX_APPENDIX_START -ErrorAction SilentlyContinue
  Remove-Item Env:E2E_INDEX_STATE_PATH -ErrorAction SilentlyContinue
  Pop-Location
}
