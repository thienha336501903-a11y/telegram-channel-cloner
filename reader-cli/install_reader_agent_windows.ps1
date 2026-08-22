param(
  [string]$TaskName = "YeuNauAn Telegram Reader Agent",
  [string]$ClonerUrl = "https://telegram-channel-cloner.vercel.app"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$AgentScript = Join-Path $PSScriptRoot "reader_agent_windows.ps1"
if (-not (Test-Path $AgentScript)) { throw "Reader agent script not found: $AgentScript" }

$escapedScript = $AgentScript.Replace('"', '""')
$escapedUrl = $ClonerUrl.Replace('"', '""')
$taskCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$escapedScript`" -ClonerUrl `"$escapedUrl`""

Write-Host "Installing Reader Agent startup task for the current Windows user..."
& schtasks.exe /Create /SC ONLOGON /TN $TaskName /TR $taskCommand /RL LIMITED /F | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Could not create the startup task. Try running this installer from a normal PowerShell window for the same Windows user."
}

Write-Host "Starting Reader Agent now..."
& schtasks.exe /Run /TN $TaskName | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Task was installed, but could not be started immediately. It will run at next logon."
}

Write-Host "Reader Agent installed. Telegram session and secrets remain local on this PC."
