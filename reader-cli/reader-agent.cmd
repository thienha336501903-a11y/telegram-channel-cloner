@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0reader_agent_windows.ps1" %*
exit /b %ERRORLEVEL%
