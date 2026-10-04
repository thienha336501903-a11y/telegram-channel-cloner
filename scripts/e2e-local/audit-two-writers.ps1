# Read-only local forensic snapshot. Never prints process command lines,
# task arguments, bot tokens, Reader credentials, or Telegram message text.
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dbName = 'tgcloner-e2e-1to2-db'

$labelsJson = docker inspect --format '{{json .Config.Labels}}' $dbName
if ($LASTEXITCODE -ne 0) { throw 'The retained isolated DB container is missing. Do not reset it.' }
$labels = $labelsJson | ConvertFrom-Json
$project = $labels.PSObject.Properties['com.docker.compose.project']
if (-not $project -or [string]$project.Value -ne 'tgcloner-e2e-1to2') {
  throw 'Refusing an unrecognized Docker container.'
}
docker exec $dbName pg_isready -U postgres -d postgres *> $null
if ($LASTEXITCODE -ne 0) { throw 'Start the retained DB container; do not recreate it.' }

Write-Host 'AUDIT_LOCAL_LEDGER_AND_TELEGRAM'
Push-Location $repoRoot
try {
  python scripts/e2e-local/audit-two-writers.py
  if ($LASTEXITCODE -ne 0) { throw 'Read-only DB/Telegram audit failed.' }
}
finally { Pop-Location }

Write-Host 'AUDIT_CURRENT_RELEVANT_PROCESSES (no command lines)'
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(node|python|pythonw|powershell|pwsh|cloudflared)(\.exe)?$' -or
  $_.Name -match 'reader|telegram|cloner'
} | Select-Object Name,ProcessId,ParentProcessId,CreationDate |
  Format-Table -AutoSize

Write-Host 'AUDIT_RELEVANT_SCHEDULED_TASKS (no arguments)'
try {
  Get-ScheduledTask | ForEach-Object {
    $task = $_
    foreach ($action in $task.Actions) {
      $executable = [System.IO.Path]::GetFileName([string]$action.Execute)
      if ($task.TaskName -match 'reader|telegram|cloner|distributor|mirror' -or
          $executable -match '^(node|python|pythonw|powershell|pwsh)(\.exe)?$') {
        [pscustomobject]@{ Name=$task.TaskName; Path=$task.TaskPath;
          State=$task.State; Executable=$executable }
      }
    }
  } | Sort-Object Path,Name -Unique | Format-Table -AutoSize
}
catch { Write-Host 'AUDIT_SCHEDULED_TASKS_UNAVAILABLE' }

# Telegram duplicate posts were observed between 04:10 and 04:21 UTC.
# Print only task identity and event ID, never raw event messages or arguments.
Write-Host 'AUDIT_TASK_HISTORY_2026_10_03_0405_0425_UTC'
try {
  $start = ([datetime]'2026-10-03T04:05:00Z').ToLocalTime()
  $end = ([datetime]'2026-10-03T04:25:00Z').ToLocalTime()
  Get-WinEvent -FilterHashtable @{
    LogName='Microsoft-Windows-TaskScheduler/Operational';
    StartTime=$start; EndTime=$end; Id=100,102,200,201
  } -ErrorAction Stop | ForEach-Object {
    $eventXml = [xml]$_.ToXml()
    $taskName = @($eventXml.Event.EventData.Data | Where-Object { $_.Name -eq 'TaskName' } |
      ForEach-Object { $_.'#text' })[0]
    if ($taskName -match 'reader|telegram|cloner|distributor|mirror') {
      [pscustomobject]@{ Utc=$_.TimeCreated.ToUniversalTime().ToString('o');
        EventId=$_.Id; Task=$taskName }
    }
  } | Format-Table -AutoSize
}
catch { Write-Host 'AUDIT_TASK_HISTORY_UNAVAILABLE_OR_EMPTY' }

Write-Host 'AUDIT_WINDOWS_READONLY_COMPLETE'
