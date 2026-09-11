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
$create = $main.Substring($main.IndexOf('function createWindow()'), $main.IndexOf('async function startExtensions') - $main.IndexOf('function createWindow()'))
$officialView = ($main -split 'function createOfficialHarnessView')[1]
$officialView = ($officialView -split 'async function createIntegratedMegaDock')[0]
Check 'Official main window has no preload' (-not ($create -match 'preload\s*:'))
Check 'Official WebContentsView has no preload' (-not ($officialView -match 'preload\s*:'))
Check 'Pure Alien kill switch exists' ($main -match 'DSH_DISABLE_MEGA')
Check 'Owned stale runtime recovery wired' ($main -match 'recoverOwnedStale')
Check 'Mega dock is isolated BrowserWindow' (($mega -match 'function createDock') -and ($mega -match 'parent: ctx\.mainWindow'))
Check 'Mega dock collapse state persists' (($mega -match 'mega-dock\.json') -and ($mega -match 'setDockExpanded'))
Check 'Mega tray entrance exists' ($mega -match 'function createTray')
$trayMenu = ($mega -split 'function applyTrayMenu')[1]
$trayMenu = ($trayMenu -split 'function requestShutdown')[0]
Check 'Tray menu is exit only' (($trayMenu -match "Exit DS-Harness") -and ($trayMenu -match "Force Exit DS-Harness") -and (-not ($trayMenu -match 'Mega Dock|Full Mega Tools|Official Harness')))
Check 'Tray double click focuses main window' ($mega -match "tray\.on\('double-click', focusMain\)")
Check 'Graceful and force exit implemented' (($main -match 'function gracefulExit\(') -and ($main -match 'function forceExit\(') -and ($main -match 'app\.exit\(0\)'))
Check 'Force exit kills the managed child tree' ($main -match "'\/T', '\/F'")
Check 'Full Mega Tools window removed' ((-not (Test-Path "$ROOT\app\extensions\mega\ui\index.html")) -and (-not ($mega -match 'function openTools\(')) -and (-not ($mega -match 'toolsWindow')))
Check 'No dead mega:open-tools IPC' (-not (($mega + (Get-Content "$ROOT\app\extensions\mega\ui\preload.cjs" -Raw)) -match 'mega:open-tools'))
$dockHtml = Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw
$dockJs = Get-Content "$ROOT\app\extensions\mega\ui\dock.js" -Raw
Check 'Dock settings overlay exists' ($dockHtml -match 'id="settingsOverlay"')
Check 'Dock settings reuse existing IPC' (($dockJs -match 'megaTools\.updateSettings') -and ($dockJs -match 'megaTools\.updateScheduler'))
Check 'Mega Recent Session removed' (-not (($dockHtml + $dockJs) -match 'id="sessions"|session-item|tokenCount|recentSessionCost|costCny'))
Check 'Unified terminal observer exists' ((Test-Path "$ROOT\app\extensions\mega\tracker\terminal-observer.js") -and (Test-Path "$ROOT\app\extensions\mega\notifications\terminal-dispatch.js"))
Check 'Manual queue reorder IPC exists' ($mega -match 'mega:reorder-task')
Check 'Extension status module exists' ((Test-Path "$ROOT\app\extensions\mega\updater\harness-updater.js") -and (Test-Path "$ROOT\app\extensions\mega\updater\update-runner.js"))
Check 'Dock offers the harness update button' (($dockHtml -match 'id="updateApply"') -and ($dockHtml -match 'id="updateCheck"') -and ($dockJs -match 'megaTools\.applyHarnessUpdate'))
Check 'Harness update IPC exists' (($mega -match 'mega:update-check') -and ($mega -match 'mega:update-apply') -and ($mega -match 'scheduleRestart'))
Check 'Harness update runs detached from the shell' (((Get-Content "$ROOT\app\extensions\mega\updater\harness-updater.js" -Raw) -match 'detached: true') -and ((Get-Content "$ROOT\app\extensions\mega\updater\update-runner.js" -Raw) -match 'waitForParentExit'))
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
