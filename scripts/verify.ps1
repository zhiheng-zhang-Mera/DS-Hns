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
# ---- HNS unified theme system ----
Check 'Theme engine entry exists' (Test-Path "$ROOT\app\extensions\mega\theme\index.js")
Check 'Theme contract exposes the slot table' ((Get-Content "$ROOT\app\extensions\mega\theme\contract.js" -Raw) -match 'SLOTS')
Check 'Protected system themes are committed' ((Test-Path "$ROOT\app\extensions\mega\theme\builtin\system\dark\manifest.json") -and (Test-Path "$ROOT\app\extensions\mega\theme\builtin\system\light\manifest.json"))
Check 'Built-in demo themes are committed' ((Test-Path "$ROOT\app\extensions\mega\theme\builtin\demo\minimal-neutral\manifest.json") -and (Test-Path "$ROOT\app\extensions\mega\theme\builtin\demo\anime-persona\manifest.json") -and (Test-Path "$ROOT\app\extensions\mega\theme\builtin\demo\cyber-hud\manifest.json"))
Check 'Appearance panel exists in the dock' ((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'id="appearancePanel"')
Check 'Theme panel renderer exists' (Test-Path "$ROOT\app\extensions\mega\ui\theme-panel.js")
Check 'Theme bridge is exposed through the preload' ((Get-Content "$ROOT\app\extensions\mega\ui\preload.cjs" -Raw) -match 'mega:theme-create')
Check 'Theme recovery falls back to Dark' ((Get-Content "$ROOT\app\extensions\mega\theme\recovery.js" -Raw) -match 'RECOVERY|fallbackTheme')
Check 'Theme system never touches the official renderer' (-not ((Get-Content "$ROOT\app\extensions\mega\theme\index.js" -Raw) -match 'officialWebContents|executeJavaScript|insertCSS'))
# ---- four Theme Surfaces (Update-Plan/General-Theme.md) ----
Check 'Surface model exists' (Test-Path "$ROOT\app\extensions\mega\theme\surface.js")
Check 'Surface model declares the four surfaces' (((Get-Content "$ROOT\app\extensions\mega\theme\surface.js" -Raw) -match 'hns_native') -and ((Get-Content "$ROOT\app\extensions\mega\theme\surface.js" -Raw) -match 'official_shell') -and ((Get-Content "$ROOT\app\extensions\mega\theme\surface.js" -Raw) -match 'official_overlay') -and ((Get-Content "$ROOT\app\extensions\mega\theme\surface.js" -Raw) -match 'official_renderer'))
Check 'Surface model gates every write' ((Get-Content "$ROOT\app\extensions\mega\theme\surface.js" -Raw) -match 'function assertWritable')
$officialSurfaces = Get-Content "$ROOT\app\official-surface-views.cjs" -Raw
Check 'Official surface view manager exists' (Test-Path "$ROOT\app\official-surface-views.cjs")
Check 'Official overlay is input-transparent and never focusable' (($officialSurfaces -match 'setIgnoreMouseEvents\(true') -and ($officialSurfaces -match 'focusable: false'))
# The surface manager legitimately styles its OWN two views, so the rule is not
# "no insertCSS": it is that no API is ever aimed at the official renderer, and
# that no script is ever executed anywhere.
Check 'Official surface manager never reaches into, or scripts, the official renderer' ((-not ($officialSurfaces -match 'officialView\.webContents|executeJavaScript')) -and ($officialSurfaces -match 'getBounds'))
Check 'Official shell document exists and carries no script' ((Test-Path "$ROOT\app\extensions\mega\ui\hns-shell.html") -and (-not ((Get-Content "$ROOT\app\extensions\mega\ui\hns-shell.html" -Raw) -match '<script')))
Check 'Official overlay document exists and carries no script' ((Test-Path "$ROOT\app\extensions\mega\ui\official-overlay.html") -and (-not ((Get-Content "$ROOT\app\extensions\mega\ui\official-overlay.html" -Raw) -match '<script')))
Check 'Asset pipeline is split into planner/generator/processor/validator/fallback' ((Test-Path "$ROOT\app\extensions\mega\theme\assets\planner.js") -and (Test-Path "$ROOT\app\extensions\mega\theme\assets\generator.js") -and (Test-Path "$ROOT\app\extensions\mega\theme\assets\processor.js") -and (Test-Path "$ROOT\app\extensions\mega\theme\assets\validator.js") -and (Test-Path "$ROOT\app\extensions\mega\theme\assets\fallback.js"))
Check 'Procedural asset factory is retained as the fallback renderer' (Test-Path "$ROOT\app\extensions\mega\theme\asset-factory.js")
Check 'Overlay layout engine exists' (Test-Path "$ROOT\app\extensions\mega\theme\official\overlay-layout.js")
Check 'Overlay safety validator enforces the engineering ceilings' (((Get-Content "$ROOT\app\extensions\mega\theme\official\overlay-safety.js" -Raw) -match 'overlay_opacity: 0\.22') -and ((Get-Content "$ROOT\app\extensions\mega\theme\official\overlay-safety.js" -Raw) -match 'critical_overlap: 0\.08'))
Check 'Surface subdirectories are covered by the syntax gate' (((Get-Content "$ROOT\scripts\check-syntax.cjs" -Raw) -match 'extensions/mega/theme/assets') -and ((Get-Content "$ROOT\scripts\check-syntax.cjs" -Raw) -match 'extensions/mega/theme/official'))
# ---- HNS skills management ----
Check 'Skill format layer exists' (Test-Path "$ROOT\app\extensions\mega\skills\skill-format.js")
Check 'Skill service exists' (Test-Path "$ROOT\app\extensions\mega\skills\skill-service.js")
Check 'Skills panel exists in the dock' ((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'id="skillsPanel"')
Check 'Skills panel renderer exists' (Test-Path "$ROOT\app\extensions\mega\ui\skills-panel.js")
Check 'Skills bridge is exposed through the preload' ((Get-Content "$ROOT\app\extensions\mega\ui\preload.cjs" -Raw) -match 'mega:skills-install-source')
Check 'Skill install is staged and validated before it lands' ((Get-Content "$ROOT\app\extensions\mega\skills\skill-service.js" -Raw) -match 'stageCandidate')
Check 'Skill deletion is confined to the skill root' ((Get-Content "$ROOT\app\extensions\mega\skills\skill-service.js" -Raw) -match 'target_outside_root|outside_root')
Check 'Skill archive extraction refuses traversal' ((Get-Content "$ROOT\app\extensions\mega\skills\tar.js" -Raw) -match 'safeRelativePath')
Check 'Theme bridge is shared by the dock UI modules' ((Test-Path "$ROOT\app\extensions\mega\ui\theme-bridge.js") -and ((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'theme-bridge\.js'))
# ---- Dock Target Adapter: one interface, two backends ----
$dockTarget = Get-Content "$ROOT\app\extensions\mega\dock\target.js" -Raw
Check 'Dock target adapter exists' (Test-Path "$ROOT\app\extensions\mega\dock\target.js")
Check 'Dock adapter exposes the full target contract' (($dockTarget -match 'getWebContents') -and ($dockTarget -match 'getBounds') -and ($dockTarget -match 'getVisible') -and ($dockTarget -match 'capturePage') -and ($dockTarget -match '\bsend\b') -and ($dockTarget -match 'getState'))
Check 'Dock adapter keeps both backends behind one interface' (($dockTarget -match 'INTEGRATED_MODE') -and ($dockTarget -match 'WINDOW_MODE'))
$megaDockReads = ([regex]::Matches($mega, 'dockWindow\.webContents')).Count + ([regex]::Matches($mega, 'dockWindow\.isVisible')).Count + ([regex]::Matches($mega, 'dockWindow\.getContentSize')).Count
Check 'Theme and dock pushes never read dockWindow directly' ($megaDockReads -eq 0) "($megaDockReads direct read(s))"
Check 'Dock state reports its generation' ($mega -match 'dockTarget\.getState\(')
Check 'Shell hands the extension a dock adapter' (($main -match 'dockAdapter') -and ($main -match 'function createDockAdapter'))
Check 'Shell notifies the extension when the dock renderer is ready' (($main -match 'notifyDockReady') -and ($mega -match 'registerDockReadyHook'))
# ---- updater rollback transaction ----
$runner = Get-Content "$ROOT\app\extensions\mega\updater\update-runner.js" -Raw
$rollbackBody = ($runner -split 'function restorePreviousInstallation')[1]
$rollbackBody = ($rollbackBody -split 'function verifyInstall')[0]
Check 'Upgrade and rollback are separate operations' (($runner -match 'function installTargetVersion') -and ($runner -match 'function restorePreviousInstallation'))
Check 'Rollback reinstalls the lockfile, never the target' (($rollbackBody -match "'ci', '--no-audit', '--no-fund'") -and (-not ($rollbackBody -match 'rt\.target')) -and (-not ($rollbackBody -match 'PACKAGE_NAME\}@')))
Check 'The previous installation is read from disk first' ($runner -match 'installedVersion: readInstalledVersion\(rt\)')
Check 'The three rollback outcomes are distinct' (($runner -match 'failed_rolled_back') -and ($runner -match 'failed_rollback_failed') -and ($runner -match 'SUCCEEDED: .succeeded.'))
Check 'The dock cannot mask a failed rollback' (((Get-Content "$ROOT\app\extensions\mega\ui\dock.js" -Raw) -match 'rollback-failed') -and ((Get-Content "$ROOT\app\extensions\mega\updater\harness-updater.js" -Raw) -match 'rollbackFailed'))

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
Check 'Harness port default is unchanged' (($main -match 'if \(!Number\.isInteger\(parsed\) \|\| parsed < 1024 \|\| parsed > 65535\) return 3080') -and ($main -match "const DSH_LAUNCH_ARGS = \['web', '--no-open'"))
Check 'Real acceptance harness exists' (Test-Path "$ROOT\scripts\sub-worker-acceptance.cjs")
Check 'Sub-worker reference doc exists' (Test-Path "$ROOT\docs\sub-worker.md")

Write-Output ''
Write-Output '== Adaptive multi-process execution (multi-sub.md) =='
foreach ($file in @('yaml.cjs','resource-config.cjs','profiler.cjs','resources.cjs','dag.cjs','ownership.cjs','snapshot.cjs','metrics.cjs','pool.cjs','scheduler.cjs','integration.cjs')) {
  Check "Multi-worker module $file present" (Test-Path "$ROOT\app\sub-worker\$file")
}
$swYaml = Get-Content "$ROOT\app\sub-worker\yaml.cjs" -Raw
$swResCfg = Get-Content "$ROOT\app\sub-worker\resource-config.cjs" -Raw
$swProfiler = Get-Content "$ROOT\app\sub-worker\profiler.cjs" -Raw
$swResources = Get-Content "$ROOT\app\sub-worker\resources.cjs" -Raw
$swPool = Get-Content "$ROOT\app\sub-worker\pool.cjs" -Raw
$swSched = Get-Content "$ROOT\app\sub-worker\scheduler.cjs" -Raw
$swDag = Get-Content "$ROOT\app\sub-worker\dag.cjs" -Raw
$swOwn = Get-Content "$ROOT\app\sub-worker\ownership.cjs" -Raw
$swIntegr = Get-Content "$ROOT\app\sub-worker\integration.cjs" -Raw
$swMetrics = Get-Content "$ROOT\app\sub-worker\metrics.cjs" -Raw
$swCfgFile = Test-Path "$ROOT\config\hns-resource.yaml"
Check 'Adaptive mode is off by default' ($appConfig -match '"adaptiveWorkers":\s*false')
Check 'The resource configuration file is shipped' ($swCfgFile)
Check 'A dependency-free YAML subset reader exists' (($swYaml -match 'function parseYaml') -and ($swYaml -match 'anchors and aliases are not supported'))
Check 'Installation tiers are documented' (($swResCfg -match 'INSTALLATION_TIERS') -and ($swResCfg -match "workstation") -and ($swResCfg -match 'maxRecommendedWorkers'))
Check 'The hardware profiler degrades gracefully' (($swProfiler -match 'degraded') -and ($swProfiler -match 'classifyStorageFromLatency') -and ($swProfiler -match 'usable_ram_gb'))
Check 'Storage is never misread as a rotating disk' ($swProfiler -match 'does not imply a rotating disk')
Check 'The resource scheduler composes limits with min' (($swResources -match 'function limitSet') -and ($swResources -match 'binding'))
Check 'All five performance states exist' (($swResources -match "PERFORMANCE_STATES") -and ($swResources -match 'SAFE_MODE') -and ($swResources -match 'THROTTLED'))
Check 'Scale-up and scale-down are hysteretic' (($swResources -match 'scaleUpAllowed') -and ($swResources -match 'scaleDownAllowed') -and ($swResources -match 'idleSurplusSince'))
Check 'The pool is persistent with heartbeat telemetry' (($swPool -match 'class WorkerPool') -and ($swPool -match 'noteTelemetry') -and ($swPool -match 'task is being reused|reused'))
Check 'Hang detection needs several signals' (($swPool -match 'STALLED') -and ($swPool -match 'no output for') -and ($swPool -match 'no CPU progress'))
Check 'The DAG validates cycles and scores critical paths' (($swDag -match 'findCycle') -and ($swDag -match 'critical_path_score') -and ($swDag -match 'dependent_count'))
Check 'File conflict control and ownership exist' (($swOwn -match 'filterConflicts') -and ($swOwn -match 'class FileOwnershipRegistry') -and ($swOwn -match 'scopesOverlap'))
Check 'Merge conflicts are reported, never guessed' ($swOwn -match 'both .* and .* changed this file')
Check 'Per-node worktrees and integration exist' (($swIntegr -match 'integrationWorktreePath') -and ($swIntegr -match 'mergeContributions'))
Check 'Speculative execution is gated by state and flag' (($swSched -match 'selectSpeculative') -and ($swSched -match "NORMAL', 'BOOST'"))
Check 'Metrics include throughput and parallel efficiency' (($swMetrics -match 'effectiveThroughput') -and ($swMetrics -match 'parallelEfficiency') -and ($swMetrics -match 'EWMA_ALPHA'))
Check 'Learned profiles are clamped to a documented band' (($swResCfg -match 'LEARNED_RAM_BAND') -and ($swResCfg -match 'LEARNED_MIN_SAMPLES'))
Check 'The supervisor recovers a parked pool' ($swManager -match 'pool recovery')
Check 'The panel exposes the pool, resources and DAG' (($swUi -match 'id="swPool"') -and ($swUi -match 'id="swResources"') -and ($swUi -match 'id="swDag"') -and ($swUi -match 'id="swAdaptive"'))
Check 'Multi-worker reference doc exists' (Test-Path "$ROOT\docs\multi-worker.md")

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
