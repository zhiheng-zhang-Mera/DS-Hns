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
$electronDir = Join-Path $ROOT 'app\node_modules\electron'
$electronPkg = Join-Path $electronDir 'package.json'
$electronInstall = Join-Path $electronDir 'install.js'
$electronExe = Join-Path $electronDir 'dist\electron.exe'

function Get-PackageVersion([string]$file) {
  try {
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    $pkg = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    return [string]$pkg.version
  } catch {
    return ''
  }
}

function Set-InstallCaches {
  if ($nativeNpmCache -and (Test-Path -LiteralPath $nativeNpmCache)) {
    $env:npm_config_cache = $nativeNpmCache
    Write-Output "  Reuse npm cache: $nativeNpmCache"
  } else {
    $env:npm_config_cache = $projectNpmCache
    Write-Output "  npm cache: $projectNpmCache"
  }

  if ($nativeElectronCache -and (Test-Path -LiteralPath $nativeElectronCache)) {
    $env:ELECTRON_CACHE = $nativeElectronCache
    $env:electron_config_cache = $nativeElectronCache
    Write-Output "  Reuse Electron cache: $nativeElectronCache"
  } else {
    $env:ELECTRON_CACHE = $projectElectronCache
    $env:electron_config_cache = $projectElectronCache
    Write-Output "  Electron cache: $projectElectronCache"
  }

  $env:TEMP = $projectTemp
  $env:TMP = $projectTemp
}

function Clear-ElectronSkipFlags {
  Remove-Item Env:\ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
  Remove-Item Env:\ELECTRON_SKIP_DOWNLOAD -ErrorAction SilentlyContinue
}

function Repair-ElectronBinary {
  $version = Get-PackageVersion $electronPkg
  if ($version -ne $expectedElectron) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $electronInstall)) {
    return $false
  }
  if (Test-Path -LiteralPath $electronExe) {
    return $true
  }

  Write-Output "  Electron npm package $version is present, but the Windows binary is missing."
  Write-Output '  Repairing Electron binary only; node_modules will not be reinstalled.'
  Set-InstallCaches
  Clear-ElectronSkipFlags

  Push-Location (Join-Path $ROOT 'app')
  try {
    & $nodeExe $electronInstall
    if ($LASTEXITCODE -ne 0) {
      throw "Electron binary installer failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  if (Test-Path -LiteralPath $electronExe) {
    Write-Output "  Electron binary repaired: $electronExe"
    return $true
  }
  return $false
}

$installedDsh = Get-PackageVersion $dshPkg
$installedElectron = Get-PackageVersion $electronPkg
$dshPackageReady = ($installedDsh -eq $expectedDsh) -and (Test-Path -LiteralPath $dshBin)
$electronPackageReady = ($installedElectron -eq $expectedElectron) -and (Test-Path -LiteralPath $electronInstall)
$electronBinaryReady = Test-Path -LiteralPath $electronExe

Write-Output '[deps 2/3] Checking app dependencies'
Write-Output "  Required: dsh=$expectedDsh, electron=$expectedElectron"
$foundDsh = $installedDsh
if (-not $foundDsh) { $foundDsh = 'missing' }
$foundElectron = $installedElectron
if (-not $foundElectron) { $foundElectron = 'missing' }
Write-Output "  Found   : dsh=$foundDsh, electron=$foundElectron"

if ($dshPackageReady -and $electronPackageReady -and $electronBinaryReady) {
  Write-Output "  Reuse local @deepseek-ai/dsh $installedDsh"
  Write-Output "  Reuse local Electron $installedElectron"
  Write-Output '  npm install skipped; no dependency download required.'
} else {
  # If package metadata is already correct, do not run npm ci just because the
  # Electron binary is missing. Repair only the binary layer.
  if ($dshPackageReady -and $electronPackageReady -and (-not $electronBinaryReady)) {
    if (-not (Repair-ElectronBinary)) {
      throw "Electron package $installedElectron is installed but dist\electron.exe could not be repaired. Check proxy/mirror settings and Electron download access."
    }
  } else {
    Set-InstallCaches
    Clear-ElectronSkipFlags
    Write-Output '  Package layer is incomplete or version-mismatched; running npm ci.'

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

    if ($installedDsh -ne $expectedDsh) {
      throw "dsh package version mismatch: expected $expectedDsh, got $installedDsh"
    }
    if (-not (Test-Path -LiteralPath $dshBin)) {
      throw "dsh package $installedDsh is present but its CLI entry is missing: $dshBin"
    }
    if ($installedElectron -ne $expectedElectron) {
      throw "Electron package version mismatch: expected $expectedElectron, got $installedElectron"
    }
    if (-not (Test-Path -LiteralPath $electronInstall)) {
      throw "Electron package $installedElectron is present but install.js is missing: $electronInstall"
    }

    if (-not (Test-Path -LiteralPath $electronExe)) {
      if (-not (Repair-ElectronBinary)) {
        throw "Electron package $installedElectron is correct, but the Windows binary is still missing after targeted repair: $electronExe"
      }
    }
  }

  # Final verification uses separate messages so equal versions can never be
  # reported as a version mismatch when only a binary/file is missing.
  $installedDsh = Get-PackageVersion $dshPkg
  $installedElectron = Get-PackageVersion $electronPkg
  if ($installedDsh -ne $expectedDsh) {
    throw "dsh package version mismatch: expected $expectedDsh, got $installedDsh"
  }
  if (-not (Test-Path -LiteralPath $dshBin)) {
    throw "dsh CLI entry missing: $dshBin"
  }
  if ($installedElectron -ne $expectedElectron) {
    throw "Electron package version mismatch: expected $expectedElectron, got $installedElectron"
  }
  if (-not (Test-Path -LiteralPath $electronExe)) {
    throw "Electron binary missing after repair: $electronExe"
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
