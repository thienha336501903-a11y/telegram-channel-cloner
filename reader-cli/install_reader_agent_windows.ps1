param(
  [string]$TaskName = "YeuNauAn Telegram Reader Agent",
  [string]$ClonerUrl = $(if ($env:CLONER_URL) { $env:CLONER_URL } else { "https://reader.yeubep.shop" })
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$AgentScript = Join-Path $PSScriptRoot "reader_agent_windows.ps1"
if (-not (Test-Path $AgentScript)) { throw "Reader agent script not found: $AgentScript" }

Write-Host "Preparing Reader Agent locally before creating the hidden startup task..."
Write-Host "If this is the first Telegram login, complete phone / OTP / 2FA prompts in this window."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $AgentScript -ClonerUrl $ClonerUrl -SetupOnly -NoUpdate
if ($LASTEXITCODE -ne 0) {
  throw "Reader Agent local setup failed. No startup entry was installed."
}

$escapedScript = $AgentScript.Replace('"', '""')
$escapedUrl = $ClonerUrl.Replace('"', '""')
$agentArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$escapedScript`" -ClonerUrl `"$escapedUrl`""
$taskCommand = "powershell.exe $agentArgs"
$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

Write-Host "Installing Reader Agent startup task for the current Windows user..."
& schtasks.exe /Create /SC ONLOGON /TN $TaskName /TR $taskCommand /RL LIMITED /F | Out-Host
$taskInstalled = ($LASTEXITCODE -eq 0)

if ($taskInstalled) {
  # Avoid duplicate starts if an older non-admin fallback entry exists.
  Remove-ItemProperty -Path $runKeyPath -Name $TaskName -ErrorAction SilentlyContinue

  Write-Host "Starting Reader Agent now..."
  & schtasks.exe /Run /TN $TaskName | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Task was installed, but could not be started immediately. It will run at next logon."
  }
  Write-Host "Reader Agent installed using Windows Task Scheduler. Telegram session and secrets remain local on this PC."
  exit 0
}

Write-Warning "Task Scheduler refused the current user (for example Access is denied). Falling back to the current-user HKCU Run key; Administrator rights are not required."
New-Item -Path $runKeyPath -Force | Out-Null
Set-ItemProperty -Path $runKeyPath -Name $TaskName -Value $taskCommand

Write-Host "Starting Reader Agent now using the non-admin fallback..."
try {
  Start-Process -FilePath "powershell.exe" -ArgumentList $agentArgs -WindowStyle Hidden
}
catch {
  Write-Warning "Startup entry was installed, but the agent could not be started immediately. It will run automatically at next Windows logon."
}

Write-Host "Reader Agent installed using HKCU Run (current user, no Administrator required). Telegram session and secrets remain local on this PC."
