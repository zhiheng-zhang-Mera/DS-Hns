# DS-Harness: install the built-in plugins into the Harness profile the product boots.
#
# The two built-in plugins (`dsh-health-scheduler`, `dsh-restart-supervisor`) live in this repository,
# are mounted by `app/plugin-host.cjs` through `NativeHnsAdapter`, and still have to be **installed**:
# the official Harness UI lists a plugin because the profile it boots declares it, so a plugin that is
# only mounted in our own host is invisible there. This script is that install step, and it is the same
# step the orb already had -- generalised, so the list is data (`scripts\bundled-plugins.json`) rather
# than a hard-coded directory.
#
# It does not install anything itself. Each plugin goes through `scripts\install-profile-plugin.ps1`,
# which calls the Harness' own CLI (`dsh plugin --profile <p> add file:<path>`) exactly as the manual
# install did. A failure for one plugin warns and continues: the restart supervisor and the health
# scheduler must not be able to take the installation, or each other, down.
#
# Modes:
#   (default)          fresh install / repair: install anything missing, leave anything present
#   -Repair            the same, with `-Force`, so a stale copy is rewritten
#   -Uninstall         remove both plugins from the profile through the same channel
#   -Json              one JSON report on stdout, for the installer and for the tests
#
# Exit code: 0 when every *required* plugin ended up installed (or, for `-Uninstall`, removed), 1 when
# one did not. The caller decides what a failure means: `scripts\install.ps1` warns and carries on.
param(
  [switch]$Repair,
  [switch]$Uninstall,
  [switch]$Json,
  [string]$Profile = '',
  [string]$DshHome = '',
  [string]$List = ''
)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

# The list, as data. A missing file is a real failure: it is the record of what this release ships.
$listFile = if ($List) { $List } else { Join-Path $PSScriptRoot 'bundled-plugins.json' }
if (-not (Test-Path -LiteralPath $listFile)) {
  Write-Error "the built-in plugin list is missing: $listFile"
  exit 1
}
$manifest = Get-Content -LiteralPath $listFile -Raw | ConvertFrom-Json
$entries = @($manifest.plugins)
if ($entries.Count -eq 0) {
  Write-Error "$listFile names no plugins"
  exit 1
}

$profileName = if ($Profile) { $Profile } elseif ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
$dshHomePath = if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $ROOT 'data' }
$env:DSH_PROFILE = $profileName
$env:DSH_HOME = $dshHomePath

# `dsh plugin` forwards to a bare `pnpm`, for `add` and for `remove` alike. The install path gets one
# from `install-profile-plugin.ps1`; the uninstall path is this script's own, so it makes the same
# provision here rather than depending on the caller's PATH. corepack ships with Node, so this needs
# nothing installed globally, and the shim goes in the repository's own git-ignored `runtime\bin`.
if ($Uninstall) {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if ($corepack) {
      $shimDir = Join-Path $ROOT 'runtime\bin'
      New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
      $previous = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try { & $corepack.Source enable pnpm --install-directory $shimDir > $null 2>&1 } catch { }
      finally { $ErrorActionPreference = $previous }
      if (Test-Path -LiteralPath (Join-Path $shimDir 'pnpm.cmd')) {
        $env:PATH = "$shimDir;$env:PATH"
        Write-Host "  pnpm: provided by corepack in $shimDir"
      }
    }
  }
}

Write-Host "DS-Hns built-in plugins (profile $profileName at $dshHomePath\profiles\$profileName)"
$results = @()
$failed = 0

foreach ($entry in $entries) {
  $directory = [string]$entry.directory
  $packageDir = Join-Path $ROOT (Join-Path 'app\plugins' $directory)
  $manifestPath = Join-Path $packageDir 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Warning "the built-in plugin $($entry.id) is not in this checkout ($packageDir); skipping it."
    $results += @{ id = [string]$entry.id; ok = $false; state = 'missing'; reason = "$packageDir is not in this checkout" }
    if ($entry.required -eq $true) { $failed++ }
    continue
  }
  $package = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $packageName = [string]$package.name

  if ($Uninstall) {
    # Removal goes through the same channel as installation: asking our own store to remove a profile
    # plugin would remove nothing and then report success.
    $nodeDir = ''
    try { $nodeDir = (& (Join-Path $PSScriptRoot 'ensure-node.ps1') | Select-Object -Last 1) } catch { $nodeDir = '' }
    $nodeExe = ''
    if ($nodeDir) { $nodeExe = Join-Path $nodeDir 'node.exe' }
    if ((-not $nodeExe) -or (-not (Test-Path -LiteralPath $nodeExe))) {
      $systemNode = Get-Command node -ErrorAction SilentlyContinue
      if ($systemNode) { $nodeExe = $systemNode.Source }
    }
    $dshEntry = Join-Path $ROOT 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'
    if ((-not $nodeExe) -or (-not (Test-Path -LiteralPath $dshEntry))) {
      Write-Warning "the Harness CLI is unavailable, so $packageName cannot be removed from the profile."
      $results += @{ id = [string]$entry.id; ok = $false; state = 'failed'; reason = 'the Harness CLI is unavailable' }
      $failed++
      continue
    }
    Write-Host "  removing $packageName from the profile"
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $output = @(& $nodeExe $dshEntry 'plugin' '--profile' $profileName 'remove' $packageName 2>&1 | ForEach-Object { [string]$_ })
      $exit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previous
    }
    foreach ($line in $output) { if ($line.Trim()) { Write-Host "  | $($line.Trim())" } }
    if ($exit -ne 0) {
      Write-Warning "the Harness CLI exited $exit while removing $packageName; it may still be installed."
      $results += @{ id = [string]$entry.id; ok = $false; state = 'failed'; reason = "dsh plugin remove exited $exit" }
      $failed++
    } else {
      $results += @{ id = [string]$entry.id; ok = $true; state = 'uninstalled'; reason = $null }
    }
    continue
  }

  # Installation and repair are the same call: the plugin script is idempotent and reuse-first, and
  # `-Repair` only makes it rewrite a copy that is already there.
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'install-profile-plugin.ps1'), '-Plugin', $directory)
  if ($Repair) { $arguments += '-Force' }
  Write-Host "  installing $($entry.id) ($packageName $($package.version)) from app\plugins\$directory"
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& powershell.exe @arguments 2>&1 | ForEach-Object { [string]$_ })
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $tail = ($lines | Where-Object { $_.Trim() } | Select-Object -Last 1)
  foreach ($line in ($lines | Select-Object -Last 8)) { if ($line.Trim()) { Write-Host "  | $($line.Trim())" } }
  if ($exit -ne 0) {
    Write-Warning "$packageName is not in the Harness profile; the rest of the installation continues."
    $results += @{ id = [string]$entry.id; ok = $false; state = 'failed'; reason = "the profile plugin step exited $exit" }
    if ($entry.required -eq $true) { $failed++ }
  } else {
    $state = if ($tail -match 'already-installed') { 'already-installed' } else { 'installed' }
    $results += @{ id = [string]$entry.id; ok = $true; state = $state; reason = $null }
  }
}

$report = @{
  ok = ($failed -eq 0)
  profile = $profileName
  dshHome = $dshHomePath
  mode = if ($Uninstall) { 'uninstall' } elseif ($Repair) { 'repair' } else { 'install' }
  at = (Get-Date).ToString('o')
  results = $results
}

if ($Json) {
  Write-Output ($report | ConvertTo-Json -Depth 6 -Compress)
} else {
  Write-Host ''
  Write-Host 'Built-in plugins'
  foreach ($result in $results) {
    $label = $result.id.PadRight(30)
    $state = [string]$result.state
    $colour = if ($state -eq 'installed' -or $state -eq 'already-installed' -or $state -eq 'uninstalled') { 'Green' } else { 'Yellow' }
    Write-Host ("  {0} {1}" -f $label, $state) -ForegroundColor $colour
    if ($result.reason) { Write-Warning "  $($result.id): $($result.reason)" }
  }
}

if ($failed -gt 0) { exit 1 }
exit 0
