# DS-Harness dependency installer/repair.
# Reuses compatible local dependencies and caches before touching the network.
# Windows PowerShell 5.1 compatible and ASCII-only.
param([switch]$Full)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

Write-Output '[deps 1/3] Resolving Node.js'
$ensureNodeScript = Join-Path $PSScriptRoot 'ensure-node.ps1'
$nodeDir = (& $ensureNodeScript | Select-Object -Last 1)
if (-not $nodeDir) {
  throw 'Unable to resolve a compatible Node.js runtime.'
}
$nodeExe = Join-Path $nodeDir 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw "Node.js executable not found: $nodeExe"
}
$env:PATH = "$nodeDir;$env:PATH"
Write-Output "  Node: $(& $nodeExe --version) ($nodeDir)"

# Capture machine caches before project runtime variables redirect cache paths.
$nativeNpmCache = ''
try {
  $nativeNpmCache = (& $env:ComSpec /d /c "npm config get cache" 2>$null | Select-Object -Last 1)
  if ($nativeNpmCache) { $nativeNpmCache = $nativeNpmCache.Trim() }
} catch {
  $nativeNpmCache = ''
}

$nativeElectronCache = ''
if ($env:LOCALAPPDATA) {
  $nativeElectronCache = Join-Path $env:LOCALAPPDATA 'electron\Cache'
}

$projectNpmCache = Join-Path $ROOT 'cache\npm'
$projectElectronCache = Join-Path $ROOT 'cache\electron'
$projectTemp = Join-Path $ROOT 'cache\temp'
New-Item -ItemType Directory -Path $projectNpmCache -Force | Out-Null
New-Item -ItemType Directory -Path $projectElectronCache -Force | Out-Null
New-Item -ItemType Directory -Path $projectTemp -Force | Out-Null

$manifestPath = Join-Path $ROOT 'app\package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedDsh = [string]$manifest.dependencies.'@deepseek-ai/dsh'
$expectedElectron = [string]$manifest.devDependencies.electron
$expectedDsh = $expectedDsh -replace '^[\^~]', ''
$expectedElectron = $expectedElectron -replace '^[\^~]', ''

$dshPkg = Join-Path $ROOT 'app\node_modules\@deepseek-ai\dsh\package.json'
$dshBin = Join-Path $ROOT 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'
$electronPkg = Join-Path $ROOT 'app\node_modules\electron\package.json'
$electronExe = Join-Path $ROOT 'app\node_modules\electron\dist\electron.exe'

function Get-PackageVersion([string]$file) {
  try {
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    $pkg = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    return [string]$pkg.version
  } catch {
    return ''
  }
}

$installedDsh = Get-PackageVersion $dshPkg
$installedElectron = Get-PackageVersion $electronPkg
$depsReady = $false
if (($installedDsh -eq $expectedDsh) -and
    ($installedElectron -eq $expectedElectron) -and
    (Test-Path -LiteralPath $dshBin) -and
    (Test-Path -LiteralPath $electronExe)) {
  $depsReady = $true
}

Write-Output '[deps 2/3] Checking app dependencies'
if ($depsReady) {
  Write-Output "  Reuse local @deepseek-ai/dsh $installedDsh"
  Write-Output "  Reuse local Electron $installedElectron"
  Write-Output '  npm install skipped; no dependency download required.'
} else {
  $foundDsh = $installedDsh
  if (-not $foundDsh) { $foundDsh = 'missing' }
  $foundElectron = $installedElectron
  if (-not $foundElectron) { $foundElectron = 'missing' }

  Write-Output "  Required: dsh=$expectedDsh, electron=$expectedElectron"
  Write-Output "  Found   : dsh=$foundDsh, electron=$foundElectron"

  if ($nativeNpmCache -and (Test-Path -LiteralPath $nativeNpmCache)) {
    $env:npm_config_cache = $nativeNpmCache
    Write-Output "  Reuse npm cache: $nativeNpmCache"
  } else {
    $env:npm_config_cache = $projectNpmCache
    Write-Output "  npm cache: $projectNpmCache"
  }

  if ($nativeElectronCache -and (Test-Path -LiteralPath $nativeElectronCache)) {
    $env:ELECTRON_CACHE = $nativeElectronCache
    Write-Output "  Reuse Electron cache: $nativeElectronCache"
  } else {
    $env:ELECTRON_CACHE = $projectElectronCache
    Write-Output "  Electron cache: $projectElectronCache"
  }

  $env:TEMP = $projectTemp
  $env:TMP = $projectTemp

  Push-Location (Join-Path $ROOT 'app')
  try {
    & $env:ComSpec /d /c "npm ci --prefer-offline --no-audit --no-fund"
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  $installedDsh = Get-PackageVersion $dshPkg
  $installedElectron = Get-PackageVersion $electronPkg
  if (($installedDsh -ne $expectedDsh) -or (-not (Test-Path -LiteralPath $dshBin))) {
    throw "dsh dependency verification failed: expected $expectedDsh, got $installedDsh"
  }
  if (($installedElectron -ne $expectedElectron) -or (-not (Test-Path -LiteralPath $electronExe))) {
    throw "Electron dependency verification failed: expected $expectedElectron, got $installedElectron"
  }
  Write-Output '  Dependencies installed/repaired and version-verified.'
}

Write-Output '[deps 3/3] Dependency check complete'
if ($Full) {
  $requiredSounds = @('completed.wav', 'failed.wav', 'interrupted.wav')
  $missingSound = $false
  foreach ($name in $requiredSounds) {
    $soundPath = Join-Path $ROOT ("assets\sounds\" + $name)
    if (-not (Test-Path -LiteralPath $soundPath)) {
      $missingSound = $true
    }
  }

  if ($missingSound) {
    Write-Output '  Built-in ringtones missing; generating them.'
    $soundScript = Join-Path $PSScriptRoot 'generate-sounds.ps1'
    & $soundScript | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw 'Sound generation failed.'
    }
  } else {
    Write-Output '  Built-in ringtones already exist; generation skipped.'
  }
}

Write-Output 'Dependencies OK.'
