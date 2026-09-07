param(
  [switch]$FullAccess,
  [switch]$HeadlessShell
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')

if ($FullAccess) { $env:DSH_PERMISSION_MODE = 'danger-full-access' }

$stateDir = "$ROOT\data\state"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$electron = "$ROOT\app\node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $electron)) {
  throw "Electron not installed. Run install.ps1 first (npm ci in app)."
}
$node = (Get-Command node).Source
if (-not $node) { throw 'Node.js not found' }

function Start-Background([string]$name, [string]$file, [string[]]$argList, [string]$work, [string]$outLog) {
  $pidFile = Join-Path $stateDir "$name.pid"
  if (Test-Path -LiteralPath $pidFile) {
    $old = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
      Write-Warning "$name already running (PID $old). Stop it first (stop.ps1)."
      return $null
    }
  }
  New-Item -ItemType Directory -Path (Split-Path $outLog -Parent) -Force | Out-Null
  $errLog = $outLog -replace '\.out\.log$', '.err.log'
  $proc = Start-Process -FilePath $file -ArgumentList $argList -WorkingDirectory $work `
    -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Set-Content -LiteralPath $pidFile -Value $proc.Id
  Start-Sleep -Milliseconds 400
  Write-Output "$name started (PID $($proc.Id))"
  return $proc
}

if ($HeadlessShell) {
  # Pure Node monitor mode (no desktop window) for scripts/debugging.
  Start-Background 'monitor' $node @("$ROOT\app\monitor\ui\server.js") "$ROOT" "$ROOT\logs\app\monitor.out.log" | Out-Null
} else {
  # Desktop shell: same process runs the 3300 monitor AND spawns the dsh Web
  # engine (DSH_HOME=<root>\data), then opens the main window on dsh Web.
  Start-Background 'ds-desktop' $electron @('.') "$ROOT\app" "$ROOT\logs\app\electron.out.log" | Out-Null
}

Start-Sleep -Seconds 4
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3300/api/health' -TimeoutSec 5
  Write-Output ''
  Write-Output 'DS-Harness is running.'
  Write-Output "  调度中心 API   : http://127.0.0.1:3300 (queue/peak/cost/sounds)"
  Write-Output '  Electron window: main view = official dsh Web; 视图 menu = 调度中心 (chat/monitor/settings)'
  Write-Output "  Logs           : $ROOT\logs"
} catch {
  Write-Warning 'Desktop app process started but the local API is not responding yet. Check logs\app\electron.err.log'
}
