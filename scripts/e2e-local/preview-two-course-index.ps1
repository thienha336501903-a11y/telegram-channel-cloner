param([long]$AppendixStartSourceId = 0, [switch]$AfterOne)

$ErrorActionPreference = 'Stop'
if ($AppendixStartSourceId -lt 0) { throw 'AppendixStartSourceId must be zero or a source post ID.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dbName = 'tgcloner-e2e-1to2-db'
$labelsJson = docker inspect --format '{{json .Config.Labels}}' $dbName
if ($LASTEXITCODE -ne 0) { throw 'Retained isolated DB is missing. Do not reset or recopy.' }
$labels = $labelsJson | ConvertFrom-Json
$project = $labels.PSObject.Properties['com.docker.compose.project']
if (-not $project -or [string]$project.Value -ne 'tgcloner-e2e-1to2') {
  throw 'Unrecognized Docker container.'
}
docker exec $dbName pg_isready -U postgres -d postgres *> $null
if ($LASTEXITCODE -ne 0) { throw 'Start the retained DB container without recreating it.' }

Push-Location $repoRoot
try {
  $auditArgs = @('scripts/e2e-local/audit-two-writers.py', '--require-clean')
  if ($AfterOne) { $auditArgs += '--after-one' }
  & python @auditArgs
  if ($LASTEXITCODE -ne 0) { throw 'Read-only source/destination reconciliation failed; no index preview produced.' }
  $argsList = @('scripts/e2e-local/preview-two-course-index.mjs')
  if ($AfterOne) { $argsList += '--after-one' }
  if ($AppendixStartSourceId -gt 0) { $argsList += "--appendix-start=$AppendixStartSourceId" }
  & node @argsList
  if ($LASTEXITCODE -ne 0) { throw 'Local DB index preview failed; no Telegram write occurred.' }
}
finally { Pop-Location }
