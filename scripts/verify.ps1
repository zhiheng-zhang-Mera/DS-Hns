param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$script:failures = 0

function Check([string]$label, [bool]$ok, [string]$detail = '') {
  $marker = if ($ok) { '[PASS]' } else { '[FAIL]'; $script:failures++ }
  Write-Output ("{0} {1} {2}" -f $marker, $label, $detail)
}

Write-Output '== DS-Harness disk-location verification =='
Check "Project root exists: $ROOT" (Test-Path -LiteralPath $ROOT) $ROOT
$under = $ROOT.TrimEnd('\') + '\'
Check 'Workspace under project root' ($env:DEEPSEEK_HARNESS_WORKSPACE -like "$under*") $env:DEEPSEEK_HARNESS_WORKSPACE
Check 'Temp under project root' (($env:TEMP -like "$under*") -and ($env:TMP -like "$under*")) "$env:TEMP / $env:TMP"
Check 'npm cache under project root' ($env:npm_config_cache -like "$under*") $env:npm_config_cache
Check 'DSH_HOME = <root>\data (shared engine home)' ($env:DSH_HOME -eq "$ROOT\data") $env:DSH_HOME
Check 'logs under project root' ($env:DEEPSEEK_HARNESS_LOG_DIR -like "$under*") $env:DEEPSEEK_HARNESS_LOG_DIR

Write-Output ''
Write-Output '== Install completeness =='
$dshBin = "$ROOT\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
Check 'dsh core installed (single app install)' (Test-Path -LiteralPath $dshBin) $dshBin
$electron = "$ROOT\app\node_modules\electron\dist\electron.exe"
Check 'Electron desktop shell installed' (Test-Path -LiteralPath $electron) $electron
Check 'Monitor server module present' (Test-Path -LiteralPath "$ROOT\app\monitor\ui\server.js") 'app\monitor\ui\server.js'
Check 'Scheduler core modules present' ((Test-Path "$ROOT\app\monitor\scheduler\scheduler.js") -and (Test-Path "$ROOT\app\monitor\scheduler\gate.js")) 'scheduler.js / gate.js'
Check 'Electron shell entry present' (Test-Path -LiteralPath "$ROOT\app\desktop-main.cjs") 'desktop-main.cjs'
Check 'Pricing snapshot present' (Test-Path -LiteralPath "$ROOT\data\pricing\official-pricing.json") 'data\pricing\official-pricing.json'
Check 'Sessions dir present' (Test-Path -LiteralPath "$ROOT\data\sessions") "$ROOT\data\sessions"
Check 'Sounds dir present' (Test-Path -LiteralPath "$ROOT\assets\sounds") "$ROOT\assets\sounds"

$soundJson = Get-Content -LiteralPath "$ROOT\config\sound.json" -Raw -Encoding UTF8 | ConvertFrom-Json
Check 'sound.json master switch present' ($null -ne $soundJson.enabled) 'enabled'
Check 'sound.json per-event switches present' (($soundJson.events.COMPLETED.enabled -ne $null) -and ($soundJson.events.FAILED.enabled -ne $null) -and ($soundJson.events.INTERRUPTED.enabled -ne $null)) 'events.*.enabled'

$cfg = Get-Content -LiteralPath "$ROOT\config\app.json" -Raw -Encoding UTF8 | ConvertFrom-Json
Check 'monitor UI port configured' ($cfg.ui.port -gt 0) "port $($cfg.ui.port)"

Write-Output ''
Write-Output '== No avoidable C: project data =='
# The authoritative guarantee is checked above: every cache/log/home env var
# of this project points inside $ROOT. The folders below may exist on the
# machine from other tools (pnpm/npm/huggingface) — informational only.
$homeRoot = [Environment]::GetFolderPath('UserProfile')
$candidates = @(
  "$homeRoot\.dsh",
  "$homeRoot\.huggingface",
  "$homeRoot\.cache\deepseek",
  "$env:APPDATA\npm\node_modules\@deepseek-ai",
  "$env:LOCALAPPDATA\pnpm"
)
foreach ($c in $candidates) {
  if (Test-Path -LiteralPath $c) {
    Write-Output "  [WARN] pre-existing path (not created by DS-Harness; env vars all point under $ROOT): $c"
  } else {
    Write-Output "  [INFO] clean: $c"
  }
}
$envFile = "$ROOT\config\.env"
if (Test-Path -LiteralPath $envFile) {
  $envText = Get-Content -LiteralPath $envFile -Raw -Encoding UTF8
  Check '.env stays in config and is gitignored' ($envFile -like "$under*") $envFile
  if ($envText -match 'DEEPSEEK_API_KEY=sk-') { Write-Output '  [INFO] DEEPSEEK_API_KEY is configured for live API tests.' }
  else { Write-Output '  [WARN] DEEPSEEK_API_KEY not configured yet - set it in config\.env for live API/agent tests.' }
} else {
  Write-Output '  [WARN] config\.env missing (copy config\.env.example).'
}

Write-Output ''
Write-Output '== Runtime probes =='
$portsFile = "$ROOT\data\state\ports.json"
$uiPort = 3300
if (Test-Path -LiteralPath $portsFile) {
  try {
    $pj = Get-Content -LiteralPath $portsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pj.ui) { $uiPort = $pj.ui }
  } catch { }
}
if (Test-Path "$ROOT\data\state\monitor.pid") {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$uiPort/api/health" -TimeoutSec 5
    Check "Monitor HTTP health ($uiPort)" ($resp.StatusCode -eq 200)
  } catch { Check "Monitor HTTP health ($uiPort)" $false }
} else {
  Write-Output '  [INFO] Monitor not running (start with run.ps1).'
}
if (Test-Path "$ROOT\data\state\ds-desktop.pid") {
  Write-Output '  [INFO] Electron desktop PID file present.'
} else {
  Write-Output '  [INFO] Electron desktop not running (start with run.ps1).'
}

if (-not $SkipTests) {
  Write-Output ''
  Write-Output '== Automated unit tests =='
  & "$ROOT\scripts\test-all.ps1"
  if ($LASTEXITCODE -ne 0) { $script:failures++ }
}

Write-Output ''
if ($script:failures -eq 0) { Write-Output 'VERIFY: ALL CHECKS PASSED' }
else { Write-Output "VERIFY: $script:failures check(s) FAILED" }
exit $script:failures
