# DS-Harness: the optional community plugins, from the command line.
#
# `scripts\install.ps1` asks about the two optional plugins inside its own step and calls the Node
# command line directly; this script is the same thing on its own, for the person who wants to add a
# plugin later without re-running the whole installer -- and it is the surface the CI gate drives,
# because a parameter that only exists inside another script cannot be tested.
#
# What it installs, and how, is not decided here:
#
#   * the release pin is `app\extensions\mega\plugins\index.cjs` (the bundled manifest);
#   * the installation channel is `installBundled()`, which for these two entries is the Harness' own
#     CLI (`dsh plugin --profile <p> add <pkg>@<ref>`) -- both are Harness client plugins;
#   * the compatibility check is the adapter framework's (`dshns.harness-profile`);
#   * the decision is recorded by `community-install.cjs` in `data\state\optional-plugins.json`.
#
# This script is the interaction and the reporting around that: it asks when it should, validates its
# parameters before acting on them, and prints what happened. It installs nothing itself, and it never
# writes into a Harness profile.
#
# Exit code: 0 when every requested plugin ended installed (or already was), 1 when one failed,
# 2 when the parameters contradicted each other. A failure here is a warning to the caller, never a
# reason for DS-Hns' own installation to fail.
param(
  [switch]$InstallMarket,
  [switch]$InstallWallpaper,
  [switch]$SkipOptionalPlugins,
  [switch]$NonInteractive,
  [switch]$Json,
  [string]$Profile = '',
  [string]$DshHome = '',
  # Test seam, and only that (see the note in scripts\install.ps1): a JSON file mapping a package name
  # to a local directory that stands in for it, so the installation channel can be exercised without
  # a registry, and extra arguments for the Harness plugin CLI.
  [string]$FixtureMap = '',
  [string]$ExtraArgs = ''
)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

# The same conflict rule the installer enforces, for the same reason: two contradictory instructions
# are an error with a reason, never a silent override in one direction.
if (($InstallMarket -or $InstallWallpaper) -and $SkipOptionalPlugins) {
  Write-Error '-InstallMarket / -InstallWallpaper cannot be combined with -SkipOptionalPlugins.'
  exit 2
}

$profileName = if ($Profile) { $Profile } elseif ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
$dshHomePath = if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $ROOT 'data' }

# Is there a person to ask? `-NonInteractive` says no explicitly; a redirected stdin or no console
# says it too, and in either case the optional plugins are skipped unless a parameter named them.
$interactive = -not $NonInteractive
if ($interactive) {
  try {
    if ($Host.UI -and $Host.UI.RawUI) {
      if ([Console]::IsInputRedirected) { $interactive = $false }
    } else {
      $interactive = $false
    }
  } catch {
    $interactive = $false
  }
}

$cli = Join-Path $ROOT 'app\extensions\mega\plugins\community-install-cli.cjs'
if (-not (Test-Path -LiteralPath $cli)) {
  Write-Error "the community plugin command line is missing: $cli"
  exit 1
}

# Node, then the Harness CLI. Both are resolved rather than assumed, and a missing one is reported
# with the step that provides it instead of failing on an obscure spawn error.
$nodeExe = ''
try {
  $resolved = & (Join-Path $PSScriptRoot 'ensure-node.ps1') | Select-Object -Last 1
  if ($resolved) {
    $candidate = Join-Path ([string]$resolved) 'node.exe'
    if (Test-Path -LiteralPath $candidate) { $nodeExe = $candidate }
  }
} catch {
  $nodeExe = ''
}
if (-not $nodeExe) {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode) { $nodeExe = $systemNode.Source }
}
if (-not $nodeExe) {
  Write-Error 'no usable Node.js was found; run scripts\install-deps.ps1 first.'
  exit 1
}

$dshEntry = Join-Path $ROOT 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path -LiteralPath $dshEntry)) {
  Write-Error "the Harness CLI is not installed ($dshEntry is missing); run scripts\install-deps.ps1 first."
  exit 1
}

# `dsh plugin` forwards to a bare `pnpm`, so the channel needs one the CLI can spawn. corepack (which
# ships with Node) provides it without installing anything globally, into the repository's own
# git-ignored `runtime\bin` -- the same shim `scripts\install-profile-plugin.ps1` uses.
$shimDir = Join-Path $ROOT 'runtime\bin'
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  $corepack = Get-Command corepack -ErrorAction SilentlyContinue
  if (-not $corepack) {
    Write-Error 'pnpm is not on PATH and corepack is not available; install pnpm, then re-run this script.'
    exit 1
  }
  New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $corepack.Source enable pnpm --install-directory $shimDir > $null 2>&1
  } catch {
    Write-Host "corepack could not provide pnpm: $($_.Exception.Message)"
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if (Test-Path -LiteralPath (Join-Path $shimDir 'pnpm.cmd')) {
    $env:PATH = "$shimDir;$env:PATH"
    Write-Host "pnpm: provided by corepack in $shimDir"
  }
}

# The plan: the release pin, the profile's own manifest, and whether each plugin is already there.
$planRaw = & $nodeExe $cli '--describe' '--json' "--profile=$profileName" "--dsh-home=$dshHomePath" "--root=$ROOT" 2>$null
$plan = $null
if ($LASTEXITCODE -eq 0) {
  $planText = (@($planRaw) -join '').Trim()
  if ($planText) {
    try { $plan = $planText | ConvertFrom-Json } catch { $plan = $null }
  }
}
$planned = @()
if ($plan -and $plan.plugins) { $planned = @($plan.plugins) }
if ($planned.Count -eq 0) {
  Write-Warning 'the optional community plugin manifest could not be read; nothing was installed.'
  exit 1
}

Write-Host "DS-Hns optional community plugins (profile $profileName at $dshHomePath\profiles\$profileName)"
foreach ($entry in $planned) {
  $state = if ($entry.installed) { "installed ($($entry.installedVersion))" } else { 'not installed' }
  Write-Host "  $($entry.id)  $($entry.spec)  $state"
}

$marketRequested = [bool]$InstallMarket
$wallpaperRequested = [bool]$InstallWallpaper

function Read-PluginChoice([string]$Label) {
  Write-Host ''
  Write-Host "  Install the optional community plugin $Label ?"
  Write-Host "  [1] Install $Label  /  (ZH: install $Label)"
  Write-Host '  [2] Skip  /  (ZH: skip)'
  Write-Host '  Default: 2 (Skip).'
  $answer = ''
  while (($answer -ne '1') -and ($answer -ne '2')) {
    $answer = (Read-Host "  Choose 1 or 2 for $Label [2]").Trim()
    if (-not $answer) { $answer = '2' }
  }
  return ($answer -eq '1')
}

# One plugin, one question. The wallpaper engine is asked about first because it is the one a user
# notices; the market is asked about separately, so "yes to one and no to the other" is expressible.
if (-not $marketRequested -and -not $wallpaperRequested -and -not $SkipOptionalPlugins) {
  if ($interactive) {
    $wallpaperRequested = Read-PluginChoice 'Wallpaper Engine'
    $marketRequested = Read-PluginChoice 'Plugin Market'
  } else {
    Write-Host '  No interactive console: optional community plugins are skipped unless -InstallMarket or -InstallWallpaper asks for one.'
  }
}

$cliArgs = @($cli)
if ($marketRequested) { $cliArgs += '--install-market' }
if ($wallpaperRequested) { $cliArgs += '--install-wallpaper' }
if ($SkipOptionalPlugins) { $cliArgs += '--skip' }
if ($Json) { $cliArgs += '--json' }
if ($FixtureMap) { $cliArgs += "--fixture=$FixtureMap" }
if ($ExtraArgs) { $cliArgs += "--extra=$ExtraArgs" }
$cliArgs += "--profile=$profileName"
$cliArgs += "--dsh-home=$dshHomePath"
$cliArgs += "--root=$ROOT"

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $output = @(& $nodeExe @cliArgs 2>&1 | ForEach-Object { [string]$_ })
  $exit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousPreference
}

if ($Json) {
  foreach ($line in $output) {
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith('{')) { Write-Output $trimmed }
  }
} else {
  foreach ($line in $output) { Write-Host $line }
}

if ($exit -ne 0) {
  Write-Warning 'at least one optional community plugin could not be installed; DS-Harness itself is unaffected.'
}
exit $exit
