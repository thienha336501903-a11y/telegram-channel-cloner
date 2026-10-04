param(
  [Parameter(Mandatory=$true)]
  [string]$Manifest,

  [Parameter(Mandatory=$true)]
  [string]$DestinationTitle,

  [string]$Destination = "",

  [string]$ProfileName = "",

  [ValidateRange(1,2)]
  [int]$MaxUnits = 1,

  [ValidateRange(1,14)]
  [int]$StartUnit = 1,

  [switch]$Publish
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ExpectedSource = '-1002049524573'

if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
  throw "Manifest not found: $Manifest"
}

$python = (Get-Command python -ErrorAction Stop).Source
$script = Join-Path $RepoRoot 'reader-cli\rebuild_from_export.py'

$argsList = @(
  $script,
  '--manifest', $Manifest,
  '--destination-title', $DestinationTitle,
  '--max-units', [string]$MaxUnits,
  '--start-unit', [string]$StartUnit
)

if ($Destination) {
  if ($Destination -eq $ExpectedSource) {
    throw 'Destination cannot be the protected source channel.'
  }
  $argsList += @('--destination', $Destination)
}

if ($ProfileName) {
  $argsList += @('--profile-name', $ProfileName)
}

if ($Publish) {
  Write-Host 'REBUILD TEST PILOT: Telegram destination write is ENABLED.'
  Write-Host "Destination title: $DestinationTitle"
  Write-Host "Start unit: $StartUnit"
  Write-Host "Max units: $MaxUnits"
  $confirm = Read-Host 'Type PUBLISH-TEST exactly to continue'
  if ($confirm -ne 'PUBLISH-TEST') {
    throw 'Publish cancelled before Telegram write.'
  }
  $argsList += '--publish'
}
else {
  Write-Host 'REBUILD TEST PILOT PREFLIGHT ONLY — no Telegram write.'
}

Push-Location $RepoRoot
try {
  & $python @argsList
  if ($LASTEXITCODE -ne 0) {
    throw "REBUILD_FROM_TELEGRAM_EXPORT pilot failed with exit $LASTEXITCODE. Do not blind-retry after a publish failure."
  }
}
finally {
  Pop-Location
}
