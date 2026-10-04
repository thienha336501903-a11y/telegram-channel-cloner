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
  throw "Không tìm thấy rebuild manifest: $Manifest"
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  throw 'Python 3 không có trong PATH.'
}

Push-Location $RepoRoot
try {
  & $python.Source -c "import telethon" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'Thiếu Telethon. Hãy dùng máy Reader đã cài dependencies.'
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
    throw 'REBUILD TEST pilot dừng an toàn. Không retry mù nếu đã dùng -Publish.'
  }
}
finally {
  Pop-Location
}
