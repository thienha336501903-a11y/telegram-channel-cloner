param(
  [Parameter(Position=0)]
  [string]$Channel = "",
  [string]$ClonerUrl = "https://reader.yeubep.shop",
  [switch]$NoUpdate,
  [switch]$ResetSecrets
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SecretsPath = Join-Path $PSScriptRoot ".reader-windows-secrets.json"
$RequirementsPath = Join-Path $PSScriptRoot "requirements.txt"
$ReaderPath = Join-Path $PSScriptRoot "export_history.py"

function Get-PythonRunner {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    return @{ Exe = $python.Source; Prefix = @() }
  }

  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    return @{ Exe = $py.Source; Prefix = @("-3") }
  }

  throw "Python 3 was not found. Install Python 3 and run this command again."
}

function Convert-SecureToPlainText([Security.SecureString]$SecureValue) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Protect-PlainText([string]$Value) {
  $secure = ConvertTo-SecureString -String $Value -AsPlainText -Force
  return ConvertFrom-SecureString -SecureString $secure
}

function Unprotect-Text([string]$EncryptedValue) {
  $secure = ConvertTo-SecureString -String $EncryptedValue
  return Convert-SecureToPlainText $secure
}

function Save-LocalSecrets([string]$ApiId, [string]$ApiHash, [string]$ReaderSecret) {
  $payload = @{
    version = 1
    telegram_api_id = $ApiId
    telegram_api_hash_dpapi = Protect-PlainText $ApiHash
    reader_ingest_secret_dpapi = Protect-PlainText $ReaderSecret
  }
  $payload | ConvertTo-Json -Compress | Set-Content -Path $SecretsPath -Encoding UTF8
  Write-Host "Saved encrypted reader secrets for this Windows user only."
}

function Ensure-LocalSecrets {
  if ($ResetSecrets -and (Test-Path $SecretsPath)) {
    Remove-Item -Path $SecretsPath -Force
  }

  if (Test-Path $SecretsPath) {
    $saved = Get-Content -Raw -Path $SecretsPath | ConvertFrom-Json
    $env:TELEGRAM_API_ID = [string]$saved.telegram_api_id
    $env:TELEGRAM_API_HASH = Unprotect-Text ([string]$saved.telegram_api_hash_dpapi)
    $env:READER_INGEST_SECRET = Unprotect-Text ([string]$saved.reader_ingest_secret_dpapi)
    return
  }

  if ($env:TELEGRAM_API_ID -and $env:TELEGRAM_API_HASH -and $env:READER_INGEST_SECRET) {
    Save-LocalSecrets $env:TELEGRAM_API_ID $env:TELEGRAM_API_HASH $env:READER_INGEST_SECRET
    return
  }

  Write-Host "First-time local setup. Values stay on this PC and are encrypted with Windows DPAPI."
  $apiId = Read-Host "TELEGRAM_API_ID"
  if (-not $apiId -or $apiId -notmatch '^\d+$') {
    throw "TELEGRAM_API_ID must be numeric."
  }

  $apiHashSecure = Read-Host "TELEGRAM_API_HASH" -AsSecureString
  $readerSecretSecure = Read-Host "READER_INGEST_SECRET" -AsSecureString
  $apiHash = Convert-SecureToPlainText $apiHashSecure
  $readerSecret = Convert-SecureToPlainText $readerSecretSecure
  if (-not $apiHash -or -not $readerSecret) {
    throw "Telegram API hash and reader ingest secret are required."
  }

  Save-LocalSecrets $apiId $apiHash $readerSecret
  $env:TELEGRAM_API_ID = $apiId
  $env:TELEGRAM_API_HASH = $apiHash
  $env:READER_INGEST_SECRET = $readerSecret
}

function Update-ReaderCodeSafely {
  if ($NoUpdate) { return }
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) {
    Write-Warning "Git was not found; skipping automatic reader update."
    return
  }

  $branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) {
    Write-Warning "Not inside a normal Git worktree; skipping automatic reader update."
    return
  }
  $branch = $branch.Trim()
  if ($branch -ne "main") {
    Write-Warning "Current branch is '$branch', not main; skipping automatic reader update."
    return
  }

  $trackedChanges = (& git status --porcelain --untracked-files=no 2>$null)
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not inspect Git status; skipping automatic reader update."
    return
  }
  if ($trackedChanges) {
    Write-Warning "Tracked local changes exist; skipping automatic reader update to avoid touching your work."
    return
  }

  & git pull --ff-only --quiet origin main
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Automatic git pull failed; continuing with the local reader version."
  }
  else {
    Write-Host "Reader code is up to date."
  }
}

Push-Location $RepoRoot
try {
  Update-ReaderCodeSafely
  Ensure-LocalSecrets

  if ([string]::IsNullOrWhiteSpace($Channel)) {
    $Channel = Read-Host "Telegram channel (@username, t.me link, t.me/c link, or -100 chat id)"
  }
  $Channel = $Channel.Trim()
  if (-not $Channel) {
    throw "A Telegram channel is required."
  }

  $runner = Get-PythonRunner
  $pythonExe = [string]$runner.Exe
  $pythonPrefix = @($runner.Prefix)

  & $pythonExe @pythonPrefix -c "import telethon, requests" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing local reader dependencies..."
    & $pythonExe @pythonPrefix -m pip install -r $RequirementsPath
    if ($LASTEXITCODE -ne 0) {
      throw "Could not install reader dependencies."
    }
  }

  Write-Host "Importing Telegram history for: $Channel"
  & $pythonExe @pythonPrefix $ReaderPath --channel $Channel --cloner-url $ClonerUrl
  if ($LASTEXITCODE -ne 0) {
    throw "History import failed. See the error above."
  }

  Write-Host "History import completed."
}
finally {
  Pop-Location
}
