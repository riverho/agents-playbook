# ============================================================================
#  local-install.ps1 — set up agents-playbook for LOCAL DEVELOPMENT (Windows).
# ----------------------------------------------------------------------------
#  Mirrors local-install.sh for native PowerShell (no Git Bash required).
#
#  Usage:
#    .\local-install.ps1          install deps + global-link `pb`
#    .\local-install.ps1 --pack   also run a published-tarball smoke test
# ============================================================================
param([switch]$pack)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$pkg = Get-Content package.json | ConvertFrom-Json
$PKG = $pkg.name
$VER = $pkg.version
$BIN = ($pkg.bin.PSObject.Properties | Select-Object -First 1).Name

# HARD GUARD. `Join-Path $GBIN $BIN` with an EMPTY $BIN returns $GBIN itself — the whole
# global npm directory. The shim cleanup below then calls `Remove-Item -Force` on it: a
# recursive delete of every global package on the machine, stopped only by whichever file
# happens to be locked. Not hypothetical — it happened, and only a permission error stopped
# it. So refuse to touch anything unless the manifest actually parsed.
if (-not $PKG -or -not $VER -or -not $BIN) {
  Write-Host "!! Refusing to run: could not read name/version/bin from package.json."
  Write-Host "   parsed: PKG='$PKG' VER='$VER' BIN='$BIN'"
  Write-Host "   Run from the repo root, against a package.json that has a 'bin' entry."
  exit 1
}

Write-Host "==> agents-playbook local install  ($PKG@$VER, bin: $BIN)"
Write-Host "==> repo: $PSScriptRoot"

# 1. dependencies
Write-Host "==> npm install"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 2. clear any stale global link/shim (Windows: npm link fails with EEXIST if shims linger)
npm rm -g $PKG 2>$null; $true   # || true equivalent

$GBIN = npm prefix -g
$shimBase = Join-Path $GBIN $BIN
# Belt and braces: even with $BIN present, never remove a DIRECTORY or the global bin dir
# itself. A shim is a FILE (`pb`, `pb.cmd`, `pb.ps1`). If this ever resolves to a folder,
# stop instead of deleting it.
foreach ($ext in @('', '.cmd', '.ps1')) {
    $f = "$shimBase$ext"
    if (-not (Test-Path $f)) { continue }
    if ((Get-Item $f -Force).PSIsContainer) {
      Write-Host "!! Refusing to remove a DIRECTORY at $f — that is not a shim."
      exit 1
    }
    if ((Resolve-Path $f).Path -eq (Resolve-Path $GBIN).Path) {
      Write-Host "!! Refusing to remove the global bin dir itself ($f)."
      exit 1
    }
    Remove-Item -Force $f
    Write-Host "==> removed stale shim: $f"
}

# 3. global link
Write-Host "==> npm link  (global ``$BIN`` -> this repo)"
npm link
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 4. verify
$pbCmd = Get-Command $BIN -ErrorAction SilentlyContinue
$pbPath = if ($pbCmd) { $pbCmd.Source } else { $null }
if ($pbPath) {
    Write-Host "==> pb on PATH: $pbPath"
    & $BIN help 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "==> pb runs OK" }
} else {
    Write-Host "!! pb not found on PATH. Add npm global bin to PATH:"
    Write-Host "   $GBIN"
}

# 5. optional: published-tarball smoke test
if ($pack) {
    Write-Host "==> --pack: published-tarball smoke test"
    $TMP = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $TMP | Out-Null
    try {
        $TGZ = (npm pack --pack-destination $TMP | Select-Object -Last 1).Trim()
        Push-Location $TMP
        npm init -y 2>$null | Out-Null
        npm install "$TMP\$TGZ" --no-audit --no-fund 2>$null | Out-Null
        node "node_modules/$PKG/scripts/pb.mjs" scaffold --target ./.agents-playbook 2>$null | Out-Null
        Set-Location .agents-playbook
        node scripts/pb.mjs init 2>$null | Out-Null
        node scripts/pb.mjs validate
        if ($LASTEXITCODE -ne 0) { throw "validate failed" }
        Pop-Location
        Write-Host "==> tarball smoke test passed ($TGZ)"
    } finally {
        Remove-Item -Recurse -Force $TMP -ErrorAction SilentlyContinue
    }
}

Write-Host @"

Done. Local dev lifecycle:
  - Edits to this repo are live via the global ``pb`` link (no repack).
  - ``pb`` runs against THIS repo's playbook; use it to bootstrap others:
      pb scaffold --target <repo>/.agents-playbook
  - Pre-publish smoke test:  .\local-install.ps1 -pack
  - Tear down:               .\local-uninstall.ps1
"@
