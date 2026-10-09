# Authenticode-sign one PE file with a certificate from the Windows store (CurrentUser\My or LocalMachine\My).
# Used by pack-setup.ps1 (and by Inno Setup via SignTool=) when signtool.exe from the Windows SDK is not installed.
# Works with USB-token certificates (SafeNet/GlobalSign etc.) because the key is accessed through the token's CSP/KSP.
param(
  [Parameter(Mandatory = $true)][string]$Thumbprint,
  [Parameter(Mandatory = $true)][string]$File,
  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)
$ErrorActionPreference = 'Stop'
$Thumbprint = ($Thumbprint -replace '\s', '').ToUpperInvariant()
$cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
if (-not $cert) { Write-Error "Code-signing certificate $Thumbprint not found"; exit 2 }
if (-not (Test-Path -LiteralPath $File)) { Write-Error "File not found: $File"; exit 2 }

$sig = Set-AuthenticodeSignature -FilePath $File -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $TimestampUrl -IncludeChain All
if ($sig.Status -ne 'Valid' -and $sig.Status -ne 'UnknownError') {
  # UnknownError = signed, but the chain is not trusted on THIS machine (e.g. self-signed test cert).
  Write-Error "Signing failed for $File : $($sig.Status) $($sig.StatusMessage)"
  exit 1
}
Write-Host ("signed {0} [{1}] {2}" -f (Split-Path $File -Leaf), $sig.Status, $cert.Subject)
exit 0
