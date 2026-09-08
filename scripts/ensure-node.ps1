# DS-Harness: ensure a compatible Node.js exists without downloading twice.
# Windows PowerShell 5.1 compatible and ASCII-only.
param([string]$NodeVersion = '')
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $ROOT 'runtime'
$downloadsDir = Join-Path $ROOT 'cache\downloads'
$ProgressPreference = 'SilentlyContinue'
$minMajor = 20

if ($NodeVersion) {
  $version = $NodeVersion
} elseif ($env:DSH_NODE_VERSION) {
  $version = $env:DSH_NODE_VERSION
} else {
  $version = 'v24.14.1'
}

function Get-NodeMajor([string]$nodeExe) {
  try {
    $raw = (& $nodeExe --version 2>$null | Select-Object -First 1)
    if ($raw -match '^v?(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

function Test-CompatibleNode([string]$nodeExe) {
  if (-not $nodeExe) { return $false }
  if (-not (Test-Path -LiteralPath $nodeExe)) { return $false }
  return ((Get-NodeMajor $nodeExe) -ge $minMajor)
}

function Find-BundledNode {
  if (-not (Test-Path -LiteralPath $runtimeDir)) { return $null }
  $candidates = Get-ChildItem -LiteralPath $runtimeDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'node-v*-win-x64' } |
    Sort-Object Name -Descending
  foreach ($dir in $candidates) {
    $exe = Join-Path $dir.FullName 'node.exe'
    if (Test-CompatibleNode $exe) { return $dir }
  }
  return $null
}

$bundled = Find-BundledNode
if ($bundled) {
  $bundledExe = Join-Path $bundled.FullName 'node.exe'
  Write-Host "[ensure-node] reuse bundled Node $(& $bundledExe --version)"
  Write-Output $bundled.FullName
  return
}

$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode) {
  if (Test-CompatibleNode $sysNode.Source) {
    Write-Host "[ensure-node] reuse PATH Node $(& $sysNode.Source --version)"
    Write-Output (Split-Path -Parent $sysNode.Source)
    return
  }
  Write-Host "[ensure-node] PATH Node is too old; Node >= $minMajor is required."
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $downloadsDir -Force | Out-Null
$zipName = "node-$version-win-x64.zip"
$zipPath = Join-Path $downloadsDir $zipName
$targetDir = Join-Path $runtimeDir "node-$version-win-x64"
$targetExe = Join-Path $targetDir 'node.exe'

function Expand-CachedZip {
  if (-not (Test-Path -LiteralPath $zipPath)) { return $false }
  try {
    $zipInfo = Get-Item -LiteralPath $zipPath
    if ($zipInfo.Length -lt 1048576) { return $false }
    Write-Host "[ensure-node] reuse cached archive $zipPath"
    if (Test-Path -LiteralPath $targetDir) {
      Remove-Item -LiteralPath $targetDir -Recurse -Force
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimeDir -Force
    return (Test-CompatibleNode $targetExe)
  } catch {
    Write-Host "[ensure-node] cached archive is unusable: $($_.Exception.Message)"
    return $false
  }
}

if (Expand-CachedZip) {
  Write-Host "[ensure-node] ready: $targetDir ($(& $targetExe --version))"
  Write-Output $targetDir
  return
}

Write-Host "[ensure-node] no compatible local Node found. Downloading portable node-$version once..."
$urls = @(
  "https://nodejs.org/dist/$version/$zipName",
  "https://npmmirror.com/mirrors/node/$version/$zipName"
)
$downloaded = $false
foreach ($url in $urls) {
  Write-Host "[ensure-node] downloading $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 600
    $zipInfo = Get-Item -LiteralPath $zipPath
    if ($zipInfo.Length -ge 1048576) {
      $downloaded = $true
      break
    }
  } catch {
    Write-Host "[ensure-node] download failed from $url : $($_.Exception.Message)"
  }
}

if (-not $downloaded) {
  throw "Unable to download Node.js automatically. Put $zipName in $downloadsDir or install Node.js >= $minMajor and add it to PATH."
}

if (Test-Path -LiteralPath $targetDir) {
  Remove-Item -LiteralPath $targetDir -Recurse -Force
}
Write-Host "[ensure-node] unpacking $zipPath -> $runtimeDir"
Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimeDir -Force
if (-not (Test-CompatibleNode $targetExe)) {
  throw "Compatible Node.js was not found after extraction: $targetExe"
}
Write-Host "[ensure-node] ready: $targetDir ($(& $targetExe --version))"
Write-Output $targetDir
