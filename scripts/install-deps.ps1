# DS-Harness: install / verify project dependencies (dsh core + Electron).
# Ensures a Node.js first (bundled runtime, PATH node, or auto-download via
# ensure-node.ps1), then runs `npm ci` in app\ when dependencies are missing.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-deps.ps1 [-Full]
#   -Full  also (re)generates built-in ringtones and copies .env.example if absent.
param([switch]$Full)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

Write-Output '[1/3] Ensuring Node.js...'
$ensureNode = Join-Path $PSScriptRoot 'ensure-node.ps1'
$nodeDir = (& $ensureNode | Select-Object -Last 1)
if (-not $nodeDir -or -not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
  throw '无法获取可用的 Node.js (ensure-node.ps1 失败)'
}
$env:PATH = "$nodeDir;$env:PATH"
Write-Output "  node: $(& (Join-Path $nodeDir 'node.exe') --version)  ($nodeDir)"

New-Item -ItemType Directory -Path "$ROOT\cache\npm", "$ROOT\cache\electron", "$ROOT\cache\temp" -Force | Out-Null
$env:npm_config_cache = "$ROOT\cache\npm"
$env:ELECTRON_CACHE = "$ROOT\cache\electron"
$env:TEMP = "$ROOT\cache\temp"
$env:TMP = "$ROOT\cache\temp"

$dshBin = "$ROOT\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
$electronExe = "$ROOT\app\node_modules\electron\dist\electron.exe"

Write-Output '[2/3] Installing app dependencies (npm ci)...'
if (-not (Test-Path -LiteralPath $dshBin) -or -not (Test-Path -LiteralPath $electronExe)) {
  Push-Location "$ROOT\app"
  try {
    & "$env:ComSpec" /d /c "npm ci --no-audit --no-fund"
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
} else {
  Write-Output '  app dependencies already installed'
}

if (-not (Test-Path -LiteralPath $dshBin)) { throw "dsh core missing: $dshBin" }
if (-not (Test-Path -LiteralPath $electronExe)) { throw "Electron missing: $electronExe" }
Write-Output '  dsh core + Electron OK'

if ($Full) {
  Write-Output '[3/3] Full extras: ringtones + .env.example'
  & (Join-Path $PSScriptRoot 'generate-sounds.ps1') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'sound generation failed' }
  $envFile = "$ROOT\config\.env"
  if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath "$ROOT\config\.env.example" -Destination $envFile
    Write-Output '  created config\.env from .env.example'
  } else {
    Write-Output '  config\.env already present'
  }
}

Write-Output 'Dependencies OK.'
