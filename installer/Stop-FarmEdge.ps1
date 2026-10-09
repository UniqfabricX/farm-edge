# Останавливает агент перед удалением (вызывается из Inno Setup Uninstall)
param([switch]$RemoveData)

$ErrorActionPreference = 'Continue'
$TaskName = 'FarmEdgeAgent'
$DataDir = Join-Path $env:ProgramData 'farm-edge'

schtasks /End /TN $TaskName 2>$null | Out-Null
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -like '*FarmEdge*index.js*' -or
    $_.CommandLine -like '*farm-edge*index.js*' -or
    $_.CommandLine -like '*Programs\FarmEdge*index.js*'
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$startup = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $startup 'Farm Edge Agent.lnk') -Force -ErrorAction SilentlyContinue

if ($RemoveData -and (Test-Path $DataDir)) {
  Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
}

exit 0
