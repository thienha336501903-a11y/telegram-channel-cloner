Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$BundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExePath = Join-Path $BundleRoot "AntiReaderMeasure.exe"
$ManifestPath = Join-Path $BundleRoot "manifest.json"
$SumsPath = Join-Path $BundleRoot "SHA256SUMS.txt"
$TargetsPath = Join-Path $BundleRoot "measurement-targets.json"
$ConfigPath = $null
$TempRoot = $null
$LauncherDir = $null
$ProbeDir = $null
$ResultStage = $null
$ResultZip = $null
$ConfigHashBefore = $null
$TargetIds = @()
$PackagingSafetyFailure = $false

function Safe-Reason([string]$Value) {
  return ($Value -replace "[\r\n]+", " " -replace "(?i)(api[_ -]?hash|auth[_ -]?key|string[_ -]?session|session)(\s*[:=]\s*)\S+", '$1$2[REDACTED]')
}

function Write-JsonFile([string]$Path, $Value, [int]$Depth = 8) {
  $Value | ConvertTo-Json -Depth $Depth | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-ConfigHash {
  if (-not $ConfigPath -or -not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $null }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $ConfigPath).Hash.ToLowerInvariant()
}

function Assert-ReaderStopped {
  $blocked = @()
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    if ($process.ProcessName -like "YeuNauAnReader*" -or $process.ProcessName -eq "AntiReaderMeasure") {
      $blocked += ($process.ProcessName + "#" + $process.Id)
    }
  }
  try {
    foreach ($process in @(Get-CimInstance Win32_Process)) {
      if ($process.ProcessId -eq $PID -or -not $process.CommandLine) { continue }
      if ($process.CommandLine -match '(?i)(reader_manager_(agent|gui)\.py|mirror_v5_r2\.py|reader_agent\.py|export_history\.py|reconcile_history\.py)') {
        $blocked += ([System.IO.Path]::GetFileName([string]$process.Name) + "#" + $process.ProcessId)
      }
    }
  }
  catch {
    throw "cannot verify that script-based Reader workers are stopped"
  }
  $blocked = @($blocked | Select-Object -Unique)
  if ($blocked.Count -gt 0) {
    throw ("Reader/probe process is running: " + ($blocked -join ", "))
  }
}

function Finalize-ResultZip([bool]$Failed) {
  if (-not $TempRoot -or -not (Test-Path -LiteralPath $TempRoot -PathType Container)) { return }
  if ($ResultZip -and (Test-Path -LiteralPath $ResultZip -PathType Leaf)) { return }

  $script:ResultStage = Join-Path $TempRoot "result-stage"
  if (Test-Path -LiteralPath $ResultStage) { throw "result staging path already exists" }
  $launcherStage = Join-Path $ResultStage "launcher"
  $probeStage = Join-Path $ResultStage "probe"
  New-Item -ItemType Directory -Path $launcherStage -Force:$false | Out-Null
  New-Item -ItemType Directory -Path $probeStage -Force:$false | Out-Null

  if ($LauncherDir -and (Test-Path -LiteralPath $LauncherDir -PathType Container)) {
    foreach ($file in @(Get-ChildItem -LiteralPath $LauncherDir -File)) {
      Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $launcherStage $file.Name)
    }
  }

  $allowedProbeFiles = @(
    "runtime.json",
    "telethon-sanitized.log",
    "pre-post-hashes.json",
    "integrity.json",
    "measurement-summary.json"
  )
  foreach ($messageId in $TargetIds) {
    $allowedProbeFiles += @(
      "requests-$messageId.jsonl",
      "system-$messageId.jsonl",
      "summary-$messageId.json"
    )
  }
  $unknownFiles = @()
  $sensitiveFiles = @()
  if ($ProbeDir -and (Test-Path -LiteralPath $ProbeDir -PathType Container)) {
    foreach ($file in @(Get-ChildItem -LiteralPath $ProbeDir -File)) {
      if ($file.Name -notin $allowedProbeFiles) {
        $unknownFiles += $file.Name
        continue
      }
      $text = Get-Content -Raw -LiteralPath $file.FullName -ErrorAction Stop
      if ($text -match '(?i)["'']?(api_hash|auth_key|string_session|session_string)["'']?\s*[:=]\s*["'']?[A-Za-z0-9_+/=-]{8,}') {
        $sensitiveFiles += $file.Name
        continue
      }
      Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $probeStage $file.Name)
    }
  }
  if ($unknownFiles.Count -gt 0 -or $sensitiveFiles.Count -gt 0) {
    $script:PackagingSafetyFailure = $true
  }
  Write-JsonFile (Join-Path $launcherStage "result-packaging-safety.json") ([ordered]@{
    checked_at = [DateTime]::UtcNow.ToString("o")
    allowed_probe_files = $allowedProbeFiles
    unknown_probe_files_excluded = $unknownFiles
    sensitive_probe_files_excluded = $sensitiveFiles
    pass = (-not $PackagingSafetyFailure)
  }) 6

  $prefix = if ($Failed -or $PackagingSafetyFailure) { "ANTI_READER_RESULT_FAILED_" } else { "ANTI_READER_RESULT_" }
  $script:ResultZip = Join-Path $TempRoot ($prefix + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")
  Compress-Archive -Path (Join-Path $ResultStage "*") -DestinationPath $ResultZip -CompressionLevel Optimal
}

function Fail([string]$Reason) {
  Write-Host "MEASUREMENT_FAIL"
  Write-Host ("REASON=" + (Safe-Reason $Reason))
  if ($ResultZip -and (Test-Path -LiteralPath $ResultZip -PathType Leaf)) {
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
  if ([string]$manifest.bundle_version -ne "2.0.0") { throw "unsupported bundle version" }
  if ([string]$manifest.baseline_main_sha -ne "931c064798e1c5e278c88637129397643963fa26") { throw "baseline main SHA mismatch" }
  if ([string]$manifest.python_version -ne "3.12.10") { throw "manifest Python version mismatch" }
  if ([string]$manifest.telethon_version -ne "1.45.0") { throw "manifest Telethon version mismatch" }
  if ([bool]$manifest.self_contained_frozen_probe -ne $true) { throw "packet is not self-contained" }
  if ([bool]$manifest.measurement_config_finalized -ne $true) { throw "measurement packet was not finalized" }
  if ([bool]$manifest.cryptg_bundled -ne $false) { throw "unexpected cryptg bundle" }
  if ([Int64]$manifest.request_size_bytes -ne 524288) { throw "request size contract mismatch" }
  if ([Int64]$manifest.max_requests_inflight -ne 1) { throw "in-flight contract mismatch" }
  if ([string]$manifest.probe_output_directory_contract -ne "probe_creates_nonexistent_directory") { throw "probe output contract mismatch" }
  if ([bool]$manifest.network_events_are_diagnostic_warnings -ne $true) { throw "diagnostic event policy mismatch" }
  if ([bool]$manifest.sha256_validation_excluded_from_timed_download -ne $true) { throw "timed hashing policy mismatch" }
  if ($manifest.safety.production_queue_access -ne $false -or
      $manifest.safety.reader_control_api_access -ne $false -or
      $manifest.safety.object_storage_access -ne $false -or
      $manifest.safety.config_write -ne $false -or
      $manifest.safety.session_persistence -ne $false -or
      [Int64]$manifest.safety.telegram_download_parallelism -ne 1) {
    throw "manifest safety contract mismatch"
  }

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
  $expectedHashedFiles = @($expectedFiles | Where-Object { $_ -ne "SHA256SUMS.txt" })
  $verifiedNames = @($verified | ForEach-Object { $_.file })
  if (@($verifiedNames | Select-Object -Unique).Count -ne $expectedHashedFiles.Count -or
      @($expectedHashedFiles | Where-Object { $_ -notin $verifiedNames }).Count -gt 0) {
    throw "SHA256SUMS file set mismatch"
  }
  $actualFiles = @(Get-ChildItem -LiteralPath $BundleRoot -File | ForEach-Object { $_.Name })
  $unexpected = @($actualFiles | Where-Object { $_ -notin $expectedFiles })
  $missing = @($expectedFiles | Where-Object { $_ -notin $actualFiles })
  if ($unexpected.Count -gt 0) { throw ("unexpected packet file(s): " + ($unexpected -join ", ")) }
  if ($missing.Count -gt 0) { throw ("packet file(s) missing: " + ($missing -join ", ")) }

  $targetsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $TargetsPath).Hash.ToLowerInvariant()
  if ($targetsHash -ne ([string]$manifest.measurement_configuration_sha256).ToLowerInvariant()) {
    throw "measurement target hash mismatch"
  }
  $targets = Get-Content -Raw -LiteralPath $TargetsPath -Encoding UTF8 | ConvertFrom-Json
  $targetItems = @($targets.targets)
  $manifestTargets = @($manifest.measurement_configuration.targets)
  if ($targetItems.Count -ne 3 -or $manifestTargets.Count -ne 3) { throw "exactly three targets are required" }
  if ([string]$targets.profile_id -ne [string]$manifest.measurement_configuration.profile_id -or
      [string]$targets.channel -ne [string]$manifest.measurement_configuration.channel) {
    throw "measurement target identity mismatch"
  }
  foreach ($target in $targetItems) {
    $id = [Int64]$target.message_id
    $bytes = [Int64]$target.bytes
    if ($id -lt 1 -or $bytes -lt 1) { throw "invalid target values" }
    if ($id -in $TargetIds) { throw "duplicate target message id" }
    $TargetIds += $id
    $manifestTarget = @($manifestTargets | Where-Object { [Int64]$_.message_id -eq $id })
    if ($manifestTarget.Count -ne 1 -or [Int64]$manifestTarget[0].bytes -ne $bytes) {
      throw "manifest target mismatch"
    }
    $expectedChunks = [Int64][Math]::Ceiling([double]$bytes / 524288.0)
    if ([Int64]$manifestTarget[0].expected_chunks -ne $expectedChunks) { throw "manifest chunk count mismatch" }
  }

  Assert-ReaderStopped
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Reader config not found at the installed location"
  }
  $ConfigHashBefore = Get-ConfigHash

  $TempBase = Join-Path ([System.IO.Path]::GetTempPath()) "AntiReaderMeasurement"
  if (-not (Test-Path -LiteralPath $TempBase -PathType Container)) {
    New-Item -ItemType Directory -Path $TempBase -Force | Out-Null
  }
  $leaf = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [Guid]::NewGuid().ToString("N")
  $TempRoot = Join-Path $TempBase $leaf
  if (Test-Path -LiteralPath $TempRoot) { throw "new temp root already exists" }
  New-Item -ItemType Directory -Path $TempRoot -Force:$false | Out-Null
  $LauncherDir = Join-Path $TempRoot "launcher"
  New-Item -ItemType Directory -Path $LauncherDir -Force:$false | Out-Null
  $ProbeDir = Join-Path $TempRoot "probe-output"
  if (Test-Path -LiteralPath $ProbeDir) { throw "probe output path must not exist before launch" }

  $driveRoot = [System.IO.Path]::GetPathRoot($TempRoot)
  $drive = [System.IO.DriveInfo]::new($driveRoot)
  if (-not $drive.IsReady -or $drive.AvailableFreeSpace -lt 2GB) {
    throw "at least 2 GiB free disk space is required"
  }

  Write-JsonFile (Join-Path $LauncherDir "packet-integrity.json") ([ordered]@{
    checked_at = [DateTime]::UtcNow.ToString("o")
    packet_files = $verified
    unexpected_files = $unexpected
    reader_processes_stopped = $true
    disk_free_bytes = [Int64]$drive.AvailableFreeSpace
    config_path = '%LOCALAPPDATA%\YeuNauAnReader\reader-manager.dat'
    config_sha256_before = $ConfigHashBefore
    targets_sha256 = $targetsHash
    probe_output_existed_before_run = $false
  }) 8

  $powerScheme = $null
  try { $powerScheme = ((& powercfg /GetActiveScheme 2>&1) | Out-String).Trim() } catch { $powerScheme = "unavailable" }
  $cpuInfo = @()
  $osInfo = $null
  try {
    $cpuInfo = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed)
    $osInfo = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
  } catch { }
  Write-JsonFile (Join-Path $LauncherDir "host-info.json") ([ordered]@{
    collected_at = [DateTime]::UtcNow.ToString("o")
    powershell_version = $PSVersionTable.PSVersion.ToString()
    processor = $cpuInfo
    operating_system = $osInfo
    active_power_scheme = $powerScheme
    elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }) 6

  $selfTestPath = Join-Path $LauncherDir "self-test.txt"
  & $ExePath --self-test --bundle-root $BundleRoot 2>&1 | Tee-Object -FilePath $selfTestPath
  $selfTestExit = $LASTEXITCODE
  if ($selfTestExit -ne 0) { throw "frozen probe self-test failed" }

  Assert-ReaderStopped
  if (Test-Path -LiteralPath $ProbeDir) { throw "probe output was contaminated before run" }
  $probeConsolePath = Join-Path $LauncherDir "probe-console.txt"
  & $ExePath --run --bundle-root $BundleRoot --config-path $ConfigPath --targets-path $TargetsPath --output-dir $ProbeDir 2>&1 | Tee-Object -FilePath $probeConsolePath
  $probeExit = $LASTEXITCODE

  Assert-ReaderStopped
  $ConfigHashAfter = Get-ConfigHash
  $mediaPath = Join-Path $TempRoot "media"
  $mediaRemaining = Test-Path -LiteralPath $mediaPath
  if ($mediaRemaining) {
    Remove-Item -LiteralPath $mediaPath -Recurse -Force -ErrorAction Stop
  }
  Write-JsonFile (Join-Path $LauncherDir "launcher-integrity.json") ([ordered]@{
    checked_at = [DateTime]::UtcNow.ToString("o")
    config_path = '%LOCALAPPDATA%\YeuNauAnReader\reader-manager.dat'
    config_sha256_before = $ConfigHashBefore
    config_sha256_after = $ConfigHashAfter
    config_unchanged = ($ConfigHashBefore -eq $ConfigHashAfter)
    probe_exit_code = $probeExit
    probe_created_output_directory = (Test-Path -LiteralPath $ProbeDir -PathType Container)
    media_remaining_before_launcher_cleanup = $mediaRemaining
    media_remaining_after_launcher_cleanup = (Test-Path -LiteralPath $mediaPath)
    reader_processes_stopped_after = $true
    reader_control_api_accessed = $false
    production_queue_accessed = $false
    object_storage_accessed = $false
  }) 6

  $failed = ($probeExit -ne 0 -or $ConfigHashBefore -ne $ConfigHashAfter -or $mediaRemaining)
  Finalize-ResultZip $failed
  if ($PackagingSafetyFailure) { throw "result packaging safety validation failed" }
  if ($ConfigHashBefore -ne $ConfigHashAfter) { throw "Reader config hash changed" }
  if ($mediaRemaining) { throw "probe left temporary media behind" }
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
    if ($LauncherDir -and (Test-Path -LiteralPath $LauncherDir -PathType Container)) {
      $after = Get-ConfigHash
      Write-JsonFile (Join-Path $LauncherDir "launcher-failure-integrity.json") ([ordered]@{
        checked_at = [DateTime]::UtcNow.ToString("o")
        config_sha256_before = $ConfigHashBefore
        config_sha256_after = $after
        config_unchanged = ($null -ne $ConfigHashBefore -and $ConfigHashBefore -eq $after)
        media_remaining_after_cleanup = (Test-Path -LiteralPath $mediaPath)
      }) 4
      try { Finalize-ResultZip $true } catch { }
    }
  }
  Fail $_.Exception.Message
}
