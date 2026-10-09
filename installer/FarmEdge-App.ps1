# Farm Edge — Панель управления и System Tray приложение для Windows
# Запуск: powershell -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File FarmEdge-App.ps1 [-TrayOnly]

param(
  [switch]$TrayOnly
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Если запущен из installer/ или корня:
if (Test-Path (Join-Path $ScriptDir 'index.js')) {
  $AgentDir = $ScriptDir
  $InstallRoot = $ScriptDir
} elseif (Test-Path (Join-Path (Split-Path -Parent $ScriptDir) 'index.js')) {
  $AgentDir = Split-Path -Parent $ScriptDir
  $InstallRoot = $AgentDir
} else {
  $InstallRoot = Join-Path $env:LOCALAPPDATA 'FarmEdge'
  $AgentDir = if (Test-Path (Join-Path $InstallRoot 'agent\index.js')) { Join-Path $InstallRoot 'agent' } else { $InstallRoot }
}

$DataDir = Join-Path $env:ProgramData 'farm-edge'
$CredFile = Join-Path $DataDir 'credentials.json'
$CloudUrl = 'https://farm.5dsap.ru'
$BffUrl = 'http://127.0.0.1:3001'
$TelegramSupportUrl = 'https://t.me/tech5dsap'
$UpdateExeUrl = 'https://farm.5dsap.ru/downloads/FarmEdge-Setup.exe'
$AppVersion = '1.0.1'

# Чтение сохранённых данных
$AgentId = ''
if (Test-Path $CredFile) {
  try {
    $c = Get-Content $CredFile -Raw | ConvertFrom-Json
    if ($c.agent_id) { $AgentId = [string]$c.agent_id }
    if ($c.cloudUrl) { $CloudUrl = [string]$c.cloudUrl }
    if ($c.bffUrl) { $BffUrl = [string]$c.bffUrl }
  } catch {}
}

# Поиск node.exe
function Find-Node {
  $candidates = @(
    (Join-Path $InstallRoot 'node\node.exe'),
    (Join-Path (Split-Path -Parent $AgentDir) 'node\node.exe'),
    "$env:LOCALAPPDATA\Programs\node\node.exe",
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return 'node.exe'
}

$NodeExe = Find-Node

# ── Создание Tray Icon ────────────────────────────────────────────────────────
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

# Динамическая иконка (зелёный круг с галочкой)
function Create-FarmIcon {
  try {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(43, 170, 102))
    $g.FillEllipse($brush, 1, 1, 14, 14)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 2
    $g.DrawLine($pen, 4, 8, 7, 11)
    $g.DrawLine($pen, 7, 11, 12, 4)
    $hIcon = $bmp.GetHicon()
    return [System.Drawing.Icon]::FromHandle($hIcon)
  } catch {
    return [System.Drawing.SystemIcons]::Application
  }
}

$notifyIcon.Icon = Create-FarmIcon
$notifyIcon.Text = "Farm Edge — Агент фермы"
$notifyIcon.Visible = $true

# ── Главное окно ──────────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text = "Farm Edge v$AppVersion — Агент фермы"
$form.Size = New-Object System.Drawing.Size(640, 520)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.BackColor = [System.Drawing.Color]::FromArgb(248, 250, 252)

# Шапка
$pnlHeader = New-Object System.Windows.Forms.Panel
$pnlHeader.Location = New-Object System.Drawing.Point(0, 0)
$pnlHeader.Size = New-Object System.Drawing.Size(640, 72)
$pnlHeader.BackColor = [System.Drawing.Color]::FromArgb(255, 255, 255)
$pnlHeader.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$form.Controls.Add($pnlHeader)

$lblAppTitle = New-Object System.Windows.Forms.Label
$lblAppTitle.Text = "Farm Edge Agent v$AppVersion"
$lblAppTitle.Location = New-Object System.Drawing.Point(16, 12)
$lblAppTitle.Size = New-Object System.Drawing.Size(320, 24)
$lblAppTitle.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$lblAppTitle.ForeColor = [System.Drawing.Color]::FromArgb(15, 107, 70)
$pnlHeader.Controls.Add($lblAppTitle)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = if ($AgentId) { "● В сети · Привязан к $CloudUrl" } else { "○ Не привязан (требуется код из облака)" }
$lblStatus.Location = New-Object System.Drawing.Point(18, 40)
$lblStatus.Size = New-Object System.Drawing.Size(580, 20)
$lblStatus.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$lblStatus.ForeColor = if ($AgentId) { [System.Drawing.Color]::FromArgb(34, 197, 94) } else { [System.Drawing.Color]::FromArgb(220, 38, 38) }
$pnlHeader.Controls.Add($lblStatus)

# Панель кнопок
$pnlActions = New-Object System.Windows.Forms.Panel
$pnlActions.Location = New-Object System.Drawing.Point(16, 84)
$pnlActions.Size = New-Object System.Drawing.Size(592, 46)
$form.Controls.Add($pnlActions)

# 1. Кнопка Дашборд
$btnDashboard = New-Object System.Windows.Forms.Button
$btnDashboard.Text = "🌐 Дашборд"
$btnDashboard.Location = New-Object System.Drawing.Point(0, 4)
$btnDashboard.Size = New-Object System.Drawing.Size(120, 34)
$btnDashboard.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$btnDashboard.BackColor = [System.Drawing.Color]::FromArgb(43, 170, 102)
$btnDashboard.ForeColor = [System.Drawing.Color]::White
$btnDashboard.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$btnDashboard.FlatAppearance.BorderSize = 0
$btnDashboard.Add_Click({
  try { Start-Process $CloudUrl } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message) }
})
$pnlActions.Controls.Add($btnDashboard)

# 2. Кнопка Тикет / Чат с поддержкой в Telegram
$btnSupport = New-Object System.Windows.Forms.Button
$btnSupport.Text = "💬 Поддержка"
$btnSupport.Location = New-Object System.Drawing.Point(130, 4)
$btnSupport.Size = New-Object System.Drawing.Size(130, 34)
$btnSupport.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$btnSupport.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
$btnSupport.ForeColor = [System.Drawing.Color]::White
$btnSupport.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$btnSupport.FlatAppearance.BorderSize = 0
$btnSupport.Add_Click({
  try {
    Start-Process $TelegramSupportUrl
  } catch {
    [System.Windows.Forms.MessageBox]::Show("Не удалось открыть браузер. Ссылка поддержки: $TelegramSupportUrl", "Telegram поддержка")
  }
})
$pnlActions.Controls.Add($btnSupport)

# 3. Кнопка Обновить (скачивает и запускает установщик обновления)
$btnUpdate = New-Object System.Windows.Forms.Button
$btnUpdate.Text = "🔄 Обновить"
$btnUpdate.Location = New-Object System.Drawing.Point(270, 4)
$btnUpdate.Size = New-Object System.Drawing.Size(120, 34)
$btnUpdate.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$btnUpdate.BackColor = [System.Drawing.Color]::FromArgb(245, 158, 11)
$btnUpdate.ForeColor = [System.Drawing.Color]::White
$btnUpdate.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$btnUpdate.FlatAppearance.BorderSize = 0
$btnUpdate.Add_Click({
  Invoke-SelfUpdate
})
$pnlActions.Controls.Add($btnUpdate)

# 4. Кнопка Свернуть в трей
$btnTray = New-Object System.Windows.Forms.Button
$btnTray.Text = "🔽 В трей"
$btnTray.Location = New-Object System.Drawing.Point(400, 4)
$btnTray.Size = New-Object System.Drawing.Size(90, 34)
$btnTray.Add_Click({
  $form.Hide()
  $notifyIcon.ShowBalloonTip(1500, "Farm Edge", "Агент продолжает работать в трее.", [System.Windows.Forms.ToolTipIcon]::Info)
})
$pnlActions.Controls.Add($btnTray)

# 5. Кнопка Настройка / Перепривязать
$btnSettings = New-Object System.Windows.Forms.Button
$btnSettings.Text = "⚙ Код"
$btnSettings.Location = New-Object System.Drawing.Point(500, 4)
$btnSettings.Size = New-Object System.Drawing.Size(90, 34)
$btnSettings.Add_Click({
  $setupScript = Join-Path $ScriptDir 'Setup-FarmEdge.ps1'
  if (Test-Path $setupScript) {
    Start-Process powershell.exe -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', "`"$setupScript`"")
  }
})
$pnlActions.Controls.Add($btnSettings)

# Окно лога консоли
$lblLog = New-Object System.Windows.Forms.Label
$lblLog.Text = "Журнал работы агента (real-time console):"
$lblLog.Location = New-Object System.Drawing.Point(16, 138)
$lblLog.Size = New-Object System.Drawing.Size(300, 18)
$lblLog.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
$form.Controls.Add($lblLog)

$txtLog = New-Object System.Windows.Forms.TextBox
$txtLog.Location = New-Object System.Drawing.Point(16, 160)
$txtLog.Size = New-Object System.Drawing.Size(592, 300)
$txtLog.Multiline = $true
$txtLog.ScrollBars = 'Vertical'
$txtLog.ReadOnly = $true
$txtLog.BackColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
$txtLog.ForeColor = [System.Drawing.Color]::FromArgb(226, 232, 240)
$txtLog.Font = New-Object System.Drawing.Font('Consolas', 9)
$form.Controls.Add($txtLog)

function Append-Log([string]$msg) {
  $ts = Get-Date -Format 'HH:mm:ss'
  if ($txtLog -and -not $txtLog.IsDisposed) {
    $txtLog.AppendText("[$ts] $msg`r`n")
    $txtLog.SelectionStart = $txtLog.TextLength
    $txtLog.ScrollToCaret()
  }
}

# ── Функция скачивания и запуска обновления ──────────────────────────────────
function Invoke-SelfUpdate {
  $btnUpdate.Enabled = $false
  $btnUpdate.Text = "⏳ Скачивание..."
  Append-Log "Проверка обновления: скачивание с $UpdateExeUrl..."
  
  $tempExe = Join-Path $env:TEMP 'FarmEdge-Setup.exe'
  $job = {
    param($url, $dest)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 120
  }
  
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $UpdateExeUrl -OutFile $tempExe -UseBasicParsing -TimeoutSec 60
    Append-Log "Обновление скачано: $tempExe"
    
    $dlg = [System.Windows.Forms.MessageBox]::Show(
      "Новый установщик Farm Edge скачан.`r`n`r`nЗапустить установку прямо сейчас?`r`nПрежние настройки и привязка сохранятся.",
      "Farm Edge — Обновление готово",
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Question
    )
    
    if ($dlg -eq [System.Windows.Forms.DialogResult]::Yes) {
      Append-Log "Запуск установщика обновления..."
      Stop-AgentNode
      Start-Process -FilePath $tempExe
      $script:isExiting = $true
      $notifyIcon.Visible = $false
      $notifyIcon.Dispose()
      $form.Close()
      exit 0
    }
  } catch {
    Append-Log "Ошибка скачивания: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show(
      "Не удалось скачать обновление:`r`n$($_.Exception.Message)`r`n`r`nВы можете скачать его вручную:`r`n$UpdateExeUrl",
      "Ошибка обновления",
      'OK',
      'Error'
    ) | Out-Null
  } finally {
    $btnUpdate.Enabled = $true
    $btnUpdate.Text = "🔄 Обновить"
  }
}

# ── Контекстное меню System Tray ──────────────────────────────────────────────
$itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem "Панель управления Farm Edge"
$itemOpen.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$itemOpen.Add_Click({
  $form.Show()
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  $form.Activate()
})
$contextMenu.Items.Add($itemOpen) | Out-Null

$itemDash = New-Object System.Windows.Forms.ToolStripMenuItem "Открыть дашборд (farm.5dsap.ru)"
$itemDash.Add_Click({
  try { Start-Process $CloudUrl } catch {}
})
$contextMenu.Items.Add($itemDash) | Out-Null

$itemChat = New-Object System.Windows.Forms.ToolStripMenuItem "Чат с поддержкой / Тикет (Telegram)"
$itemChat.Add_Click({
  try { Start-Process $TelegramSupportUrl } catch {}
})
$contextMenu.Items.Add($itemChat) | Out-Null

$itemUpd = New-Object System.Windows.Forms.ToolStripMenuItem "Проверить и скачать обновление"
$itemUpd.Add_Click({
  Invoke-SelfUpdate
})
$contextMenu.Items.Add($itemUpd) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem "Выход (остановить агент)"
$itemExit.ForeColor = [System.Drawing.Color]::FromArgb(220, 38, 38)
$itemExit.Add_Click({
  $dlg = [System.Windows.Forms.MessageBox]::Show(
    "Вы уверены, что хотите остановить агент Farm Edge? Связь фермы с облаком будет приостановлена.",
    "Farm Edge — остановка",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($dlg -eq [System.Windows.Forms.DialogResult]::Yes) {
    $script:isExiting = $true
    Stop-AgentNode
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    $form.Close()
    [System.Windows.Forms.Application]::Exit()
  }
})
$contextMenu.Items.Add($itemExit) | Out-Null

$notifyIcon.ContextMenuStrip = $contextMenu

# Клик по иконке в трее открывает окно
$notifyIcon.Add_DoubleClick({
  $form.Show()
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  $form.Activate()
})
$notifyIcon.Add_Click({
  # Одинарный левый клик тоже активирует окно
  $form.Show()
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  $form.Activate()
})

# Сворачивание в трей при закрытии [X]
$script:isExiting = $false
$form.Add_FormClosing({
  if ($script:isExiting -ne $true) {
    $_.Cancel = $true
    $form.Hide()
    $notifyIcon.ShowBalloonTip(1500, "Farm Edge", "Агент свернут в трей и продолжает работать в фоне.", [System.Windows.Forms.ToolTipIcon]::Info)
  }
})

# ── Фоновый запуск Node.js агента ─────────────────────────────────────────────
$script:nodeProcess = $null

function Start-AgentNode {
  $idxJs = Join-Path $AgentDir 'index.js'
  if (-not (Test-Path $idxJs)) {
    Append-Log "ОШИБКА: Не найден файл $idxJs"
    return
  }

  Append-Log "Запуск ядра агента: $NodeExe index.js run..."
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $NodeExe
  $psi.Arguments = "`"$idxJs`" run --data `"$DataDir`" --bff `"$BffUrl`""
  $psi.WorkingDirectory = $AgentDir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  
  $psi.EnvironmentVariables['FARM_EDGE_DATA'] = $DataDir
  $psi.EnvironmentVariables['FARM_DATA_DIR'] = "$DataDir\data"
  $psi.EnvironmentVariables['FARM_BFF_URL'] = $BffUrl
  $psi.EnvironmentVariables['EDGE_CLOUD_URL'] = $CloudUrl

  try {
    $script:nodeProcess = [System.Diagnostics.Process]::Start($psi)
    
    # Асинхронное чтение stdout
    Register-ObjectEvent -InputObject $script:nodeProcess -EventName OutputDataReceived -Action {
      if ($EventArgs.Data) {
        $msg = $EventArgs.Data
        # Вызов в UI потоке
        if ($form -and -not $form.IsDisposed) {
          $form.BeginInvoke([Action[string]]{ param($m) Append-Log $m }, $msg) | Out-Null
        }
      }
    } | Out-Null
    $script:nodeProcess.BeginOutputReadLine()

    # Асинхронное чтение stderr
    Register-ObjectEvent -InputObject $script:nodeProcess -EventName ErrorDataReceived -Action {
      if ($EventArgs.Data) {
        $msg = $EventArgs.Data
        if ($form -and -not $form.IsDisposed) {
          $form.BeginInvoke([Action[string]]{ param($m) Append-Log "ERR: $m" }, $msg) | Out-Null
        }
      }
    } | Out-Null
    $script:nodeProcess.BeginErrorReadLine()

    Append-Log "Ядро агента запущено (PID $($script:nodeProcess.Id))."
  } catch {
    Append-Log "Не удалось запустить процесс: $($_.Exception.Message)"
  }
}

function Stop-AgentNode {
  if ($script:nodeProcess -and -not $script:nodeProcess.HasExited) {
    try {
      Append-Log "Остановка процесса PID $($script:nodeProcess.Id)..."
      $script:nodeProcess.Kill()
    } catch {}
  }
}

# Запуск агента
Start-AgentNode

# Если указан ключ -TrayOnly (например, из автозапуска Windows) — не показываем окно сразу
if ($TrayOnly) {
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
  $form.ShowInTaskbar = $false
  $form.Hide()
  $notifyIcon.ShowBalloonTip(2000, "Farm Edge", "Агент запущен в трее возле часов.", [System.Windows.Forms.ToolTipIcon]::Info)
} else {
  $form.Show()
}

[System.Windows.Forms.Application]::Run($form)
