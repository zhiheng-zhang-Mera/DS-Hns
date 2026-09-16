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

# `-NonInteractive` means "ask nothing": the plugins are then skipped unless a parameter named one.
$skipOptional = [bool]$SkipOptionalPlugins -or [bool]$NonInteractive

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
# Read from a UTF-8 report file rather than from captured stdout -- Windows PowerShell decodes a native
# command's output through the console code page, and this file is the answer everything below depends on.
$planReport = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-community-plan-$PID.json"
Remove-Item -LiteralPath $planReport -Force -ErrorAction SilentlyContinue
$null = & $nodeExe $cli '--describe' "--profile=$profileName" "--dsh-home=$dshHomePath" "--root=$ROOT" "--report=$planReport" 2>$null
$plan = $null
if (Test-Path -LiteralPath $planReport) {
  try {
    $planText = [System.IO.File]::ReadAllText($planReport, [System.Text.Encoding]::UTF8).Trim()
    if ($planText) { $plan = $planText | ConvertFrom-Json }
  } catch {
    $plan = $null
  }
}
Remove-Item -LiteralPath $planReport -Force -ErrorAction SilentlyContinue
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

# One plugin, one question, one answer -- and the questions are asked by the Node command line, using
# the bilingual label file, because this script has to stay ASCII-only (Windows PowerShell 5.1 reads a
# BOM-less .ps1 as ANSI, so a Chinese character written here corrupts the prompt or the parse).
#
# A parameter answers; otherwise `--ask` is passed and the command line asks only if it has a console.
# With a redirected or closed stdin it reads end-of-input and skips, which is the requirement's default
# for an unattended run: nothing optional is installed, and nothing blocks waiting for an answer.
$cliArgs = @($cli)
if ($marketRequested) { $cliArgs += '--install-market' }
if ($wallpaperRequested) { $cliArgs += '--install-wallpaper' }
if ($skipOptional) { $cliArgs += '--skip' }
if ((-not $marketRequested) -and (-not $wallpaperRequested) -and (-not $skipOptional)) { $cliArgs += '--ask' }
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
