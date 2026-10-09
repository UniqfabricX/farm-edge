@echo off
setlocal
cd /d "%~dp0"
start "" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0FarmEdge-App.ps1" %*
endlocal
