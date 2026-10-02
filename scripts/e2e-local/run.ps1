param(
  [Parameter(Mandatory=$true)][ValidateSet('1to1','1to3')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string[]]$Destinations,
  [string]$PublicUrl = '',
  [switch]$SmokeOnly,
  [Alias('ExistingTextOnly')][switch]$ExistingPostOnly,
  [ValidateRange(1,5)][int]$ExistingPostsLimit = 1,
  [switch]$CoursePrefix,
  [switch]$InspectCourseOnly,
  [switch]$RepairKnownTestCopies,
  [switch]$DestinationConfirmedEmpty,
  [long]$SkipSourceMessageId = 0,
  [switch]$DisposableSourceConfirmed,
  [switch]$DestinationConfirmedDisposable,
  [string]$ExpectedBotUsername = 'yeubep_distributor_test_bot'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Compose = Join-Path $PSScriptRoot 'docker-compose.yml'

if ($Mode -eq '1to1' -and $Destinations.Count -ne 1) { throw 'Mode 1to1 requires exactly one destination.' }
if ($Mode -eq '1to3' -and $Destinations.Count -ne 3) { throw 'Mode 1to3 requires exactly three destinations.' }
if ($Mode -eq '1to3' -and -not $PublicUrl) { throw 'Mode 1to3 requires -PublicUrl from a temporary tunnel so the TEST bot can deliver the late-post webhook.' }
if ($SmokeOnly -and $Mode -ne '1to1') { throw 'SmokeOnly supports Mode 1to1 only.' }
if ($SmokeOnly -and $ExistingPostOnly) { throw 'Choose either -SmokeOnly or -ExistingPostOnly.' }
if ($ExistingPostOnly -and ($Mode -ne '1to1' -or $PublicUrl)) { throw 'ExistingPostOnly supports Mode 1to1 without a webhook tunnel.' }
if (($SmokeOnly -or $Mode -eq '1to3') -and -not $DisposableSourceConfirmed) { throw 'This mode asks for a new post. Use only a disposable source and add -DisposableSourceConfirmed, or use -ExistingPostOnly.' }
if ($ExistingPostOnly -and -not $DestinationConfirmedDisposable) { throw 'ExistingPostOnly copies old posts to a destination. Confirm that it has no learners with -DestinationConfirmedDisposable.' }
if ($InspectCourseOnly -and ($Mode -ne '1to1' -or $ExistingPostOnly -or $SmokeOnly -or $CoursePrefix -or $SkipSourceMessageId -ne 0 -or $ExistingPostsLimit -ne 1)) { throw 'InspectCourseOnly reads source/destination history in 1to1 mode without copy switches.' }
if ($CoursePrefix -and -not $ExistingPostOnly) { throw 'CoursePrefix requires -ExistingPostOnly.' }
if (($RepairKnownTestCopies -or $DestinationConfirmedEmpty) -and -not $CoursePrefix) { throw 'The repair/empty-destination flags require -CoursePrefix.' }
if ($RepairKnownTestCopies -and $DestinationConfirmedEmpty) { throw 'Choose exactly one destination preparation mode.' }
if ($CoursePrefix -and -not ($RepairKnownTestCopies -or $DestinationConfirmedEmpty)) { throw 'CoursePrefix requires verified cleanup of the known TEST copies or a confirmed empty new destination.' }
if ($CoursePrefix -and $Destinations[0].Trim() -eq '-1004492904064' -and -not $RepairKnownTestCopies) { throw 'This known TEST destination already has five out-of-order copies; use -RepairKnownTestCopies so the exact mappings are checked before removal.' }
if ($RepairKnownTestCopies -and ($Source.Trim() -ne '-1003535777660' -or $Destinations[0].Trim() -ne '-1004492904064' -or $ExistingPostsLimit -gt 5)) { throw 'Known TEST repair is restricted to the documented source, destination and at most five posts.' }
if ($SkipSourceMessageId -ne 0) { throw 'The earlier skip/recent copy mode did not preserve course order. Reconcile and remove its exact destination copies first; then use -CoursePrefix.' }
if ($ExistingPostsLimit -gt 1 -and -not $CoursePrefix) { throw 'Multi-post copy requires -CoursePrefix to preserve the first lessons in source order.' }
if (-not $ExistingPostOnly -and ($ExistingPostsLimit -ne 1 -or $SkipSourceMessageId -ne 0)) { throw 'ExistingPostsLimit and SkipSourceMessageId require -ExistingPostOnly.' }
if ($SkipSourceMessageId -lt 0) { throw 'SkipSourceMessageId must be non-negative.' }
if (@($Destinations | Where-Object { $_.Trim() -eq $Source.Trim() }).Count -gt 0) { throw 'Source and destination must differ; refusing to post into the source channel.' }
if ($ExpectedBotUsername.TrimStart('@').ToLowerInvariant() -ne 'yeubep_distributor_test_bot') { throw 'This harness requires @yeubep_distributor_test_bot.' }

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Import-LocalReaderApiCredentials {
  if ($env:TELEGRAM_API_ID -and $env:TELEGRAM_API_HASH) { return }

  # Reader Manager stores only this machine's configuration under the current
  # Windows user's DPAPI key. Extract the app ID/hash, never its agent token or
  # Telegram StringSession; this E2E uses a separate local Telethon session.
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('LocalApplicationData') }
  $managerData = Join-Path (Join-Path $localAppData 'YeuNauAnReader') 'reader-manager.dat'
  if (Test-Path -LiteralPath $managerData) {
    $env:TGCLONER_E2E_READER_MANAGER_DIR = Join-Path $RepoRoot 'reader-manager'
    try {
      $readCredentials = @'
import json, os, sys
sys.path.insert(0, os.environ['TGCLONER_E2E_READER_MANAGER_DIR'])
from reader_manager_storage import load_config
config = load_config()
print(json.dumps({'api_id': str(config.get('telegram_api_id') or ''), 'api_hash': str(config.get('telegram_api_hash') or '')}))
'@
      $rawCredentials = & python -c $readCredentials
      if ($LASTEXITCODE -ne 0) { throw 'Reader Manager DPAPI could not be decrypted by this Windows user.' }
      $credentials = $rawCredentials | ConvertFrom-Json
      if ([string]$credentials.api_id -match '^\d+$' -and [string]$credentials.api_hash -match '^[0-9a-fA-F]{32}$') {
        $env:TELEGRAM_API_ID = [string]$credentials.api_id
        $env:TELEGRAM_API_HASH = [string]$credentials.api_hash
        Write-Host 'E2E_READER_API_CREDENTIALS_LOADED source=local_reader_manager'
        return
      }
    }
    catch { Write-Warning 'Cannot read local Reader Manager API credentials for this Windows user.' }
    finally { Remove-Item Env:TGCLONER_E2E_READER_MANAGER_DIR -ErrorAction SilentlyContinue }
  }

  # Older Reader CLI saves the same app credentials with ConvertFrom-SecureString.
  # Its Production ingest secret is deliberately not read for the isolated E2E.
  $legacyPath = Join-Path $RepoRoot 'reader-cli\.reader-windows-secrets.json'
  if (Test-Path -LiteralPath $legacyPath) {
    try {
      $saved = Get-Content -Raw -LiteralPath $legacyPath | ConvertFrom-Json
      $id = [string]$saved.telegram_api_id
      $hash = Read-PlainSecretFromDpapi ([string]$saved.telegram_api_hash_dpapi)
      if ($id -match '^\d+$' -and $hash -match '^[0-9a-fA-F]{32}$') {
        $env:TELEGRAM_API_ID = $id
        $env:TELEGRAM_API_HASH = $hash
        Write-Host 'E2E_READER_API_CREDENTIALS_LOADED source=local_reader_cli'
        return
      }
    }
    catch { Write-Warning 'Cannot read legacy Reader CLI API credentials for this Windows user.' }
  }
}

function Read-PlainSecretFromDpapi([string]$EncryptedValue) {
  $secure = ConvertTo-SecureString -String $EncryptedValue
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-PsqlFile([string]$Path) {
  Get-Content -Raw $Path | docker exec -i tgcloner-e2e-db psql -U postgres -d postgres -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $Path" }
}

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally { $listener.Stop() }
}

function Wait-PostgrestSchema {
  # Migrations 010-016 alter tables/functions that PostgREST caches. Force a
  # schema refresh after startup, then prove the V2 settings column is queryable
  # directly at PostgREST's root path before starting any Telegram side effects.
  docker exec tgcloner-e2e-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "NOTIFY pgrst, 'reload schema';" *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Could not request PostgREST schema reload.' }

  # A restart is cheap in the disposable local harness and guarantees a fresh
  # cache even if the LISTEN subscription was not ready when NOTIFY was sent.
  docker restart tgcloner-e2e-rest | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Local PostgREST container did not restart.' }

  $lastError = ''
  for ($i=0; $i -lt 30; $i++) {
    try {
      $probe = Invoke-WebRequest -UseBasicParsing `
        -Uri "http://127.0.0.1:$($env:E2E_POSTGREST_PORT)/tgcloner_settings?select=distributor_v2_enabled&limit=1" `
        -Headers @{ apikey = $env:SUPABASE_SECRET_KEY } `
        -TimeoutSec 2
      if ($probe.StatusCode -eq 200) {
        Write-Host 'POSTGREST_V2_SCHEMA_READY'
        return
      }
    }
    catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }
  throw "PostgREST V2 schema cache did not become ready. Last error: $lastError"
}

if (-not $InspectCourseOnly -and -not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop/docker CLI is required.' }
if (-not $InspectCourseOnly -and -not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
if (-not $SmokeOnly -and -not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python is required for full Telegram E2E.' }

Remove-Item Env:TELEGRAM_SESSION_STRING -ErrorAction SilentlyContinue
if (-not $SmokeOnly) {
  Import-LocalReaderApiCredentials
  if (-not $env:TELEGRAM_API_ID) { $env:TELEGRAM_API_ID = Read-Host 'Telegram app API ID từ my.telegram.org (không phải bot token)' }
  if (-not $env:TELEGRAM_API_HASH) { $env:TELEGRAM_API_HASH = Read-PlainSecret 'Telegram app API hash từ my.telegram.org' }
  if ($env:TELEGRAM_API_ID -notmatch '^\d+$' -or $env:TELEGRAM_API_HASH -notmatch '^[0-9a-fA-F]{32}$') {
    throw 'Invalid Telegram app API ID/hash. They must come from my.telegram.org or the encrypted local Reader configuration.'
  }
}
if ($InspectCourseOnly) {
  Push-Location $RepoRoot
  try {
    python scripts/e2e-local/inspect-course.py --source $Source --destination $Destinations[0] --limit 5
    if ($LASTEXITCODE -ne 0) { throw 'Read-only course inspection failed.' }
    if (Get-Command docker -ErrorAction SilentlyContinue) {
      docker exec tgcloner-e2e-db pg_isready -U postgres -d postgres *> $null
      if ($LASTEXITCODE -eq 0) {
        $destChat = $Destinations[0].Trim()
        if ($destChat -notmatch '^-100\d+$') { throw 'Destination channel ID must be numeric for local mapping inspection.' }
        $sql = "select m.source_message_id, m.destination_message_id, m.status from public.tgcloner_message_mappings m join public.tgcloner_destinations d on d.id=m.destination_id where d.chat_id='$destChat' order by m.destination_message_id;"
        docker exec tgcloner-e2e-db psql -U postgres -d postgres -P pager=off -c $sql
        if ($LASTEXITCODE -ne 0) { throw 'Could not read local E2E mappings.' }
      }
      else { Write-Host 'E2E_LOCAL_DB_UNAVAILABLE; paste the previous copy log instead of rerunning.' }
    }
  }
  finally { Pop-Location }
  return
}
if ($CoursePrefix) {
  Push-Location $RepoRoot
  try {
    python scripts/e2e-local/inspect-course.py --source $Source --destination $Destinations[0] --limit $ExistingPostsLimit --require-ready
    if ($LASTEXITCODE -ne 0) { throw 'Course preflight blocked copy. Do not retry until the reported issue is reconciled.' }
  }
  finally { Pop-Location }
}
$env:TELEGRAM_BOT_TOKEN = Read-PlainSecret 'Dán token của BOT TEST (không phải bot Production)'
$env:READER_INGEST_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:TELEGRAM_WEBHOOK_SECRET = [guid]::NewGuid().ToString('N')
$env:SUPABASE_URL = 'http://127.0.0.1:8787'
$env:SUPABASE_SECRET_KEY = 'sb_secret_' + [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:TGCLONER_READER_NO_SOURCE_MUTATION = 'true'
$env:DISTRIBUTOR_V2_EVENT_BRIDGE_ENABLED = 'true'
$env:E2E_SOURCE_CHAT_ID = $Source
$env:E2E_DESTINATION_CHAT_IDS = ($Destinations -join ',')
$env:E2E_WAIT_FOR_LATE_POST = if ($Mode -eq '1to3') { 'true' } else { 'false' }
$env:E2E_PUBLIC_URL = $PublicUrl.TrimEnd('/')
$env:E2E_SMOKE_ONLY = if ($SmokeOnly -or $ExistingPostOnly) { 'true' } else { 'false' }
$env:E2E_EXISTING_COPY_ONLY = if ($ExistingPostOnly) { 'true' } else { 'false' }
$env:E2E_EXISTING_MAX_COPIES = if ($ExistingPostOnly) { [string]$ExistingPostsLimit } else { '0' }
$env:E2E_EXISTING_COURSE_PREFIX = if ($CoursePrefix) { 'true' } else { 'false' }
$env:E2E_EXISTING_EXCLUDED_SOURCE_ID = [string]$SkipSourceMessageId
$env:E2E_EXPECTED_TEST_BOT_USERNAME = $ExpectedBotUsername.TrimStart('@')

Push-Location $RepoRoot
$server = $null
try {
  if (-not $SmokeOnly) {
    node scripts/e2e-local/verify-test-bot.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Only the dedicated TEST bot can run E2E.' }
  }
  if ($RepairKnownTestCopies) {
    node scripts/e2e-local/repair-test-copies.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Known TEST copies were not all safely removed; local DB was preserved. Do not retry blindly.' }
  }
  docker compose -f $Compose down -v --remove-orphans | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not reset disposable local E2E containers.' }
  docker compose -f $Compose up -d db | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Local E2E PostgreSQL container did not start.' }
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
  $env:E2E_POSTGREST_PORT = [string](Get-FreeLoopbackPort)
  Write-Host "E2E_POSTGREST_PORT $env:E2E_POSTGREST_PORT"
  docker compose -f $Compose up -d postgrest | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Local PostgREST container did not start on 127.0.0.1:$($env:E2E_POSTGREST_PORT). See the Docker error above." }
  Wait-PostgrestSchema

  $server = Start-Process node -ArgumentList @('scripts/e2e-local/server.mjs') -WorkingDirectory $RepoRoot -NoNewWindow -PassThru
  Start-Sleep -Seconds 1
  if ($server.HasExited) { throw 'Local E2E HTTP server exited during startup.' }
  # The local server forwards the normal Supabase /rest/v1 path to PostgREST.
  # Prove this route works before the smoke script contacts the TEST bot.
  try {
    $proxyProbe = Invoke-WebRequest -UseBasicParsing `
      -Uri "$env:SUPABASE_URL/rest/v1/tgcloner_settings?select=distributor_v2_enabled&limit=1" `
      -Headers @{ apikey = $env:SUPABASE_SECRET_KEY } `
      -TimeoutSec 5
    if ($proxyProbe.StatusCode -ne 200) { throw "HTTP $($proxyProbe.StatusCode)" }
    Write-Host 'LOCAL_SUPABASE_REST_PROXY_READY'
  }
  catch { throw "Local Supabase REST proxy failed: $($_.Exception.Message)" }

  if ($SmokeOnly) {
    Write-Host 'Smoke mode: Reader API credentials are not used. The TEST bot will capture one new plain-text source post through getUpdates.'
    node scripts/e2e-local/smoke-source.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Smoke source capture failed.' }
  }
  else {
    if ($PublicUrl) {
      node scripts/e2e-local/set-webhook.mjs
      if ($LASTEXITCODE -ne 0) { throw 'Could not set TEST bot webhook.' }
    }

    if ($ExistingPostOnly) {
      Write-Host "Reading at most $ExistingPostsLimit existing post(s) into the isolated local DB. No post, edit, pin or delete is made in the source channel."
      if ($CoursePrefix) {
        python reader-cli/export_history.py --channel $Source --cloner-url http://127.0.0.1:8787 --ingest-secret $env:READER_INGEST_SECRET --session telegram-cloner-e2e-reader --course-prefix-limit $ExistingPostsLimit
      }
      elseif ($ExistingPostsLimit -eq 1) {
        python reader-cli/export_history.py --channel $Source --cloner-url http://127.0.0.1:8787 --ingest-secret $env:READER_INGEST_SECRET --session telegram-cloner-e2e-reader --latest-copyable-only
      }
    }
    else {
      Write-Host 'Importing source history into isolated local DB. If Telethon asks for login/OTP, complete it locally; do not paste OTP into ChatGPT.'
      python reader-cli/export_history.py --channel $Source --cloner-url http://127.0.0.1:8787 --ingest-secret $env:READER_INGEST_SECRET --session telegram-cloner-e2e-reader
    }
    if ($LASTEXITCODE -ne 0) { throw 'Reader import failed.' }
  }

  node scripts/e2e-local/run-distributor.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Distributor E2E worker failed.' }

  if ($ExistingPostOnly) {
    if (-not $CoursePrefix) {
      Write-Host 'E2E_EXISTING_POST_COPY_AUTOMATED_PASS mode=1to1'
    }
    else {
      Write-Host "E2E_COURSE_PREFIX_COPY_AUTOMATED_PASS max_posts=$ExistingPostsLimit"
    }
    Write-Host 'Manual gate: confirm the selected source posts appear in ascending source order at the destination.'
  }
  elseif ($SmokeOnly) {
    Write-Host 'E2E_SMOKE_AUTOMATED_GATE_PASS mode=1to1'
    Write-Host 'Manual smoke gate: open destination A and confirm the new source text was copied there.'
  }
  else {
    Write-Host 'DB + Bot API worker gate finished. Running read-only Telegram verifier in the same process environment.'
    python scripts/e2e-local/verify_telegram.py
    if ($LASTEXITCODE -ne 0) { throw 'Telegram read-only verification failed.' }

    Write-Host "E2E_AUTOMATED_GATE_PASS mode=$Mode"
    Write-Host 'Manual gate remains: play the short video and open the rewritten TOC links in the Telegram app.'
  }
}
finally {
  if ($PublicUrl -and $env:TELEGRAM_BOT_TOKEN) {
    try { node scripts/e2e-local/set-webhook.mjs --delete | Out-Null } catch {}
  }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Pop-Location
}
