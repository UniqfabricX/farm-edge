# Farm Edge setup for Windows
# Run via Connect-FarmEdge.bat or Install-FarmEdge.bat

param(
  [string]$Code = '',
  [string]$Cloud = 'https://farm.5dsap.ru',
  [string]$Bff = 'http://127.0.0.1:3001',
  [string]$InstallRoot = '',
  [switch]$FilesAlreadyInstalled,
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PayloadDir = Join-Path $ScriptDir 'payload'
if (-not $InstallRoot) {
  if ($FilesAlreadyInstalled) {
    $InstallRoot = $ScriptDir
  } else {
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'FarmEdge'
  }
}
$InstallRoot = $InstallRoot.TrimEnd('\', '/')
if ($FilesAlreadyInstalled) {
  $AgentDir = $InstallRoot
} else {
  $AgentDir = Join-Path $InstallRoot 'agent'
}
$NodeDir = Join-Path $InstallRoot 'node'
$DataDir = Join-Path $env:ProgramData 'farm-edge'
$TaskName = 'FarmEdgeAgent'
$DefaultCloud = 'https://farm.5dsap.ru'
$DefaultBff = 'http://127.0.0.1:3001'
$NodeVersion = '20.18.1'
if (-not $Cloud) { $Cloud = $DefaultCloud }
if (-not $Bff) { $Bff = $DefaultBff }

function Write-Log([string]$msg) {
  $ts = Get-Date -Format 'HH:mm:ss'
  if ($script:logBox -and -not $script:logBox.IsDisposed) {
    $script:logBox.AppendText("[$ts] $msg`r`n")
    $script:logBox.SelectionStart = $script:logBox.TextLength
    $script:logBox.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
  }
  Write-Host "[$ts] $msg"
}

function Test-NodeOk([string]$nodeExe) {
  if (-not (Test-Path $nodeExe)) { return $false }
  try {
    $v = & $nodeExe -v 2>$null
    if ($v -match 'v(\d+)\.') {
      return [int]$Matches[1] -ge 20
    }
  } catch {}
  return $false
}

function Find-SystemNode {
  $candidates = @()
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  $candidates += @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\node\node.exe"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-NodeOk $c)) { return $c }
  }
  return $null
}

function Install-PortableNode {
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  $zipName = "node-v$NodeVersion-win-$arch.zip"
  $url = "https://nodejs.org/dist/v$NodeVersion/$zipName"
  $zipPath = Join-Path $env:TEMP $zipName
  Write-Log "Downloading Node.js $NodeVersion ($arch)..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
  if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  Write-Log 'Extracting Node...'
  Expand-Archive -Path $zipPath -DestinationPath $InstallRoot -Force
  $extracted = Get-ChildItem $InstallRoot -Directory | Where-Object { $_.Name -like "node-v$NodeVersion-*" } | Select-Object -First 1
  if (-not $extracted) { throw 'Failed to extract Node' }
  if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
  Rename-Item $extracted.FullName $NodeDir -Force
  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
  $exe = Join-Path $NodeDir 'node.exe'
  if (-not (Test-NodeOk $exe)) { throw 'Node does not work after install' }
  Write-Log "Node ready: $exe"
  return $exe
}

function Ensure-Node {
  $portable = Join-Path $NodeDir 'node.exe'
  if (Test-NodeOk $portable) { return $portable }
  $sys = Find-SystemNode
  if ($sys) {
    Write-Log "Using system Node: $sys"
    return $sys
  }
  return Install-PortableNode
}

function Copy-Payload {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  if ($FilesAlreadyInstalled) {
    if (-not (Test-Path (Join-Path $AgentDir 'index.js'))) {
      throw "Agent not found in $AgentDir. Reinstall Farm Edge."
    }
    Write-Log "Files already installed: $AgentDir"
    return
  }
  if (-not (Test-Path $PayloadDir)) {
    throw 'payload folder missing. Use FarmEdge-Setup.exe or full FarmEdge-Setup-win.zip.'
  }
  Write-Log "Copying agent to $AgentDir ..."
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  if (Test-Path $AgentDir) { Remove-Item $AgentDir -Recurse -Force }
  Copy-Item -Path $PayloadDir -Destination $AgentDir -Recurse -Force
  Write-Log 'Agent copied.'
}

function Invoke-NpmInstall([string]$nodeExe) {
  $npmCmd = Join-Path (Split-Path $nodeExe) 'npm.cmd'
  if (-not (Test-Path $npmCmd)) {
    $npmCmd = Join-Path $NodeDir 'npm.cmd'
  }
  Push-Location $AgentDir
  try {
    if (Test-Path (Join-Path $AgentDir 'node_modules\ws')) {
      Write-Log 'Dependencies already present (node_modules).'
      return
    }
    if (-not (Test-Path $npmCmd)) {
      throw 'npm not found. Installer will download portable Node - retry, or install Node.js 20+.'
    }
    Write-Log 'Running npm install...'
    & $npmCmd install --omit=dev --no-fund --no-audit 2>&1 | ForEach-Object { Write-Log "$_" }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function Stop-RunningAgent {
  # A running agent keeps the OLD credentials in memory. If we re-pair without
  # stopping it, it keeps hitting the cloud with a stale secret (HTTP 401 loop)
  # and the freshly started agent exits on the run-lock ("another agent already running").
  $stopped = 0
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -like '*FarmEdge*index.js*' -or
      $_.CommandLine -like '*farm-edge*index.js*' -or
      $_.CommandLine -like "*$AgentDir*index.js*"
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped++
    }
  if ($stopped -gt 0) {
    Write-Log "Stopped $stopped running agent process(es)."
    Start-Sleep -Milliseconds 1500
  }
  Remove-Item (Join-Path $DataDir 'agent.run.lock') -Force -ErrorAction SilentlyContinue
}

function Invoke-Pair([string]$nodeExe, [string]$pairCode, [string]$cloudUrl, [string]$bffUrl) {
  $credFile = Join-Path $DataDir 'credentials.json'
  $backup = $null

  if (Test-Path $credFile) {
    if (-not $pairCode) {
      # No code given (e.g. silent re-run): keep existing credentials, just (re)start the agent.
      Write-Log 'Credentials already present and no pairing code given - keeping them.'
      Stop-RunningAgent
      return
    }
    # A pairing code was entered → the user explicitly wants a NEW pairing.
    # Old credentials may already be revoked in the cloud (agent gets HTTP 401),
    # so never skip the claim here. Keep a backup to restore if the claim fails.
    $pairedAt = ''
    try { $pairedAt = [string]((Get-Content $credFile -Raw | ConvertFrom-Json).pairedAt) } catch {}
    $backup = Join-Path $DataDir ('credentials.json.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Write-Log ("Existing credentials found" + $(if ($pairedAt) { " (paired $pairedAt)" } else { '' }) + " - re-pairing with the new code.")
    Stop-RunningAgent
    Move-Item $credFile $backup -Force
    Write-Log "Old credentials backed up: $backup"
  } else {
    Stop-RunningAgent
  }

  Write-Log 'Pairing with cloud...'
  $env:FARM_EDGE_DATA = $DataDir
  $env:EDGE_CLOUD_URL = $cloudUrl
  $env:FARM_BFF_URL = $bffUrl
  $pairScript = Join-Path $AgentDir 'index.js'
  $prevOut = [Console]::OutputEncoding
  $prevEap = $ErrorActionPreference
  $exit = 1
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    # With $ErrorActionPreference='Stop' any stderr line from node becomes a terminating
    # NativeCommandError and we would never reach the exit-code / restore logic below.
    $ErrorActionPreference = 'Continue'
    $out = & $nodeExe $pairScript pair --code $pairCode --cloud $cloudUrl --bff $bffUrl --data $DataDir 2>&1
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
    [Console]::OutputEncoding = $prevOut
  }
  foreach ($line in @($out)) {
    $text = if ($line -is [System.Management.Automation.ErrorRecord]) { $line.ToString() } else { [string]$line }
    Write-Log $text
  }
  if ($exit -ne 0) {
    if ($backup -and (Test-Path $backup) -and -not (Test-Path $credFile)) {
      Move-Item $backup $credFile -Force
      Write-Log 'Claim failed - previous credentials restored (agent NOT restarted; get a new code and click Connect again).'
    }
    $msg = ($out | ForEach-Object { "$_" }) -join ' '
    # Cloud replies in Russian ("Неверный или истёкший код привязки", code PAIR_INVALID).
    # Cyrillic as \u escapes: keeps the pattern ASCII-safe for PowerShell 5.1 without BOM.
    if ($msg -match 'PAIR_INVALID|\u041d\u0435\u0432\u0435\u0440\u043d|\u0438\u0441\u0442[\u0435\u0451]\u043a\u0448|expired|invalid|Neverni|ist.?k') {
      throw 'Pairing code invalid or already used. In Admin click Get pairing code again, then Connect once.'
    }
    throw "Pairing failed (code $exit). Check code and internet. $msg"
  }
  if (-not (Test-Path $credFile)) {
    throw 'Pairing reported success but credentials.json was not written.'
  }
  if ($backup -and (Test-Path $backup)) {
    # Keep only the latest backup to avoid piling up secrets on disk.
    Get-ChildItem $DataDir -Filter 'credentials.json.bak-*' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

function Register-Autostart([string]$nodeExe, [string]$bffUrl, [string]$cloudUrl) {
  Write-Log "Registering autostart ($TaskName)..."
  $runner = Join-Path $InstallRoot 'run-edge.cmd'
  $appPs1 = Join-Path $InstallRoot 'FarmEdge-App.ps1'
  if (-not (Test-Path $appPs1) -and (Test-Path (Join-Path $AgentDir 'FarmEdge-App.ps1'))) {
    $appPs1 = Join-Path $AgentDir 'FarmEdge-App.ps1'
  } elseif (-not (Test-Path $appPs1) -and (Test-Path (Join-Path $ScriptDir 'FarmEdge-App.ps1'))) {
    Copy-Item (Join-Path $ScriptDir 'FarmEdge-App.ps1') $InstallRoot -Force
    $appPs1 = Join-Path $InstallRoot 'FarmEdge-App.ps1'
  }

  $lines = @(
    '@echo off',
    "cd /d `"$AgentDir`"",
    "set FARM_EDGE_DATA=$DataDir",
    "set FARM_DATA_DIR=$DataDir\data",
    "set FARM_BFF_URL=$bffUrl",
    "set EDGE_CLOUD_URL=$cloudUrl",
    "start `"`" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$appPs1`" -TrayOnly"
  )
  Set-Content -Path $runner -Value ($lines -join "`r`n") -Encoding ASCII
  if (-not (Test-Path $runner)) { throw "Failed to write $runner" }

  # Создаём FarmEdge.cmd для ручного запуска окна
  $appCmd = Join-Path $InstallRoot 'FarmEdge.cmd'
  $appLines = @(
    '@echo off',
    "cd /d `"$AgentDir`"",
    "start `"`" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$appPs1`""
  )
  Set-Content -Path $appCmd -Value ($appLines -join "`r`n") -Encoding ASCII

  # Do NOT call schtasks under ErrorAction Stop: missing task on /Delete
  # throws "cannot find the file specified" and aborts after a successful pair.
  $taskOk = $false
  try {
    cmd.exe /c "schtasks /Delete /TN `"$TaskName`" /F >nul 2>&1"
    cmd.exe /c "schtasks /Create /TN `"$TaskName`" /SC ONLOGON /RL LIMITED /F /TR `"\`"$runner\`"`" >nul 2>&1"
    if ($LASTEXITCODE -eq 0) { $taskOk = $true }
  } catch {
    $taskOk = $false
  }

  if ($taskOk) {
    Write-Log "Scheduled task created: $TaskName"
  } else {
    Write-Log 'Scheduled task unavailable - using Startup folder shortcut'
    $startup = [Environment]::GetFolderPath('Startup')
    $lnkPath = Join-Path $startup 'Farm Edge Agent.lnk'
    $w = New-Object -ComObject WScript.Shell
    $lnk = $w.CreateShortcut($lnkPath)
    $lnk.TargetPath = $runner
    $lnk.WorkingDirectory = $AgentDir
    $lnk.WindowStyle = 7
    $lnk.Save()
    Write-Log "Startup shortcut: $lnkPath"
  }

  # Ярлык на рабочем столе
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $deskLnk = Join-Path $desktop 'Farm Edge.lnk'
    $w = New-Object -ComObject WScript.Shell
    $lnk = $w.CreateShortcut($deskLnk)
    $lnk.TargetPath = $appCmd
    $lnk.WorkingDirectory = $AgentDir
    $lnk.Description = "Farm Edge — Панель агента 3D-фермы"
    $lnk.Save()
  } catch {}

  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"$runner`"") -WorkingDirectory $AgentDir -WindowStyle Minimized | Out-Null
  Write-Log 'Agent started in System Tray.'
}

function Show-Wizard {
  $credFile = Join-Path $DataDir 'credentials.json'
  $hasExistingCreds = $false
  $existingAgentId = ''
  if (Test-Path $credFile) {
    try {
      $cJson = Get-Content $credFile -Raw | ConvertFrom-Json
      if ($cJson.agent_id -and $cJson.agent_secret) {
        $hasExistingCreds = $true
        $existingAgentId = [string]$cJson.agent_id
        if ($cJson.cloudUrl) { $Cloud = [string]$cJson.cloudUrl }
        if ($cJson.bffUrl) { $Bff = [string]$cJson.bffUrl }
      }
    } catch {}
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = if ($hasExistingCreds) { 'Farm Edge — обновление агента' } elseif ($FilesAlreadyInstalled) { 'Farm Edge — подключение' } else { 'Farm Edge — установка' }
  $form.Size = New-Object System.Drawing.Size(560, 520)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

  $lblTitle = New-Object System.Windows.Forms.Label
  $lblTitle.Text = if ($hasExistingCreds) { 'Обновление Farm Edge (привязка сохранена)' } else { 'Подключение домашней фермы к farm.5dsap.ru' }
  $lblTitle.Location = New-Object System.Drawing.Point(16, 14)
  $lblTitle.Size = New-Object System.Drawing.Size(520, 24)
  $lblTitle.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $lblTitle.ForeColor = if ($hasExistingCreds) { [System.Drawing.Color]::FromArgb(15, 107, 70) } else { [System.Drawing.Color]::Black }
  $form.Controls.Add($lblTitle)

  $lblHelp = New-Object System.Windows.Forms.Label
  if ($hasExistingCreds) {
    $lblHelp.Text = "Обнаружена существующая привязка (Agent ID: $existingAgentId).`r`nПри обновлении код привязки вводить заново НЕ ТРЕБУЕТСЯ.`r`nНажмите «Обновить агент» для установки новой версии поверх старой."
    $lblHelp.ForeColor = [System.Drawing.Color]::FromArgb(34, 197, 94)
  } else {
    $actionHint = if ($FilesAlreadyInstalled) { '«Подключить»' } else { '«Установить и подключить»' }
    $lblHelp.Text = "1) Откройте https://farm.5dsap.ru -> Администрирование -> Получить код привязки`r`n2) Введите код ниже и нажмите $actionHint."
  }
  $lblHelp.Location = New-Object System.Drawing.Point(16, 44)
  $lblHelp.Size = New-Object System.Drawing.Size(520, 42)
  $form.Controls.Add($lblHelp)

  $lblCode = New-Object System.Windows.Forms.Label
  $lblCode.Text = if ($hasExistingCreds) { 'Новый код привязки (оставьте пустым для сохранения)' } else { 'Код привязки (Pairing code)' }
  $lblCode.Location = New-Object System.Drawing.Point(16, 92)
  $lblCode.AutoSize = $true
  $form.Controls.Add($lblCode)

  $txtCode = New-Object System.Windows.Forms.TextBox
  $txtCode.Location = New-Object System.Drawing.Point(16, 112)
  $txtCode.Size = New-Object System.Drawing.Size(200, 24)
  $txtCode.Font = New-Object System.Drawing.Font('Consolas', 12, [System.Drawing.FontStyle]::Bold)
  $txtCode.CharacterCasing = 'Upper'
  $form.Controls.Add($txtCode)

  $lblCloud = New-Object System.Windows.Forms.Label
  $lblCloud.Text = 'Cloud URL'
  $lblCloud.Location = New-Object System.Drawing.Point(240, 92)
  $lblCloud.AutoSize = $true
  $form.Controls.Add($lblCloud)

  $txtCloud = New-Object System.Windows.Forms.TextBox
  $txtCloud.Text = $Cloud
  $txtCloud.Location = New-Object System.Drawing.Point(240, 112)
  $txtCloud.Size = New-Object System.Drawing.Size(280, 24)
  $form.Controls.Add($txtCloud)

  $chkBff = New-Object System.Windows.Forms.CheckBox
  $chkBff.Text = 'Локальный farm-bff запущен на этом ПК (порт 3001)'
  $chkBff.Checked = $false
  $chkBff.Location = New-Object System.Drawing.Point(16, 150)
  $chkBff.Size = New-Object System.Drawing.Size(500, 22)
  $form.Controls.Add($chkBff)

  $lblBff = New-Object System.Windows.Forms.Label
  $lblBff.Text = 'farm-bff URL'
  $lblBff.Location = New-Object System.Drawing.Point(16, 178)
  $lblBff.AutoSize = $true
  $form.Controls.Add($lblBff)

  $txtBff = New-Object System.Windows.Forms.TextBox
  $txtBff.Text = $Bff
  $txtBff.Location = New-Object System.Drawing.Point(16, 198)
  $txtBff.Size = New-Object System.Drawing.Size(504, 24)
  $form.Controls.Add($txtBff)

  $script:logBox = New-Object System.Windows.Forms.TextBox
  $script:logBox.Multiline = $true
  $script:logBox.ScrollBars = 'Vertical'
  $script:logBox.ReadOnly = $true
  $script:logBox.Location = New-Object System.Drawing.Point(16, 236)
  $script:logBox.Size = New-Object System.Drawing.Size(504, 180)
  $script:logBox.Font = New-Object System.Drawing.Font('Consolas', 8)
  $form.Controls.Add($script:logBox)

  $btnInstall = New-Object System.Windows.Forms.Button
  $btnInstall.Text = if ($hasExistingCreds) { '🔄 Обновить агент' } elseif ($FilesAlreadyInstalled) { 'Подключить' } else { 'Установить и подключить' }
  $btnInstall.Location = New-Object System.Drawing.Point(16, 430)
  $btnInstall.Size = New-Object System.Drawing.Size(220, 36)
  $btnInstall.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($btnInstall)

  $btnClose = New-Object System.Windows.Forms.Button
  $btnClose.Text = 'Закрыть'
  $btnClose.Location = New-Object System.Drawing.Point(400, 430)
  $btnClose.Size = New-Object System.Drawing.Size(120, 36)
  $btnClose.Add_Click({ $form.Close() })
  $form.Controls.Add($btnClose)

  $btnInstall.Add_Click({
      try {
        $btnInstall.Enabled = $false
        $pairCode = ($txtCode.Text -replace '\s', '').Trim()
        if (-not $hasExistingCreds -and $pairCode.Length -lt 6) {
          throw 'Введите 8-значный код привязки из облака (например ABCD-EFGH).'
        }
        $cloudUrl = $txtCloud.Text.Trim().TrimEnd('/')
        if (-not $cloudUrl) { $cloudUrl = $DefaultCloud }
        $bffUrl = if ($chkBff.Checked) { $txtBff.Text.Trim().TrimEnd('/') } else { $DefaultBff }
        if (-not $bffUrl) { $bffUrl = $DefaultBff }

        Copy-Payload
        $nodeExe = Ensure-Node
        Invoke-NpmInstall $nodeExe
        Invoke-Pair $nodeExe $pairCode $cloudUrl $bffUrl
        Register-Autostart $nodeExe $bffUrl $cloudUrl

        Write-Log ''
        if ($hasExistingCreds -and -not $pairCode) {
          Write-Log 'Обновление успешно завершено! Привязка сохранена.'
          $doneMsgRu = "Агент Farm Edge успешно обновлён!`r`n`r`nПрежняя привязка сохранена (Agent ID: $existingAgentId).`r`nАгент запущен и свёрнут в трей возле часов."
          [System.Windows.Forms.MessageBox]::Show(
            $doneMsgRu,
            'Farm Edge — обновление завершено',
            'OK',
            'Information'
          ) | Out-Null
        } else {
          Write-Log 'Успешно подключено!'
          $adminUrl = ($cloudUrl.TrimEnd('/') + '/')
          $doneMsgRu = "Всё успешно!`r`n`r`nАгент подключён к облаку.`r`nПродолжайте на сайте:`r`n$adminUrl`r`n`r`nАгент работает в трее возле часов."
          [System.Windows.Forms.MessageBox]::Show(
            $doneMsgRu,
            'Farm Edge — успешно',
            'OK',
            'Information'
          ) | Out-Null
          try { Start-Process $adminUrl } catch {}
        }
        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Close()
        return
      } catch {
        Write-Log ("ERROR: " + $_.Exception.Message)
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Farm Edge error', 'OK', 'Error') | Out-Null
      } finally {
        if (-not $form.IsDisposed) { $btnInstall.Enabled = $true }
      }
    })

  [void]$form.ShowDialog()
}

try {
  $credFile = Join-Path $DataDir 'credentials.json'
  $hasCreds = (Test-Path $credFile)
  if ($Silent) {
    if ($Code -or $hasCreds) {
      Copy-Payload
      $nodeExe = Ensure-Node
      Invoke-NpmInstall $nodeExe
      Invoke-Pair $nodeExe $(if ($Code) { $Code } else { '' }) $Cloud $Bff
      Register-Autostart $nodeExe $Bff $Cloud
      Write-Host 'OK'
      exit 0
    }
  }
  Show-Wizard
} catch {
  [System.Windows.Forms.MessageBox]::Show(
    $_.Exception.Message,
    'Farm Edge failed to start',
    'OK',
    'Error'
  ) | Out-Null
  Write-Host $_.Exception.Message
  exit 1
}