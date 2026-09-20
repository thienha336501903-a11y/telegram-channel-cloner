param(
  [Parameter(Mandatory = $true)][string]$GenericZip,
  [Parameter(Mandatory = $true)][string]$PythonExe
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$testRoot = Join-Path $base ("anti-reader-offline-" + [Guid]::NewGuid().ToString("N"))
$packetDir = Join-Path $testRoot "packet"
$fakeLocalAppData = Join-Path $testRoot "LocalAppData"
$configDir = Join-Path $fakeLocalAppData "YeuNauAnReader"
$targetConfig = Join-Path $testRoot "targets.json"
$finalZip = Join-Path $testRoot "finalized.zip"
$measurementTempRoot = $null
$originalLocalAppData = $env:LOCALAPPDATA

try {
  New-Item -ItemType Directory -Path $testRoot -Force:$false | Out-Null
  New-Item -ItemType Directory -Path $configDir -Force:$false | Out-Null

  $targets = [ordered]@{
    schema_version = 1
    profile_id = "11111111-2222-4333-8444-555555555555"
    channel = "-1001234567890"
    targets = @(
      [ordered]@{ message_id = 10; filename = "a.mp4"; bytes = 10000001 },
      [ordered]@{ message_id = 20; filename = "b.mp4"; bytes = 20000002 },
      [ordered]@{ message_id = 30; filename = "c.mp4"; bytes = 30000003 }
    )
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($targetConfig, ($targets | ConvertTo-Json -Depth 6), $utf8NoBom)
  # Valid base64, deliberately not a DPAPI blob.
  [System.IO.File]::WriteAllText(
    (Join-Path $configDir "reader-manager.dat"),
    "bm90LXJlYWwtZW5jcnlwdGVkLWNvbmZpZw==",
    $utf8NoBom
  )

  & $PythonExe (Join-Path $PSScriptRoot "finalize_packet.py") `
    --generic-zip (Resolve-Path $GenericZip) `
    --config-json $targetConfig `
    --output-zip $finalZip
  if ($LASTEXITCODE -ne 0) { throw "offline finalization failed" }
  Expand-Archive -LiteralPath $finalZip -DestinationPath $packetDir

  $env:LOCALAPPDATA = $fakeLocalAppData
  $launcherOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $packetDir "Run-AntiReaderMeasurement.ps1") 2>&1)
  $launcherExit = $LASTEXITCODE
  $launcherOutput | ForEach-Object { Write-Host $_ }
  $text = ($launcherOutput | ForEach-Object { [string]$_ }) -join "`n"
  if ($launcherExit -eq 0) { throw "offline launcher was expected to fail on fake DPAPI data" }
  if ($text -notmatch 'MEASUREMENT_FAIL') { throw "offline launcher did not report MEASUREMENT_FAIL" }
  if ($text -match 'output_directory_must') { throw "V1 output-directory collision regressed" }

  $resultLine = @($launcherOutput | ForEach-Object { [string]$_ } | Where-Object { $_ -like "RESULT_ZIP=*" })
  $tempLine = @($launcherOutput | ForEach-Object { [string]$_ } | Where-Object { $_ -like "TEMP_ROOT=*" })
  if ($resultLine.Count -ne 1 -or $tempLine.Count -ne 1) { throw "offline launcher did not return result paths" }
  $resultZip = $resultLine[0].Substring("RESULT_ZIP=".Length)
  $measurementTempRoot = $tempLine[0].Substring("TEMP_ROOT=".Length)
  if (-not (Test-Path -LiteralPath $resultZip -PathType Leaf)) { throw "offline result ZIP missing" }

  $resultDir = Join-Path $testRoot "result"
  Expand-Archive -LiteralPath $resultZip -DestinationPath $resultDir
  foreach ($required in @(
    "launcher\launcher-integrity.json",
    "launcher\result-packaging-safety.json",
    "probe\runtime.json"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $resultDir $required) -PathType Leaf)) {
      throw ("offline result evidence missing: " + $required)
    }
  }
  $integrity = Get-Content -Raw -LiteralPath (Join-Path $resultDir "launcher\launcher-integrity.json") | ConvertFrom-Json
  $packaging = Get-Content -Raw -LiteralPath (Join-Path $resultDir "launcher\result-packaging-safety.json") | ConvertFrom-Json
  if ($integrity.config_unchanged -ne $true) { throw "offline config hash changed" }
  if ($integrity.probe_created_output_directory -ne $true) { throw "probe did not own output creation" }
  if ([Int64]$integrity.probe_exit_code -eq 0) { throw "fake DPAPI probe unexpectedly succeeded" }
  if ($integrity.media_remaining_after_launcher_cleanup -ne $false) { throw "offline media cleanup failed" }
  if ($packaging.pass -ne $true) { throw "offline result safety packaging failed" }
  Write-Host "OFFLINE_LAUNCHER_ORCHESTRATION_PASS"
}
finally {
  $env:LOCALAPPDATA = $originalLocalAppData
  if ($measurementTempRoot -and (Test-Path -LiteralPath $measurementTempRoot)) {
    Remove-Item -LiteralPath $measurementTempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
