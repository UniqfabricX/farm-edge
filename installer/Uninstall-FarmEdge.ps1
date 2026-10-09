# Удаление Farm Edge с этого ПК (zip-установка).
# Для .exe-установки: Параметры Windows → Приложения → Farm Edge.
param([switch]$KeepCredentials)

$ErrorActionPreference = 'Continue'
$roots = @(
  (Join-Path $env:LOCALAPPDATA 'FarmEdge'),
  (Join-Path $env:LOCALAPPDATA 'Programs\FarmEdge')
)
$DataDir = Join-Path $env:ProgramData 'farm-edge'
$TaskName = 'FarmEdgeAgent'

Write-Host 'Stopping scheduled task / process…'
schtasks /End /TN $TaskName 2>$null | Out-Null
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*FarmEdge*index.js*' -or $_.CommandLine -like '*farm-edge*index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$startup = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $startup 'Farm Edge Agent.lnk') -Force -ErrorAction SilentlyContinue

foreach ($InstallRoot in $roots) {
  if (Test-Path $InstallRoot) {
    Remove-Item $InstallRoot -Recurse -Force
    Write-Host "Removed $InstallRoot"
  }
}

if (-not $KeepCredentials -and (Test-Path $DataDir)) {
  Remove-Item $DataDir -Recurse -Force
  Write-Host "Removed $DataDir (credentials)"
} elseif ($KeepCredentials) {
  Write-Host "Kept credentials in $DataDir"
}

Write-Host 'Done. In cloud Admin → revoke the agent if it is still listed.'
pause
