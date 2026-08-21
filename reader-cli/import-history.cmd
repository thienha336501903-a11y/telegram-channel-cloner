@echo off
setlocal
cd /d "%~dp0\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0import_history_windows.ps1" %*
set "code=%ERRORLEVEL%"
echo.
if "%code%"=="0" (
  echo History import completed.
) else (
  echo History import failed with exit code %code%.
)
pause
exit /b %code%
