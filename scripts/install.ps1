$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

Write-Output '[0/6] Creating category structure (fresh-clone bootstrap)'
$dirs = @('app','config','runtime','cache','data','logs','assets','scripts','tests','docs','tools','workspace',
  'cache\pip','cache\npm','cache\pnpm','cache\downloads','cache\build','cache\temp','cache\huggingface','cache\models',
  'data\pricing','data\task-history','data\usage','data\state','data\dsh\sessions','data\dsh\storages',
  'logs\app','logs\harness','logs\api','logs\errors','assets\sounds',
  'workspace\active','workspace\completed','workspace\temp','runtime\dsh','tools\portable')
foreach ($d in $dirs) { New-Item -ItemType Directory -Path (Join-Path $ROOT $d) -Force | Out-Null }

. (Join-Path $PSScriptRoot 'env.ps1')
Write-Output '[1/6] Checking dependencies'
foreach ($tool in @('node', 'npm', 'git')) {
  $c = Get-Command $tool -ErrorAction SilentlyContinue
  if (-not $c) { Write-Error "Missing required tool: $tool" }
  else { Write-Output "  OK  $tool -> $($c.Source)" }
}

Write-Output '[2/6] Installing dsh npm packages (local caches)'
Push-Location "$ROOT\app\harness"
try {
  if (-not (Test-Path "$ROOT\app\harness\node_modules\@deepseek-ai\dsh")) {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  } else {
    Write-Output '  dsh package already installed'
  }
  $dsh = "$ROOT\app\harness\node_modules\.bin\dsh.cmd"
  & $dsh --version
} finally { Pop-Location }

Write-Output '[3/6] Installing Electron desktop shell (local caches)'
Push-Location "$ROOT\app\electron"
try {
  if (-not (Test-Path "$ROOT\app\electron\node_modules\electron\dist\electron.exe")) {
    $env:ELECTRON_CACHE = "$ROOT\cache\electron"
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'electron npm install failed' }
    node "$ROOT\app\electron\node_modules\electron\install.js"
  } else {
    Write-Output '  Electron already installed'
  }
} finally { Pop-Location }

Write-Output '[4/6] Initializing dsh profiles (web, headless)'
$env:DSH_HOME = "$ROOT\runtime\dsh"
$dsh = "$ROOT\app\harness\node_modules\.bin\dsh.cmd"
& $dsh --profile web --dump-config *> "$ROOT\cache\temp\verify-web-config.yml"
if ($LASTEXITCODE -ne 0) { throw 'web profile init failed' }

Write-Output '[5/6] Generating notification sounds'
& "$ROOT\scripts\generate-sounds.ps1" | Out-Null

Write-Output '[6/6] Running unit tests'
& "$ROOT\scripts\test-all.ps1"

Write-Output 'Writing machine-local paths registry (config\paths.json, gitignored)'
$pathsMap = [ordered]@{
  ROOT         = $ROOT
  APP          = "$ROOT\app"
  CONFIG       = "$ROOT\config"
  RUNTIME      = "$ROOT\runtime"
  DSH_HOME     = "$ROOT\runtime\dsh"
  CACHE        = "$ROOT\cache"
  TEMP         = "$ROOT\cache\temp"
  DOWNLOADS    = "$ROOT\cache\downloads"
  LOGS         = "$ROOT\logs"
  DATA         = "$ROOT\data"
  TOOLS        = "$ROOT\tools"
  WORKSPACE    = "$ROOT\workspace"
  SESSIONS     = "$ROOT\data\dsh\sessions"
  TASK_HISTORY = "$ROOT\data\task-history"
  PRICING      = "$ROOT\data\pricing"
  SOUNDS       = "$ROOT\assets\sounds"
}
[System.IO.File]::WriteAllText(
  (Join-Path $ROOT 'config\paths.json'),
  ($pathsMap | ConvertTo-Json),
  (New-Object System.Text.UTF8Encoding($false))
)

Write-Output 'Install complete. Configure DEEPSEEK_API_KEY in config\.env, then run scripts\run.ps1'
