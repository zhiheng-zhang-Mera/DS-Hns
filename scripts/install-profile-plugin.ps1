# DS-Harness: sign the shipped client plugin into the Harness profile the product boots.
#
# The orb (the floating ball in the official UI) is not drawn by our shell. It is drawn by
# `app\plugins\mega-core`, a Harness *client* plugin whose browser half registers itself into the
# official `shell.overlay` slot, so the official UI only draws a ball when the profile the product
# boots (`$DSH_HOME\profiles\<profile>`) has that plugin installed.
#
# That install lives outside the repository: `data\*` is git-ignored, and the dependency is an
# absolute `file:` path, so a fresh checkout can never carry it. The round that first put the ball
# on screen did it by hand (`docs\pluginize.md`), which is why every new host installed the product
# without a ball while the development host had one: nothing in the installer ever installed it
# (`app\harness-profile.cjs` only refreshes a copy that already exists, and the bundled-plugin
# manifest does not list this plugin, because it is ours rather than a community reference).
#
# The install itself is the Harness' own CLI's job (`dsh plugin --profile <name> add <spec>`) and
# never a hand-written profile: installing is another application's business. This script only
# resolves Node, makes a pnpm reachable for that CLI, and calls it.
#
# Reuse-first and idempotent: a profile that already declares this plugin at this checkout's own
# `file:` spec, with the installed copy present, is reported and left untouched. A profile that
# declares a *different* spec (a profile carried from another machine, where the checkout lived
# somewhere else) is repaired rather than trusted.
#
# Printed output: one line per decision, then `already-installed` or `installed` on stdout.
# Exit code: 0 when the profile has the shipped plugin (installed now or already), 1 when it does
# not. A caller must degrade to "no orb" and carry on, never to a failed installation.
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

Write-Output '[profile-plugin 1/4] Resolving the shipped plugin'
$packageDir = Join-Path $ROOT 'app\plugins\mega-core'
$manifestPath = Join-Path $packageDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  # Also the honest answer for a checkout that never had the orb (the default branch before the
  # plugin landed): say so rather than pretending an install failed.
  Write-Warning "this checkout does not ship $packageDir, so there is no orb to install."
  exit 1
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$pluginName = [string]$manifest.name
if (-not $pluginName) {
  Write-Warning "$manifestPath names no package."
  exit 1
}
# The same spec the manual install used (`docs\pluginize.md`): one absolute `file:` path, forward
# slashes. A relative or bare spec would resolve against the profile directory instead.
$spec = 'file:' + ($packageDir -replace '\\', '/')
Write-Host "  $pluginName $($manifest.version) from $spec"

$profileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $ROOT 'data' }
$env:DSH_HOME = $dshHome
$env:DSH_ROOT = $ROOT
# Reuse the repository's own caches when the caller did not set them (scripts\env.ps1 does this for
# the installer; a standalone run gets the same reuse).
if (-not $env:pnpm_config_store_dir) { $env:pnpm_config_store_dir = Join-Path $ROOT 'cache\pnpm' }
if (-not $env:npm_config_cache) { $env:npm_config_cache = Join-Path $ROOT 'cache\npm' }

$profileDir = Join-Path $dshHome "profiles\$profileName"
$installedDir = Join-Path $profileDir "node_modules\$pluginName"
$clientHalf = Join-Path $installedDir 'lib\client.js'

function Get-DeclaredSpec {
  $file = Join-Path $profileDir 'package.json'
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  try {
    $parsed = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  } catch {
    return ''
  }
  $dependencies = $parsed.dependencies
  if (-not $dependencies) { return '' }
  if (-not ($dependencies.PSObject.Properties.Name -contains $pluginName)) { return '' }
  return ([string]$dependencies.$pluginName).Trim()
}

function Test-InstalledCopy {
  return ((Test-Path -LiteralPath $clientHalf) -and (Test-Path -LiteralPath (Join-Path $installedDir 'lib\index.js')))
}

function Test-SameSpec([string]$declared) {
  if (-not $declared) { return $false }
  $left = ($declared -replace '\\', '/').TrimEnd('/')
  $right = ($spec -replace '\\', '/').TrimEnd('/')
  return ($left -ieq $right)
}

Write-Output '[profile-plugin 2/4] Reading the profile the product boots'
Write-Host "  profile $profileName at $profileDir"
$declared = Get-DeclaredSpec
$installed = Test-InstalledCopy
if ((-not $Force) -and (Test-SameSpec $declared) -and $installed) {
  Write-Host '  the profile already has this plugin, at this checkout path; leaving it alone.'
  Write-Output 'already-installed'
  exit 0
}
if ($declared -and (-not (Test-SameSpec $declared))) {
  Write-Host "  the profile declares $declared, which is not this checkout; repairing it."
} elseif ($declared -and (-not $installed)) {
  Write-Host '  the profile declares the plugin but its installed copy is not there; repairing it.'
} elseif (-not $declared) {
  Write-Host '  the profile does not declare the plugin yet; installing it.'
}

Write-Output '[profile-plugin 3/4] Resolving Node and pnpm'
$nodeDir = ''
try {
  $nodeDir = (& (Join-Path $PSScriptRoot 'ensure-node.ps1') | Select-Object -Last 1)
} catch {
  $nodeDir = ''
  Write-Host "  the Node resolver failed: $($_.Exception.Message)"
}
$nodeExe = ''
if ($nodeDir) { $nodeExe = Join-Path $nodeDir 'node.exe' }
if ((-not $nodeExe) -or (-not (Test-Path -LiteralPath $nodeExe))) {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode) { $nodeExe = $systemNode.Source }
}
if ((-not $nodeExe) -or (-not (Test-Path -LiteralPath $nodeExe))) {
  Write-Warning 'no compatible Node.js was found; the profile plugin cannot be installed.'
  exit 1
}
$env:PATH = "$(Split-Path -Parent $nodeExe);$env:PATH"
Write-Host "  Node: $(& $nodeExe --version)"

$dshEntry = Join-Path $ROOT 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path -LiteralPath $dshEntry)) {
  Write-Warning "the Harness CLI is not installed yet ($dshEntry is missing); run scripts\install-deps.ps1 first."
  exit 1
}

# `dsh plugin` is a thin pnpm forwarder: it spawns a bare `pnpm` from PATH. Node ships corepack, so
# a pnpm the CLI can spawn is available without installing anything globally: corepack writes its
# own shims into a directory of ours (git-ignored runtime\bin) and we put that directory in front.
$shimDir = Join-Path $ROOT 'runtime\bin'
$pnpmOnPath = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmOnPath) {
  $corepack = Get-Command corepack -ErrorAction SilentlyContinue
  if (-not $corepack) {
    Write-Warning 'pnpm is not on PATH and corepack is not available; install pnpm, then re-run this script.'
    exit 1
  }
  New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
  # Regenerated rather than only created: the shims corepack writes point at the Node they came
  # from, so a Node that moved would otherwise leave a stale shim behind.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $corepack.Source enable pnpm --install-directory $shimDir > $null 2>&1
  } catch {
    Write-Host "  corepack could not provide pnpm: $($_.Exception.Message)"
  } finally {
    $ErrorActionPreference = $previous
  }
  if (-not (Test-Path -LiteralPath (Join-Path $shimDir 'pnpm.cmd'))) {
    Write-Warning "corepack did not produce a pnpm shim in $shimDir; install pnpm, then re-run this script."
    exit 1
  }
  $env:PATH = "$shimDir;$env:PATH"
  Write-Host "  pnpm: provided by corepack in $shimDir"
} else {
  Write-Host "  pnpm: $($pnpmOnPath.Source)"
}

Write-Output '[profile-plugin 4/4] Installing it with the Harness own CLI'
Write-Host "  dsh plugin --profile $profileName add $spec"
$transcript = @()
$previous = $ErrorActionPreference
# The Harness writes its own progress to stderr, which is not a failure here: keep it flowing into
# the transcript instead of turning it into a terminating error.
$ErrorActionPreference = 'Continue'
try {
  $transcript = @(& $nodeExe $dshEntry 'plugin' '--profile' $profileName 'add' $spec 2>&1 | ForEach-Object { [string]$_ })
} finally {
  $ErrorActionPreference = $previous
}
$exit = $LASTEXITCODE
foreach ($line in @($transcript | Select-Object -Last 6)) {
  if ($line.Trim()) { Write-Host "  | $line" }
}
if ($exit -ne 0) {
  Write-Warning "the Harness CLI exited $exit; the profile does not have $pluginName."
  Write-Warning "re-run this step later with: scripts\install-profile-plugin.ps1"
  exit 1
}

# The CLI is the installer, not the proof: read the profile back, the same way the product does.
$declared = Get-DeclaredSpec
$installed = Test-InstalledCopy
if ((-not (Test-SameSpec $declared)) -or (-not $installed)) {
  Write-Warning "the profile still does not carry $pluginName (declared: '$declared', copy: $installed)."
  exit 1
}
Write-Host "  the profile now has $pluginName; the next launch mounts it and draws the orb."
Write-Output 'installed'
exit 0
