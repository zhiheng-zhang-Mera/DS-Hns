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

Start-Sleep -Seconds 3
$portsFile = "$ROOT\data\state\ports.json"
$uiPort = 3300
$dshPort = 3080
if (Test-Path -LiteralPath $portsFile) {
  try {
    $pj = Get-Content -LiteralPath $portsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pj.ui) { $uiPort = $pj.ui }
    if ($pj.dsh) { $dshPort = $pj.dsh }
  } catch { }
}

# 等待窗口/服务真正就绪(最多 ~25s),确保“启动后必然有响应”。
$up = $false
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$uiPort/api/health" -TimeoutSec 2
    if ($resp.StatusCode -eq 200) { $up = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 600
}
if ($up) {
  Write-Output ''
  Write-Output 'DS-Harness is running (window should be visible / flashed).'
  Write-Output "  调度中心 API   : http://127.0.0.1:$uiPort (queue/peak/cost/sounds)"
  Write-Output "  dsh Web        : http://127.0.0.1:$dshPort (官方 dsh UI;被占用已自动错开)"
  Write-Output '  Electron window: main view = 对话主界面(菜单栏已并入界面); Ctrl+1..3 切 监控/设置'
  Write-Output "  Logs           : $ROOT\logs"
} else {
  Write-Warning 'DS-Harness 未能就绪。请查看 logs\app\electron.err.log 与 logs\desktop-runtime.log。'
  Write-Warning '可能原因:端口冲突已自动错开、或引擎/Electron 启动异常。'
  exit 1
}
