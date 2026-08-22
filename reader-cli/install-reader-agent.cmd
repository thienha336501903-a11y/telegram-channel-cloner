@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_reader_agent_windows.ps1" %*
exit /b %ERRORLEVEL%
