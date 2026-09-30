param(
  [Parameter(Mandatory=$true)][ValidateSet('1to1','1to3')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string[]]$Destinations,
  [string]$PublicUrl = ''
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Compose = Join-Path $PSScriptRoot 'docker-compose.yml'

if ($Mode -eq '1to1' -and $Destinations.Count -ne 1) { throw 'Mode 1to1 requires exactly one destination.' }
if ($Mode -eq '1to3' -and $Destinations.Count -ne 3) { throw 'Mode 1to3 requires exactly three destinations.' }
if ($Mode -eq '1to3' -and -not $PublicUrl) { throw 'Mode 1to3 requires -PublicUrl from a temporary tunnel so the TEST bot can deliver the late-post webhook.' }

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-PsqlFile([string]$Path) {
  Get-Content -Raw $Path | docker exec -i tgcloner-e2e-db psql -U postgres -d postgres -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $Path" }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop/docker CLI is required.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python is required.' }

$env:TELEGRAM_BOT_TOKEN = Read-PlainSecret 'Dán token của BOT TEST (không phải bot Production)'
if (-not $env:TELEGRAM_API_ID) { $env:TELEGRAM_API_ID = Read-Host 'TELEGRAM_API_ID của tài khoản Reader test' }
if (-not $env:TELEGRAM_API_HASH) { $env:TELEGRAM_API_HASH = Read-PlainSecret 'TELEGRAM_API_HASH của tài khoản Reader test' }
$env:READER_INGEST_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:TELEGRAM_WEBHOOK_SECRET = [guid]::NewGuid().ToString('N')
$env:SUPABASE_URL = 'http://127.0.0.1:54321'
$env:SUPABASE_SECRET_KEY = 'sb_secret_local_e2e_only_not_a_real_secret'
$env:TGCLONER_READER_NO_SOURCE_MUTATION = 'true'
$env:DISTRIBUTOR_V2_EVENT_BRIDGE_ENABLED = 'true'
$env:E2E_SOURCE_CHAT_ID = $Source
$env:E2E_DESTINATION_CHAT_IDS = ($Destinations -join ',')
$env:E2E_WAIT_FOR_LATE_POST = if ($Mode -eq '1to3') { 'true' } else { 'false' }
$env:E2E_PUBLIC_URL = $PublicUrl.TrimEnd('/')

Push-Location $RepoRoot
$server = $null
try {
  docker compose -f $Compose down -v --remove-orphans | Out-Null
  docker compose -f $Compose up -d db | Out-Null
  for ($i=0; $i -lt 40; $i++) {
    docker exec tgcloner-e2e-db pg_isready -U postgres -d postgres *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Milliseconds 500
    if ($i -eq 39) { throw 'Local PostgreSQL did not become ready.' }
  }

  Invoke-PsqlFile (Join-Path $PSScriptRoot 'bootstrap.sql')
  Invoke-PsqlFile (Join-Path $RepoRoot 'sql\002_shared_supabase_tgcloner_schema.sql')
  foreach ($n in 10..16) {
    $file = Get-ChildItem (Join-Path $RepoRoot 'sql') -Filter (('{0:D3}_*.sql' -f $n)) | Select-Object -First 1
    if (-not $file) { throw "Missing migration $n" }
    Invoke-PsqlFile $file.FullName
  }
  Invoke-PsqlFile (Join-Path $PSScriptRoot 'permissions.sql')
  docker compose -f $Compose up -d postgrest | Out-Null
  Start-Sleep -Seconds 2

  $server = Start-Process node -ArgumentList @('scripts/e2e-local/server.mjs') -WorkingDirectory $RepoRoot -NoNewWindow -PassThru
  Start-Sleep -Seconds 1
  if ($server.HasExited) { throw 'Local E2E HTTP server exited during startup.' }

  if ($PublicUrl) {
    node scripts/e2e-local/set-webhook.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Could not set TEST bot webhook.' }
  }

  Write-Host 'Importing source history into isolated local DB. If Telethon asks for login/OTP, complete it locally; do not paste OTP into ChatGPT.'
  python reader-cli/export_history.py --channel $Source --cloner-url http://127.0.0.1:8787 --ingest-secret $env:READER_INGEST_SECRET --session telegram-cloner-e2e-reader
  if ($LASTEXITCODE -ne 0) { throw 'Reader import failed.' }

  node scripts/e2e-local/run-distributor.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Distributor E2E worker failed.' }

  Write-Host 'DB + Bot API worker gate finished. Run verify_telegram.py next for read-only Telegram content verification.'
}
finally {
  if ($PublicUrl -and $env:TELEGRAM_BOT_TOKEN) {
    try { node scripts/e2e-local/set-webhook.mjs --delete | Out-Null } catch {}
  }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Pop-Location
}
