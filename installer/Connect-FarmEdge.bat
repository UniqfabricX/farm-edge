@echo off
setlocal
cd /d "%~dp0"
title Farm Edge connect
rem Trailing backslash in "%~dp0" breaks PowerShell -InstallRoot "C:\path\" -FilesAlreadyInstalled
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Setup-FarmEdge.ps1" -InstallRoot "%ROOT%" -FilesAlreadyInstalled
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo ERROR code %ERR% - script failed to start the window.
  pause
)
endlocal
exit /b %ERR%