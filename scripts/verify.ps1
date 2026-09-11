param([switch]$SkipTests, [switch]$Acceptance)
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

Write-Output ''
Write-Output '== Optional Sub-worker execution layer =='
foreach ($file in @('manager.cjs','runtime.cjs','protocol.cjs','state.cjs','permissions.cjs','event-bus.cjs','reporter.cjs','task-runner.cjs')) {
  Check "Sub-worker module $file present" (Test-Path "$ROOT\app\sub-worker\$file")
}
$swProtocol = Get-Content "$ROOT\app\sub-worker\protocol.cjs" -Raw
$swState = Get-Content "$ROOT\app\sub-worker\state.cjs" -Raw
$swPerm = Get-Content "$ROOT\app\sub-worker\permissions.cjs" -Raw
$swRuntime = Get-Content "$ROOT\app\sub-worker\runtime.cjs" -Raw
$swManager = Get-Content "$ROOT\app\sub-worker\manager.cjs" -Raw
$swRun = Get-Content "$ROOT\app\sub-worker\task-runner.cjs" -Raw
$swBus = Get-Content "$ROOT\app\sub-worker\event-bus.cjs" -Raw
$swPreload = Get-Content "$ROOT\app\extensions\mega\ui\preload.cjs" -Raw
$swUi = (Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) + "`n" + (Get-Content "$ROOT\app\extensions\mega\ui\dock.js" -Raw)
$appConfig = Get-Content "$ROOT\config\app.json" -Raw
Check 'Sub-worker is disabled by default' ($appConfig -match '"enabledOnStartup":\s*false')
Check 'Phase 1 stays single worker' ($appConfig -match '"maxWorkers":\s*1')
Check 'Auto Delegate defaults to off' ($appConfig -match '"autoDelegate":\s*false')
Check 'Worker runtime is plain Node (no Electron)' ((-not ($swRuntime -match "require\('electron'\)")) -and (-not ($swManager -match "require\('electron'\)")))
Check 'Sub-worker never opens a window' (-not ($swUi -match 'new BrowserWindow'))
Check 'Structured task protocol is versioned' (($swProtocol -match 'PROTOCOL_VERSION = 1') -and ($swProtocol -match 'validateTask'))
Check 'Result protocol is implemented' (($swProtocol -match 'function createResult') -and ($swProtocol -match 'needs_controller_review'))
Check 'L3/L4 are rejected by contract' ($swProtocol -match "ALLOWED_RISK_LEVELS")
Check 'Vision capability is refused explicitly' ($swPerm -match 'UNSUPPORTED_CAPABILITY')
Check 'High-risk commands are denied' (($swPerm -match 'DENIED_COMMAND_PATTERNS') -and ($swPerm -match 'git\\s\+push') -and ($swPerm -match 'taskkill'))
Check 'Protected branches are guarded' (($swPerm -match 'PROTECTED_BRANCHES') -and ($swPerm -match 'isProtectedBranch'))
Check 'Path allow/forbid guard exists' (($swPerm -match 'function checkPath') -and ($swPerm -match 'CRITICAL_DELETE_PATTERNS'))
Check 'Worker state machine is explicit' (($swProtocol -match 'WORKER_STATES') -and ($swState -match 'const TRANSITIONS') -and ($swState -match 'canTransition'))
Check 'Isolated worktree automation exists' (($swManager -match 'WorktreeManager') -and ($swManager -match 'hns-sub-worker'))
Check 'Single-writer workspace lock exists' (($swState -match 'workspaceLockFile') -and ($swManager -match 'loadWorkspaceLock'))
Check 'Worker crash is isolated from the shell' (($swManager -match 'handleExit') -and ($swManager -match 'CRASHED'))
Check 'Task runner emits auditable events' (($swRun -match "'file_write'") -and ($swRun -match "'command_finished'") -and ($swRun -match "'test_result'"))
Check 'Command output is redacted' ($swBus -match 'redactSecrets')
Check 'Typed runtime ownership + orphan reclaim' ((Get-Content "$ROOT\app\runtime-process.cjs" -Raw) -match 'recoverStaleWorker')
Check 'Tray exposes Sub-worker controls' ($mega -match 'subWorkerTrayItem')
Check 'Mega Sub-worker panel exists' (($swUi -match 'id="swState"') -and ($swUi -match 'Enable Sub-worker'))
Check 'Live View exists inside the dock' (($swUi -match 'id="liveView"') -and ($swUi -match 'Execution Summary'))
Check 'Live View declares its audit-only scope' ($swUi -match 'lv-note')
Check 'Live View supports Pause/Stop/Send Note/Take Over' (($swUi -match 'id="lvPause"') -and ($swUi -match 'id="lvStop"') -and ($swUi -match 'id="lvNote"') -and ($swUi -match 'id="lvTakeOver"'))
Check 'Preload exposes the Sub-worker bridge' ($swPreload -match 'megaSubWorker')
Check 'Shell registers Sub-worker IPC' (($main -match 'SUB_WORKER_CHANNELS') -and ($main -match 'registerSubWorkerIpc'))
Check 'Exit terminates the worker before the Harness' ($main -match 'stopSubWorkerOnExit\(')
Check 'Harness port default is unchanged' ($main -match 'const HARNESS_PORT = .*: 3080')
Check 'Real acceptance harness exists' (Test-Path "$ROOT\scripts\sub-worker-acceptance.cjs")
Check 'Sub-worker reference doc exists' (Test-Path "$ROOT\docs\sub-worker.md")

if (-not $SkipTests) {
  Write-Output ''
  Write-Output '== Unit + architecture tests =='
  Push-Location "$ROOT\app"
  try { npm test; if ($LASTEXITCODE -ne 0) { $script:failures++ } } finally { Pop-Location }
}

if ($Acceptance) {
  Write-Output ''
  Write-Output '== Real end-to-end acceptance (launches the Electron shell twice, isolated root) =='
  $node = (Get-Command node).Source
  Push-Location $ROOT
  try {
    & $node "$ROOT\scripts\sub-worker-acceptance.cjs" all
    if ($LASTEXITCODE -ne 0) { $script:failures++ }
  } finally { Pop-Location }
}

if ($script:failures -eq 0) { Write-Output 'VERIFY: ALL CHECKS PASSED' } else { Write-Output "VERIFY: $script:failures check(s) FAILED" }
exit $script:failures
