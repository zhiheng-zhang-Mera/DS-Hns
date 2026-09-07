# DS-Harness: ensure a compatible Node.js exists without downloading twice.
# Priority:
#   1. compatible bundled runtime under <root>\runtime\node-v*-win-x64
#   2. compatible Node.js already on PATH
#   3. cached portable Node zip already under <root>\cache\downloads
#   4. download portable Node once, then keep the zip for repair/reinstall
# Minimum supported Node major: 20.
param([string]$NodeVersion = '')
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $ROOT 'runtime'
$downloadsDir = Join-Path $ROOT 'cache\downloads'
$version = if ($NodeVersion) { $NodeVersion }
           elseif ($env:DSH_NODE_VERSION) { $env:DSH_NODE_VERSION }
           else { 'v24.14.1' }
$ProgressPreference = 'SilentlyContinue'
$minMajor = 20

function Get-NodeMajor([string]$nodeExe) {
  try {
    $raw = (& $nodeExe --version 2>$null | Select-Object -First 1)
    if ($raw -match '^v?(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

function Test-CompatibleNode([string]$nodeExe) {
  return (Test-Path -LiteralPath $nodeExe) -and ((Get-NodeMajor $nodeExe) -ge $minMajor)
}

function Find-BundledNode {
  if (-not (Test-Path -LiteralPath $runtimeDir)) { return $null }
  $candidates = Get-ChildItem -Path $runtimeDir -Directory -ErrorAction SilentlyContinue |
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
  Write-Host "[ensure-node] reuse bundled Node $(& (Join-Path $bundled.FullName 'node.exe') --version)"
  Write-Output $bundled.FullName
  return
}

$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode -and (Test-CompatibleNode $sysNode.Source)) {
  Write-Host "[ensure-node] reuse PATH Node $(& $sysNode.Source --version)"
  Write-Output (Split-Path -Parent $sysNode.Source)
  return
}
if ($sysNode) {
  Write-Host "[ensure-node] PATH Node is too old ($(& $sysNode.Source --version)); need Node >= $minMajor."
}

New-Item -ItemType Directory -Path $runtimeDir, $downloadsDir -Force | Out-Null
$zipName = "node-$version-win-x64.zip"
$zipPath = Join-Path $downloadsDir $zipName
$targetDir = Join-Path $runtimeDir "node-$version-win-x64"
$targetExe = Join-Path $targetDir 'node.exe'

function Expand-CachedZip {
  if (-not (Test-Path -LiteralPath $zipPath)) { return $false }
  try {
    if ((Get-Item -LiteralPath $zipPath).Length -lt 1MB) { return $false }
    Write-Host "[ensure-node] reuse cached archive $zipPath"
    if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
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
    if ((Get-Item -LiteralPath $zipPath).Length -ge 1MB) {
      $downloaded = $true
      break
    }
  } catch {
    Write-Host "[ensure-node] download failed from $url : $($_.Exception.Message)"
  }
}
if (-not $downloaded) {
  throw "无法自动下载 Node.js。请手动下载 $zipName 到 $downloadsDir，或安装 Node.js >= $minMajor 并加入 PATH。"
}

if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
Write-Host "[ensure-node] unpacking $zipPath -> $runtimeDir"
Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimeDir -Force
if (-not (Test-CompatibleNode $targetExe)) {
  throw "解压后未找到兼容 Node.js: $targetExe"
}
Write-Host "[ensure-node] ready: $targetDir ($(& $targetExe --version))"
Write-Output $targetDir
