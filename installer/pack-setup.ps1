# Builds FarmEdge-Setup.exe (Inno Setup) + FarmEdge-Setup-win.zip for clients.
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File edge-agent/installer/pack-setup.ps1

param(
  [switch]$SkipExe,
  [switch]$SkipZip,
  [switch]$NoPublish,
  # Authenticode signing (removes the Windows SmartScreen "unknown publisher" warning
  # once an OV/EV code-signing certificate is installed in CurrentUser\My or LocalMachine\My).
  # Pass the certificate SHA-1 thumbprint, or set FARM_EDGE_SIGN_THUMBPRINT in the environment.
  [string]$SignThumbprint = $env:FARM_EDGE_SIGN_THUMBPRINT,
  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$AgentSrc = $Root
$ServerSrc = Join-Path $Root 'lib\server'
$OutDir = Join-Path $AgentSrc 'dist'
$PublishDir = Join-Path $OutDir 'downloads'
$ZipStage = Join-Path $OutDir 'FarmEdge-Setup'
$InnoStage = Join-Path $OutDir 'inno-stage'
$Zip = Join-Path $OutDir 'FarmEdge-Setup-win.zip'
$ExeOut = Join-Path $OutDir 'FarmEdge-Setup.exe'
$Pkg = Get-Content (Join-Path $AgentSrc 'package.json') -Raw | ConvertFrom-Json
$AppVersion = [string]$Pkg.version
if (-not $AppVersion) { $AppVersion = '1.0.0' }

$InnoUrl = 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe'
$ToolsDir = Join-Path $OutDir 'tools'
$InnoInstaller = Join-Path $ToolsDir 'innosetup-6.7.3.exe'
$InnoInstallDir = Join-Path $ToolsDir 'InnoSetup6'

function New-Payload([string]$Payload) {
  if (Test-Path $Payload) { Remove-Item $Payload -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Payload | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Payload 'lib\server') | Out-Null

  Copy-Item (Join-Path $AgentSrc 'index.js') $Payload
  Copy-Item (Join-Path $AgentSrc 'config.js') $Payload
  Copy-Item (Join-Path $AgentSrc 'rpc-handler.js') $Payload
  Copy-Item (Join-Path $AgentSrc 'package.json') $Payload
  Copy-Item (Join-Path $AgentSrc 'package-lock.json') $Payload -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $AgentSrc 'README.md') $Payload -ErrorAction SilentlyContinue

  $serverFiles = @('scanner.js', 'printer-logs.js', 'bambu-errors.js', 'elegoo-sdcp.js', 'bambu-discover.js', 'warehouse.js', 'otm-bridge.js')
  foreach ($f in $serverFiles) {
    $src = Join-Path $ServerSrc $f
    if (Test-Path $src) {
      Copy-Item $src (Join-Path $Payload "lib\server\$f")
    }
  }

  Push-Location $Payload
  try {
    if (Get-Command npm -ErrorAction SilentlyContinue) {
      if (Test-Path (Join-Path $Payload 'package-lock.json')) {
        Write-Host 'npm ci in payload…'
        npm ci --omit=dev --no-fund --no-audit | Out-Host
      } else {
        Write-Host 'npm install in payload…'
        npm install --omit=dev --no-fund --no-audit | Out-Host
      }
    } else {
      Write-Warning 'npm not found — client installer will download Node and run npm.'
    }
  } finally {
    Pop-Location
  }
}

function Copy-InstallerDocs([string]$Dest, [switch]$ForExe) {
  # Ensure PowerShell 5.1 can parse Cyrillic/Unicode: UTF-8 with BOM
  $ps1 = Join-Path $PSScriptRoot 'Setup-FarmEdge.ps1'
  $raw = [System.IO.File]::ReadAllText($ps1)
  $utf8Bom = New-Object System.Text.UTF8Encoding $true
  [System.IO.File]::WriteAllText((Join-Path $Dest 'Setup-FarmEdge.ps1'), $raw, $utf8Bom)

  Copy-Item (Join-Path $PSScriptRoot 'Install-FarmEdge.bat') $Dest -Force
  Copy-Item (Join-Path $PSScriptRoot 'Connect-FarmEdge.bat') $Dest -Force
  Copy-Item (Join-Path $PSScriptRoot 'Stop-FarmEdge.ps1') $Dest -Force
  Copy-Item (Join-Path $PSScriptRoot 'Uninstall-FarmEdge.ps1') $Dest -Force
  Copy-Item (Join-Path $PSScriptRoot 'INSTRUCTIONS-RU.html') $Dest -Force
  Copy-Item (Join-Path $PSScriptRoot 'INSTRUCTION-RU.txt') $Dest -Force
}

function Find-ISCC {
  $candidates = @(
    (Join-Path $InnoInstallDir 'ISCC.exe'),
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "${env:LocalAppData}\Programs\Inno Setup 6\ISCC.exe"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Ensure-InnoSetup {
  $iscc = Find-ISCC
  if ($iscc) { return $iscc }

  New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
  if (-not (Test-Path $InnoInstaller)) {
    Write-Host "Downloading Inno Setup 6.7.3…"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $InnoUrl -OutFile $InnoInstaller -UseBasicParsing
  }
  Write-Host "Installing Inno Setup (silent) → $InnoInstallDir"
  if (Test-Path $InnoInstallDir) { Remove-Item $InnoInstallDir -Recurse -Force -ErrorAction SilentlyContinue }
  $args = @(
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    "/DIR=$InnoInstallDir",
    '/TASKS='
  )
  $p = Start-Process -FilePath $InnoInstaller -ArgumentList $args -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 1) {
    # some Inno installers return 0 only; continue if ISCC appears
  }
  $iscc = Find-ISCC
  if (-not $iscc) { throw 'ISCC.exe not found after Inno Setup install' }
  return $iscc
}

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path $kits) {
    $found = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' } |
      Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  return $null
}

# Resolve signing once; both the Inno SignTool directive and the post-build check use it.
# $SignCommand is the command Inno runs for Setup.exe and the uninstaller ($f = file path).
$SignCommand = $null
if ($SignThumbprint) {
  $SignThumbprint = ($SignThumbprint -replace '\s', '').ToUpperInvariant()
  $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $SignThumbprint } | Select-Object -First 1
  if (-not $cert) { throw "Code-signing certificate $SignThumbprint not found in CurrentUser\My or LocalMachine\My." }
  $SignTool = Find-SignTool
  if ($SignTool) {
    $SignCommand = "`"$SignTool`" sign /sha1 $SignThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 `$f"
    Write-Host "Signing via signtool.exe: $SignTool"
  } else {
    # No Windows SDK: fall back to PowerShell Set-AuthenticodeSignature (works with token certs too).
    $signPs1 = Join-Path $PSScriptRoot 'sign-file.ps1'
    $SignCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$signPs1`" -Thumbprint $SignThumbprint -TimestampUrl $TimestampUrl -File `$f"
    Write-Host 'Signing via PowerShell Set-AuthenticodeSignature (signtool.exe not installed)'
  }
  Write-Host "Signing with: $($cert.Subject) (expires $($cert.NotAfter.ToString('yyyy-MM-dd')))"
} else {
  Write-Warning 'No code-signing certificate configured: FarmEdge-Setup.exe will be UNSIGNED and Windows SmartScreen will show "Unknown publisher". Pass -SignThumbprint once a certificate is installed.'
}

Write-Host "Root: $Root"
Write-Host "Version: $AppVersion"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ── Zip pack (portable fallback) ───────────────────────────────────────────
if (-not $SkipZip) {
  if (Test-Path $ZipStage) { Remove-Item $ZipStage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $ZipStage | Out-Null
  $payload = Join-Path $ZipStage 'payload'
  New-Payload $payload
  Copy-InstallerDocs $ZipStage
  if (Test-Path $Zip) { Remove-Item $Zip -Force }
  Compress-Archive -Path (Join-Path $ZipStage '*') -DestinationPath $Zip -Force
  Write-Host "OK zip: $Zip"
  Get-Item $Zip | Format-List FullName, Length, LastWriteTime
}

# ── EXE via Inno Setup ─────────────────────────────────────────────────────
if (-not $SkipExe) {
  if (Test-Path $InnoStage) { Remove-Item $InnoStage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $InnoStage | Out-Null

  # Flat layout: agent files at {app}\ root (FilesAlreadyInstalled)
  if ($SkipZip -or -not (Test-Path (Join-Path $ZipStage 'payload'))) {
    New-Payload (Join-Path $InnoStage '_payload_tmp')
    Copy-Item (Join-Path $InnoStage '_payload_tmp\*') $InnoStage -Recurse -Force
    Remove-Item (Join-Path $InnoStage '_payload_tmp') -Recurse -Force
  } else {
    Copy-Item (Join-Path $ZipStage 'payload\*') $InnoStage -Recurse -Force
  }
  Copy-InstallerDocs $InnoStage -ForExe

  $iscc = Ensure-InnoSetup
  Write-Host "ISCC: $iscc"
  $iss = Join-Path $PSScriptRoot 'FarmEdge.iss'
  if (Test-Path $ExeOut) { Remove-Item $ExeOut -Force }

  $isccArgs = @(
    '/Q',
    "/DStageDir=$InnoStage",
    "/DAppVersion=$AppVersion",
    "/O$OutDir",
    '/FFarmEdge-Setup'
  )
  if ($SignCommand) {
    # Inno Setup signs Setup.exe AND the embedded uninstaller through this named tool
    # (see SignTool= / SignedUninstaller= in FarmEdge.iss, enabled by /DSignBuild).
    $isccArgs += "/Ssigntool=$SignCommand"
    $isccArgs += '/DSignBuild=1'
  }
  & $iscc @isccArgs $iss

  if (-not (Test-Path $ExeOut)) { throw "Build failed - missing $ExeOut" }
  if ($SignCommand) {
    $sig = Get-AuthenticodeSignature $ExeOut
    if (-not $sig.SignerCertificate -or $sig.SignerCertificate.Thumbprint -ne $SignThumbprint) {
      throw "Setup.exe is not signed with $SignThumbprint (status $($sig.Status))"
    }
    if ($sig.Status -ne 'Valid') {
      # UnknownError = chain not trusted on the build machine (self-signed test cert); real CA certs must be Valid.
      Write-Warning "Setup.exe signed, but signature status is $($sig.Status) on this machine: $($sig.StatusMessage)"
    } else {
      Write-Host "Signature OK: $($sig.SignerCertificate.Subject)"
    }
  }
  Write-Host "OK exe: $ExeOut"
  Get-Item $ExeOut | Format-List FullName, Length, LastWriteTime
}

if (-not $NoPublish) {
  New-Item -ItemType Directory -Force -Path $PublishDir | Out-Null
  $published = @()
  if (Test-Path $ExeOut) {
    Copy-Item $ExeOut (Join-Path $PublishDir 'FarmEdge-Setup.exe') -Force
    $published += (Join-Path $PublishDir 'FarmEdge-Setup.exe')
  }
  if (Test-Path $Zip) {
    Copy-Item $Zip (Join-Path $PublishDir 'FarmEdge-Setup-win.zip') -Force
    $published += (Join-Path $PublishDir 'FarmEdge-Setup-win.zip')
  }
  Copy-Item (Join-Path $PSScriptRoot 'INSTRUCTIONS-RU.html') (Join-Path $PublishDir 'FarmEdge-INSTRUCTIONS-RU.html') -Force
  Copy-Item (Join-Path $PSScriptRoot 'INSTRUCTION-RU.txt') (Join-Path $PublishDir 'FarmEdge-INSTRUCTION-RU.txt') -Force
  $published += (Join-Path $PublishDir 'FarmEdge-INSTRUCTIONS-RU.html')
  $published += (Join-Path $PublishDir 'FarmEdge-INSTRUCTION-RU.txt')

  $checksums = foreach ($file in $published) {
    $hash = Get-FileHash -LiteralPath $file -Algorithm SHA256
    '{0}  {1}' -f $hash.Hash.ToLowerInvariant(), (Split-Path $file -Leaf)
  }
  [System.IO.File]::WriteAllLines(
    (Join-Path $PublishDir 'FarmEdge-SHA256.txt'),
    $checksums,
    (New-Object System.Text.UTF8Encoding $false)
  )
  Write-Host "Published downloads: $PublishDir"
}

Write-Host 'Done.'
