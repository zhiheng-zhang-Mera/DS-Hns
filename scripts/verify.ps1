param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$script:failures = 0
function Check([string]$label,[bool]$ok,[string]$detail=''){ if($ok){Write-Output "[PASS] $label $detail"}else{$script:failures++;Write-Output "[FAIL] $label $detail"} }

Write-Output '== DS-Harness Alien-derived architecture verification =='
Check 'Official shell entry present' (Test-Path "$ROOT\app\desktop-main.cjs")
Check 'Runtime ownership helper present' (Test-Path "$ROOT\app\runtime-process.cjs")
Check 'Safe runtime cleanup helper present' (Test-Path "$ROOT\scripts\cleanup-runtime.ps1")
Check 'Legacy app\monitor removed' (-not (Test-Path "$ROOT\app\monitor"))
Check 'Mega extension exists' (Test-Path "$ROOT\app\extensions\mega\index.cjs")
Check 'Mega dock page exists' (Test-Path "$ROOT\app\extensions\mega\ui\dock.html")
Check 'Mega dock renderer exists' (Test-Path "$ROOT\app\extensions\mega\ui\dock.js")
Check 'Mega dock stylesheet exists' (Test-Path "$ROOT\app\extensions\mega\ui\dock.css")
Check 'Mega hardware probe exists' (Test-Path "$ROOT\app\extensions\mega\scheduler\system.js")
Check 'Official session delivery client exists' (Test-Path "$ROOT\app\extensions\mega\deepseek\official-session-client.js")
Check 'Extension manager exists' (Test-Path "$ROOT\app\extensions\manager.cjs")
$main = Get-Content "$ROOT\app\desktop-main.cjs" -Raw
$mega = Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw
$scheduler = Get-Content "$ROOT\app\extensions\mega\scheduler\scheduler.js" -Raw
$system = Get-Content "$ROOT\app\extensions\mega\scheduler\system.js" -Raw
$official = Get-Content "$ROOT\app\extensions\mega\deepseek\official-session-client.js" -Raw
$create = ($main -split 'async function startExtensions')[0]
Check 'Official main window has no preload' (-not ($create -match 'preload\s*:'))
Check 'Pure Alien kill switch exists' ($main -match 'DSH_DISABLE_MEGA')
Check 'Owned stale runtime recovery wired' ($main -match 'recoverOwnedStale')
Check 'Mega dock is isolated BrowserWindow' (($mega -match 'function createDock') -and ($mega -match 'parent: ctx\.mainWindow'))
Check 'Mega dock collapse state persists' (($mega -match 'mega-dock\.json') -and ($mega -match 'setDockExpanded'))
Check 'Mega tray entrance exists' ($mega -match 'function createTray')
Check 'Manual queue reorder IPC exists' ($mega -match 'mega:reorder-task')
Check 'Queue order is persistent' (($scheduler -match 'queueOrder') -and ($scheduler -match 'reorderTask'))
Check 'Scheduled tasks default to official sessions' (($scheduler -match "requestedDeliveryMode = 'official-session'") -and ($scheduler -match 'launchOfficial'))
Check 'Official RPC uses create and prompt' (($official -match "session/create") -and ($official -match "session/prompt") -and ($official -match "session/list"))
Check 'Official RPC reuses Electron auth cookie' (($official -match 'defaultSession') -and ($official -match 'dsh-auth-'))
Check 'Hardware-auto concurrency exists' (($system -match 'hardware-auto') -and ($system -match 'hardwareCap'))
Check 'Windows hardware inventory probe exists' ($system -match 'Win32_Processor')
Check 'dsh core installed' (Test-Path "$ROOT\app\node_modules\@deepseek-ai\dsh\lib\bin.js")
Check 'Electron installed' (Test-Path "$ROOT\app\node_modules\electron\dist\electron.exe")
Check 'Pricing snapshot present' (Test-Path "$ROOT\data\pricing\official-pricing.json")
Check 'Sounds present' (Test-Path "$ROOT\assets\sounds")

if (-not $SkipTests) {
  Write-Output ''
  Write-Output '== Unit + architecture tests =='
  Push-Location "$ROOT\app"
  try { npm test; if ($LASTEXITCODE -ne 0) { $script:failures++ } } finally { Pop-Location }
}

if ($script:failures -eq 0) { Write-Output 'VERIFY: ALL CHECKS PASSED' } else { Write-Output "VERIFY: $script:failures check(s) FAILED" }
exit $script:failures
