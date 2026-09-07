# DS-Harness first-time install: directories -> npm ci (dsh core + Electron,
# both from the single app\package.json) -> sounds -> unit tests.
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

Write-Output '[0/6] Creating directory structure (fresh-clone bootstrap)'
$dirs = @(
  'app', 'config', 'assets\sounds', 'scripts', 'tests', 'runtime', 'workspace\active', 'workspace\completed',
  'workspace\temp', 'cache\pip', 'cache\npm', 'cache\electron', 'cache\pnpm', 'cache\downloads',
  'cache\build', 'cache\temp', 'cache\huggingface', 'cache\models', 'data\sessions', 'data\sounds',
  'data\state', 'data\task-history', 'data\usage', 'data\pricing', 'logs\app', 'logs\harness'
)
foreach ($d in $dirs) {
  New-Item -ItemType Directory -Path (Join-Path $ROOT $d) -Force | Out-Null
}

. (Join-Path $PSScriptRoot 'env.ps1')

Write-Output '[1/6] Checking dependencies'
foreach ($tool in @('node', 'npm', 'git')) {
  $c = Get-Command $tool -ErrorAction SilentlyContinue
  if (-not $c) { Write-Error "Missing required tool: $tool" }
  else { Write-Output "  OK  $tool -> $($c.Source)" }
}

Write-Output '[2/6] npm ci for app (dsh core + Electron, local caches)'
Push-Location "$ROOT\app"
try {
  if (-not (Test-Path "$ROOT\app\node_modules\@deepseek-ai\dsh\lib\bin.js")) {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  } else {
    Write-Output '  app dependencies already installed'
  }
} finally { Pop-Location }

$dshBin = "$ROOT\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
if (-not (Test-Path -LiteralPath $dshBin)) { throw 'dsh core missing after npm ci' }
if (-not (Test-Path "$ROOT\app\node_modules\electron\dist\electron.exe")) { throw 'Electron missing after npm ci' }
Write-Output '  dsh core + Electron OK'

Write-Output '[3/6] Generating built-in ringtones'
& "$ROOT\scripts\generate-sounds.ps1" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'sound generation failed' }

Write-Output '[4/6] Running unit tests'
& "$ROOT\scripts\test-all.ps1"
if ($LASTEXITCODE -ne 0) { throw 'unit tests failed' }

Write-Output '[5/6] Optional API key'
$envFile = "$ROOT\config\.env"
if (-not (Test-Path -LiteralPath $envFile)) {
  Copy-Item -LiteralPath "$ROOT\config\.env.example" -Destination $envFile
  Write-Output '  created config\.env from .env.example (edit it to add DEEPSEEK_API_KEY)'
} else {
  Write-Output '  config\.env already present'
}

Write-Output '[6/6] Install complete'
Write-Output ''
Write-Output 'Next steps:'
Write-Output "  1. Edit config\.env and set DEEPSEEK_API_KEY=sk-..."
Write-Output "  2. Start the desktop app:  powershell -ExecutionPolicy Bypass -File $ROOT\scripts\run.ps1"
Write-Output '     (main window = official dsh Web; 视图 menu switches to 调度中心 chat/monitor/settings)'
Write-Output "  3. Ringtone settings live in 调度中心->设置(铃声), persisted to config\sound.json."
