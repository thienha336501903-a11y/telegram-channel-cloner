Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$BundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExePath = Join-Path $BundleRoot "AntiReaderMeasure.exe"
$ManifestPath = Join-Path $BundleRoot "manifest.json"
$SumsPath = Join-Path $BundleRoot "SHA256SUMS.txt"
$TargetsPath = Join-Path $BundleRoot "measurement-targets.json"
$ConfigPath = $null
$TempRoot = $null
$ResultsDir = $null
$ResultZip = $null
$ConfigHashBefore = $null

function Fail([string]$Reason) {
  $safe = ($Reason -replace "[\r\n]+", " " -replace "(?i)(api[_ -]?hash|session)(\s*[:=]\s*)\S+", '$1$2[REDACTED]')
  Write-Host "MEASUREMENT_FAIL"
  Write-Host ("REASON=" + $safe)
  if ($ResultZip -and (Test-Path -LiteralPath $ResultZip)) {
    Write-Host ("RESULT_ZIP=" + [System.IO.Path]::GetFullPath($ResultZip))
  }
  if ($TempRoot) {
    Write-Host ("TEMP_ROOT=" + [System.IO.Path]::GetFullPath($TempRoot))
  }
  exit 1
}

try {
  if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is unavailable" }
  $ConfigPath = Join-Path $env:LOCALAPPDATA "YeuNauAnReader\reader-manager.dat"
  foreach ($required in @($ExePath, $ManifestPath, $SumsPath, $TargetsPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw ("packet file missing: " + [System.IO.Path]::GetFileName($required))
    }
  }

  $manifest = Get-Content -Raw -LiteralPath $ManifestPath -Encoding UTF8 | ConvertFrom-Json
  if ([string]$manifest.bundle_version -ne "1.0.0") { throw "unsupported bundle version" }
  if ([string]$manifest.python_version -ne "3.12.10") { throw "manifest Python version mismatch" }
  if ([string]$manifest.telethon_version -ne "1.45.0") { throw "manifest Telethon version mismatch" }
  if ([bool]$manifest.self_contained_frozen_probe -ne $true) { throw "packet is not self-contained" }
  if ([bool]$manifest.measurement_config_finalized -ne $true) { throw "measurement packet was not finalized" }

  $verified = @()
  foreach ($line in Get-Content -LiteralPath $SumsPath -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*(.+)$') { throw "invalid SHA256SUMS format" }
    $expected = $Matches[1].ToLowerInvariant()
    $name = $Matches[2]
    if ($name -match '[\\/]' -or $name -match '^\.') { throw "unsafe path in SHA256SUMS" }
    $path = Join-Path $BundleRoot $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ("integrity file missing: " + $name) }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw ("packet integrity mismatch: " + $name) }
    $verified += [ordered]@{ file = $name; sha256 = $actual; ok = $true }
  }
  $expectedFiles = @("AntiReaderMeasure.exe", "README-ANTI.md", "Run-AntiReaderMeasurement.ps1", "measurement-targets.json", "manifest.json", "SHA256SUMS.txt")
  $actualFiles = @(Get-ChildItem -LiteralPath $BundleRoot -File | ForEach-Object { $_.Name })
  $unexpected = @($actualFiles | Where-Object { $_ -notin $expectedFiles })
  $missing = @($expectedFiles | Where-Object { $_ -notin $actualFiles })
  if ($unexpected.Count -gt 0) { throw ("unexpected packet file(s): " + ($unexpected -join ", ")) }
  if ($missing.Count -gt 0) { throw ("packet file(s) missing: " + ($missing -join ", ")) }

  $blockedNames = @("YeuNauAnReader", "YeuNauAnReaderMirror", "YeuNauAnReaderImport", "YeuNauAnReaderReconcile")
  $running = @()
  foreach ($name in $blockedNames) {
    $running += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  }
  if ($running.Count -gt 0) {
    throw ("Reader process is running: " + (($running | Select-Object -ExpandProperty ProcessName -Unique) -join ", "))
  }
  try {
    $scriptWorkers = @(Get-CimInstance Win32_Process | Where-Object {
      $_.ProcessId -ne $PID -and $_.CommandLine -and
      $_.CommandLine -match '(?i)(reader_manager_(agent|gui)\.py|mirror_v5_r2\.py|reader_agent\.py)'
    })
  }
  catch {
    throw "cannot verify that script-based Reader workers are stopped"
  }
  if ($scriptWorkers.Count -gt 0) { throw "a script-based Reader worker is running" }

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Reader config not found at the installed location"
  }
  $ConfigHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $ConfigPath).Hash.ToLowerInvariant()

  $TempBase = Join-Path ([System.IO.Path]::GetTempPath()) "AntiReaderMeasurement"
  if (-not (Test-Path -LiteralPath $TempBase -PathType Container)) {
    New-Item -ItemType Directory -Path $TempBase -Force | Out-Null
  }
  $leaf = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [Guid]::NewGuid().ToString("N")
  $TempRoot = Join-Path $TempBase $leaf
  if (Test-Path -LiteralPath $TempRoot) { throw "new temp root already exists" }
  New-Item -ItemType Directory -Path $TempRoot -Force:$false | Out-Null
  $ResultsDir = Join-Path $TempRoot "results"
  New-Item -ItemType Directory -Path $ResultsDir -Force:$false | Out-Null

  $driveRoot = [System.IO.Path]::GetPathRoot($TempRoot)
  $drive = [System.IO.DriveInfo]::new($driveRoot)
  if (-not $drive.IsReady -or $drive.AvailableFreeSpace -lt 2GB) {
    throw "at least 2 GiB free disk space is required"
  }

  [ordered]@{
    checked_at = [DateTime]::UtcNow.ToString("o")
    packet_files = $verified
    unexpected_files = $unexpected
    reader_processes_stopped = $true
    script_workers_stopped = $true
    disk_free_bytes = [Int64]$drive.AvailableFreeSpace
    config_path = '%LOCALAPPDATA%\YeuNauAnReader\reader-manager.dat'
    config_sha256_before = $ConfigHashBefore
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ResultsDir "packet-integrity.json") -Encoding UTF8
  Copy-Item -LiteralPath $ManifestPath -Destination (Join-Path $ResultsDir "bundle-manifest.json")

  & $ExePath --self-test --bundle-root $BundleRoot
  if ($LASTEXITCODE -ne 0) { throw "frozen probe self-test failed" }

  & $ExePath --run --bundle-root $BundleRoot --config-path $ConfigPath --targets-path $TargetsPath --output-dir $ResultsDir
  $probeExit = $LASTEXITCODE

  $ConfigHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $ConfigPath).Hash.ToLowerInvariant()
  [ordered]@{
    checked_at = [DateTime]::UtcNow.ToString("o")
    config_path = '%LOCALAPPDATA%\YeuNauAnReader\reader-manager.dat'
    config_sha256_before = $ConfigHashBefore
    config_sha256_after = $ConfigHashAfter
    config_unchanged = ($ConfigHashBefore -eq $ConfigHashAfter)
    reader_control_api_accessed = $false
    production_queue_accessed = $false
    object_storage_accessed = $false
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ResultsDir "launcher-integrity.json") -Encoding UTF8

  $mediaPath = Join-Path $TempRoot "media"
  if (Test-Path -LiteralPath $mediaPath) {
    Remove-Item -LiteralPath $mediaPath -Recurse -Force
  }
  if ($ConfigHashBefore -ne $ConfigHashAfter) { throw "Reader config hash changed" }

  $ResultZip = Join-Path $TempRoot ("ANTI_READER_RESULT_" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")
  $resultFiles = @(Get-ChildItem -LiteralPath $ResultsDir -File)
  if ($resultFiles.Count -gt 0) {
    Compress-Archive -LiteralPath ($resultFiles | ForEach-Object { $_.FullName }) -DestinationPath $ResultZip -CompressionLevel Optimal
  }
  if ($probeExit -ne 0) { throw ("measurement probe exited with code " + $probeExit) }
  if (-not (Test-Path -LiteralPath $ResultZip -PathType Leaf)) { throw "result ZIP was not created" }

  Write-Host "MEASUREMENT_PASS"
  Write-Host ("RESULT_ZIP=" + [System.IO.Path]::GetFullPath($ResultZip))
  Write-Host ("TEMP_ROOT=" + [System.IO.Path]::GetFullPath($TempRoot))
  exit 0
}
catch {
  if ($TempRoot) {
    $mediaPath = Join-Path $TempRoot "media"
    if (Test-Path -LiteralPath $mediaPath) {
      Remove-Item -LiteralPath $mediaPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($ResultsDir -and (Test-Path -LiteralPath $ResultsDir)) {
      if ($ConfigHashBefore -and $ConfigPath -and (Test-Path -LiteralPath $ConfigPath)) {
        $after = (Get-FileHash -Algorithm SHA256 -LiteralPath $ConfigPath).Hash.ToLowerInvariant()
        [ordered]@{
          checked_at = [DateTime]::UtcNow.ToString("o")
          config_sha256_before = $ConfigHashBefore
          config_sha256_after = $after
          config_unchanged = ($ConfigHashBefore -eq $after)
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ResultsDir "launcher-failure-integrity.json") -Encoding UTF8
      }
      $partialFiles = @(Get-ChildItem -LiteralPath $ResultsDir -File)
      if ($partialFiles.Count -gt 0) {
        $ResultZip = Join-Path $TempRoot ("ANTI_READER_RESULT_FAILED_" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")
        Compress-Archive -LiteralPath ($partialFiles | ForEach-Object { $_.FullName }) -DestinationPath $ResultZip -CompressionLevel Optimal -ErrorAction SilentlyContinue
      }
    }
  }
  Fail $_.Exception.Message
}
