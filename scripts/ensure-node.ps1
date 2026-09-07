# DS-Harness: ensure a usable Node.js exists.
# Priority:
#   1. A bundled runtime already under <root>\runtime\node-v*-win-x64
#   2. node already on PATH
#   3. Auto-repair: download a portable Node zip into <root>\runtime and unpack it
# Prints the directory containing node.exe on success; exit code 0 on success.
# Version override: -NodeVersion or env DSH_NODE_VERSION (default v24.14.1).
param([string]$NodeVersion = '')
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $ROOT 'runtime'
$downloadsDir = Join-Path $ROOT 'cache\downloads'
$version = if ($NodeVersion) { $NodeVersion }
           elseif ($env:DSH_NODE_VERSION) { $env:DSH_NODE_VERSION }
           else { 'v24.14.1' }
$ProgressPreference = 'SilentlyContinue'

function Find-BundledNode {
  if (-not (Test-Path -LiteralPath $runtimeDir)) { return $null }
  Get-ChildItem -Path $runtimeDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'node-v*-win-x64' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe')) } |
    Sort-Object Name |
    Select-Object -Last 1
}

$bundled = Find-BundledNode
if ($bundled) {
  Write-Output $bundled.FullName
  exit 0
}

$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode) {
  Write-Output (Split-Path -Parent $sysNode.Source)
  exit 0
}

# ---- auto-repair: download portable Node ----
Write-Host "[ensure-node] Node.js not found. Downloading portable node-$version (this happens once)..."
New-Item -ItemType Directory -Path $runtimeDir, $downloadsDir -Force | Out-Null

$zipName = "node-$version-win-x64.zip"
$zipPath = Join-Path $downloadsDir $zipName
$urls = @(
  "https://nodejs.org/dist/$version/$zipName",
  "https://npmmirror.com/mirrors/node/$version/$zipName"
)

$downloaded = $false
foreach ($url in $urls) {
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Write-Host "[ensure-node] downloading $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 600
    $downloaded = $true
    break
  } catch {
    Write-Host "[ensure-node] download failed from $url : $($_.Exception.Message)"
  }
}
if (-not $downloaded -or -not (Test-Path -LiteralPath $zipPath)) {
  Write-Error "无法自动下载 Node.js。请手动下载 $zipName 并解压到 $runtimeDir ,或安装 Node.js >= 20 并加入 PATH。"
  exit 1
}

Write-Host "[ensure-node] unpacking $zipPath -> $runtimeDir"
Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimeDir -Force

$dir = Join-Path $runtimeDir "node-$version-win-x64"
$nodeExe = Join-Path $dir 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  Write-Error "解压后未找到 $nodeExe"
  exit 1
}
$null = & $nodeExe --version
Write-Host "[ensure-node] ready: $dir (version $(& $nodeExe --version))"
Write-Output $dir
exit 0
