param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$script:failures = 0

function Check([string]$label, [bool]$ok, [string]$detail = '') {
  $marker = if ($ok) { '[PASS]' } else { '[FAIL]'; $script:failures++ }
  Write-Output ("{0} {1} {2}" -f $marker, $label, $detail)
}

Write-Output '== DeepSeek Harness disk-location verification =='
Check "Project root exists: $ROOT" (Test-Path -LiteralPath $ROOT) $ROOT
$under = $ROOT.TrimEnd('\') + '\'
Check 'Workspace under project root' ($env:DEEPSEEK_HARNESS_WORKSPACE -like "$under*") $env:DEEPSEEK_HARNESS_WORKSPACE
Check 'Temp under project root' (($env:TEMP -like "$under*") -and ($env:TMP -like "$under*")) "$env:TEMP / $env:TMP"
Check 'pip cache under project root' ($env:PIP_CACHE_DIR -like "$under*") $env:PIP_CACHE_DIR
Check 'package cache (npm) under project root' ($env:npm_config_cache -like "$under*") $env:npm_config_cache
Check 'logs under project root' ($env:DEEPSEEK_HARNESS_LOG_DIR -like "$under*") $env:DEEPSEEK_HARNESS_LOG_DIR
Check 'downloads dir present' (Test-Path -LiteralPath "$ROOT\cache\downloads") "$ROOT\cache\downloads"
Check 'DSH_HOME under project root' ($env:DSH_HOME -like "$under*") $env:DSH_HOME

$pathsRegistry = Join-Path $ROOT 'config\paths.json'
if (Test-Path -LiteralPath $pathsRegistry) {
  $pathsJson = Get-Content -LiteralPath $pathsRegistry -Raw -Encoding UTF8 | ConvertFrom-Json
  $pathProps = @($pathsJson.PSObject.Properties)
  $underRoot = @($pathProps | Where-Object { $_.Value -like "$under*" }).Count
  Check 'config/paths.json registry matches project root' ($underRoot -eq $pathProps.Count) "$underRoot / $($pathProps.Count) keys"
} else {
  Check 'config/paths.json present (run install.ps1 to generate)' $false $pathsRegistry
}

$dsh = "$ROOT\app\harness\node_modules\.bin\dsh.cmd"
Check 'dsh installed under app\harness' (Test-Path -LiteralPath $dsh) $dsh
$electron = "$ROOT\app\electron\node_modules\electron\dist\electron.exe"
Check 'Electron desktop shell installed' (Test-Path -LiteralPath $electron) $electron
Check 'Scheduler core modules present' ((Test-Path "$ROOT\app\scheduler\scheduler.js") -and (Test-Path "$ROOT\app\scheduler\gate.js")) 'scheduler.js / gate.js'
Check 'Queue state stays under data\state' (Test-Path -LiteralPath "$ROOT\data\state") "$ROOT\data\state"
Check 'settings.yaml exists' (Test-Path -LiteralPath "$env:DSH_HOME\settings.yaml") "$env:DSH_HOME\settings.yaml"
Check 'home-level cordis patch exists' (Test-Path -LiteralPath "$env:DSH_HOME\cordis.patch.yml")
$settingsText = Get-Content -LiteralPath "$env:DSH_HOME\settings.yaml" -Raw -Encoding UTF8
Check 'settings reference DEEPSEEK_API_KEY (not plaintext key)' ($settingsText -match 'apiKeyEnv:\s*DEEPSEEK_API_KEY' -and $settingsText -notmatch 'sk-[A-Za-z0-9]{8,}') 'provider uses apiKeyEnv'

$cfg = Get-Content -LiteralPath "$ROOT\config\app.json" -Raw -Encoding UTF8 | ConvertFrom-Json
Check 'monitor UI port configured' ($cfg.ui.port -gt 0) "port $($cfg.ui.port)"

Write-Output ''
Write-Output '== No avoidable C: project data =='
$homeRoot = [Environment]::GetFolderPath('UserProfile')
$candidates = @(
  "$homeRoot\.dsh",
  "$homeRoot\.huggingface",
  "$homeRoot\.cache\deepseek",
  "$env:APPDATA\npm\node_modules\@deepseek-ai",
  "$env:LOCALAPPDATA\pnpm"
)
foreach ($c in $candidates) {
  Check "No project path at C: -> $c" (-not (Test-Path -LiteralPath $c))
}
$envFile = "$ROOT\config\.env"
if (Test-Path -LiteralPath $envFile) {
  $envText = Get-Content -LiteralPath $envFile -Raw -Encoding UTF8
  Check '.env stays in config and is gitignored' ($envFile -like "$under*") $envFile
  if ($envText -match 'DEEPSEEK_API_KEY=sk-') { Write-Output '  [INFO] DEEPSEEK_API_KEY is configured for live API tests.' }
  else { Write-Output '  [WARN] DEEPSEEK_API_KEY not configured yet - set it in config\.env for live API/agent tests.' }
} else {
  Write-Output '  [WARN] config\.env missing (copy .env.example).'
}

Write-Output ''
Write-Output '== Root directory governance =='
$rootItems = Get-ChildItem -LiteralPath $ROOT -Force | Where-Object { $_.Name -notin @('.git') }
$allowed = @('app','assets','cache','config','data','docs','logs','runtime','scripts','tests','tools','workspace','README.md','TASKS.md','.gitignore')
$bad = @($rootItems | Where-Object { $_.Name -notin $allowed } | ForEach-Object { $_.Name })
Check 'No stray top-level categories' ($bad.Count -eq 0) ($bad -join ', ')
$topDirs = @($rootItems | Where-Object { $_.PSIsContainer }).Count
Check 'Top-level directory count <= 13' ($topDirs -le 13) "$topDirs directories"

Write-Output ''
Write-Output '== Runtime probes =='
$monitorPidFile = "$ROOT\data\state\monitor.pid"
if (Test-Path -LiteralPath $monitorPidFile) {
  $pidValue = Get-Content -LiteralPath $monitorPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3300/api/health' -TimeoutSec 5
      Check 'Monitor HTTP health' ($resp.StatusCode -eq 200)
    } catch { Check 'Monitor HTTP health' $false }
  }
} else {
  Write-Output '  [INFO] Monitor not running (start with run.ps1).'
}
$dshPidFile = "$ROOT\data\state\dsh-web.pid"
if (Test-Path -LiteralPath $dshPidFile) {
  $pidValue = Get-Content -LiteralPath $dshPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
    Write-Output '  [PASS] dsh Web UI process is running.'
  } else { Write-Output '  [INFO] dsh Web UI is not running.' }
}

$desktopPidFile = "$ROOT\data\state\ds-desktop.pid"
if (Test-Path -LiteralPath $desktopPidFile) {
  $pidValue = Get-Content -LiteralPath $desktopPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
    Write-Output '  [PASS] Electron desktop process is running.'
  } else { Write-Output '  [INFO] Electron desktop is not running.' }
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
