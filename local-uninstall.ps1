# ============================================================================
#  local-uninstall.ps1 — tear down the LOCAL DEV install (Windows).
# ----------------------------------------------------------------------------
#  Mirrors local-uninstall.sh for native PowerShell (no Git Bash required).
#
#  Usage:
#    .\local-uninstall.ps1
# ============================================================================
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$pkg = Get-Content package.json | ConvertFrom-Json
$PKG = $pkg.name
$BIN = ($pkg.bin.PSObject.Properties | Select-Object -First 1).Name

# HARD GUARD — see local-install.ps1. With an empty $BIN, `Join-Path $GBIN $BIN` IS $GBIN,
# and the shim cleanup below would recursively delete the entire global npm directory.
if (-not $PKG -or -not $BIN) {
  Write-Host "!! Refusing to run: could not read name/bin from package.json (PKG='$PKG' BIN='$BIN')."
  exit 1
}

Write-Host "==> agents-playbook local uninstall  ($PKG, bin: $BIN)"

# 1. remove global link/install
Write-Host "==> npm rm -g $PKG"
npm rm -g $PKG 2>$null; $true

# 2. force-clean any dangling bin shim
$GBIN = npm prefix -g
$shimBase = Join-Path $GBIN $BIN
$cleaned = @()
foreach ($ext in @('', '.cmd', '.ps1')) {
    $f = "$shimBase$ext"
    if (-not (Test-Path $f)) { continue }
    if ((Get-Item $f -Force).PSIsContainer) {
      Write-Host "!! Refusing to remove a DIRECTORY at $f — that is not a shim."
      exit 1
    }
    Remove-Item -Force $f; $cleaned += $f
}
if ($cleaned.Count -gt 0) {
    Write-Host "==> cleaned dangling shim(s) in $GBIN`:`n   $($cleaned -join "`n   ")"
}

# 3. remove stray .tgz pack artifacts
$tarballs = Get-ChildItem -Path $PSScriptRoot -Filter '*.tgz' -ErrorAction SilentlyContinue
if ($tarballs) {
    Write-Host "==> removing stray tarball(s): $($tarballs.Name -join ', ')"
    $tarballs | Remove-Item -Force
}

# 4. verify
if (Get-Command $BIN -ErrorAction SilentlyContinue) {
    Write-Host "!! pb still on PATH — likely a separate global install"
} else {
    Write-Host "==> pb removed from PATH"
}

Write-Host "Done."
