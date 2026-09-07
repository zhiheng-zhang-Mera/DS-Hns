# DS-Harness dependency installer/repair.
# Reuses compatible local dependencies and caches before touching the network.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install-deps.ps1 [-Full]
param([switch]$Full)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

Write-Output '[deps 1/3] Resolving Node.js'
$nodeDir = (& (Join-Path $PSScriptRoot 'ensure-node.ps1') | Select-Object -Last 1)
$nodeExe = if ($nodeDir) { Join-Path $nodeDir 'node.exe' } else { $null }
if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
  throw '无法获取兼容的 Node.js。'
}
$env:PATH = "$nodeDir;$env:PATH"
Write-Output "  Node: $(& $nodeExe --version) ($nodeDir)"

# Capture machine caches BEFORE env.ps1 redirects normal runtime caches into the project.
$nativeNpmCache = ''
try { $nativeNpmCache = ((& npm config get cache 2>$null) | Select-Object -Last 1).Trim() } catch { }
$nativeElectronCache = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'electron\Cache' } else { '' }

$projectNpmCache = Join-Path $ROOT 'cache\npm'
$projectElectronCache = Join-Path $ROOT 'cache\electron'
$projectTemp = Join-Path $ROOT 'cache\temp'
New-Item -ItemType Directory -Path $projectNpmCache, $projectElectronCache, $projectTemp -Force | Out-Null

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
    return [string]((Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json).version)
  } catch { return '' }
}

$installedDsh = Get-PackageVersion $dshPkg
$installedElectron = Get-PackageVersion $electronPkg
$depsReady =
  ($installedDsh -eq $expectedDsh) -and
  ($installedElectron -eq $expectedElectron) -and
  (Test-Path -LiteralPath $dshBin) -and
  (Test-Path -LiteralPath $electronExe)

Write-Output '[deps 2/3] Checking app dependencies'
if ($depsReady) {
  Write-Output "  Reuse local @deepseek-ai/dsh $installedDsh"
  Write-Output "  Reuse local Electron $installedElectron"
  Write-Output '  npm install skipped; no dependency download required.'
} else {
  Write-Output "  Required: dsh=$expectedDsh, electron=$expectedElectron"
  Write-Output "  Found   : dsh=$($installedDsh -replace '^$','missing'), electron=$($installedElectron -replace '^$','missing')"

  # Prefer an already populated machine cache. Otherwise keep install cache project-local.
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
    & "$env:ComSpec" /d /c "npm ci --prefer-offline --no-audit --no-fund"
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }

  $installedDsh = Get-PackageVersion $dshPkg
  $installedElectron = Get-PackageVersion $electronPkg
  if ($installedDsh -ne $expectedDsh -or -not (Test-Path -LiteralPath $dshBin)) {
    throw "dsh dependency verification failed: expected $expectedDsh, got $installedDsh"
  }
  if ($installedElectron -ne $expectedElectron -or -not (Test-Path -LiteralPath $electronExe)) {
    throw "Electron dependency verification failed: expected $expectedElectron, got $installedElectron"
  }
  Write-Output '  Dependencies installed/repaired and version-verified.'
}

Write-Output '[deps 3/3] Dependency check complete'
if ($Full) {
  $requiredSounds = @('completed.wav', 'failed.wav', 'interrupted.wav')
  $missingSound = $false
  foreach ($name in $requiredSounds) {
    if (-not (Test-Path -LiteralPath (Join-Path $ROOT "assets\sounds\$name"))) { $missingSound = $true }
  }
  if ($missingSound) {
    Write-Output '  Built-in ringtones missing; generating them.'
    & (Join-Path $PSScriptRoot 'generate-sounds.ps1') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'sound generation failed' }
  } else {
    Write-Output '  Built-in ringtones already exist; generation skipped.'
  }
}

Write-Output 'Dependencies OK.'
