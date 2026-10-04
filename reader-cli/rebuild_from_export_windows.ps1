param(
  [Parameter(Mandatory=$true)]
  [string]$Manifest,

  [Parameter(Mandatory=$true)]
  [string]$DestinationTitle,

  [string]$Destination = "",

  [ValidateRange(1,2)]
  [int]$MaxUnits = 2,

  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Script = Join-Path $PSScriptRoot 'rebuild_from_export.py'

if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
  throw "Rebuild manifest not found: $Manifest"
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  throw 'Python 3 is not available in PATH.'
}

Push-Location $RepoRoot
try {
  & $python.Source -c "import telethon" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'Telethon is missing. Use the configured Windows Reader machine.'
  }

  $argsList = @(
    $Script,
    '--manifest', (Resolve-Path -LiteralPath $Manifest).Path,
    '--destination-title', $DestinationTitle,
    '--max-units', [string]$MaxUnits
  )
  if ($Destination) {
    $argsList += @('--destination', $Destination)
  }
  if ($Publish) {
    $argsList += '--publish'
  }

  & $python.Source @argsList
  if ($LASTEXITCODE -ne 0) {
    throw 'REBUILD TEST pilot stopped safely. Do not blindly retry after -Publish.'
  }
}
finally {
  Pop-Location
}
