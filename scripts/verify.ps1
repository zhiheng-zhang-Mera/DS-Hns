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
# The official view's own body only: the Daily/native renderer further down the
# file legitimately has a preload of its own, so the slice must stop at the next
# function rather than at an unrelated marker much later in the file.
$officialView = ($officialView -split 'function officialLivesInWindow')[0]
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
Check 'Appearance panel renderer exists' (Test-Path "$ROOT\app\extensions\mega\ui\appearance-panel.js")
# The dock is frosted glass and is never skinned: the theme bridge and the theme panel are gone,
# and the dock's own script set contains no writer of theme values.
Check 'The dock no longer loads a theme bridge' (-not ((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'theme-bridge\.js|theme-panel\.js'))
Check 'The dock theme writers are removed' ((-not (Test-Path "$ROOT\app\extensions\mega\ui\theme-bridge.js")) -and (-not (Test-Path "$ROOT\app\extensions\mega\ui\theme-panel.js")))
Check 'The frosted-glass layer drives the window' ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match 'dockGlassBackground\(\)')
Check 'The shell never pushes a theme payload to the dock' (-not ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match "dockTarget\.send\('mega:theme-apply'"))
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
# ---- the wallpaper layer: a click-through window, never a view ----
# A view above the official page is a real hit target in this Electron build (`View` has no input
# API at all), which is how the official UI became unclickable while a wallpaper was set. The
# wallpaper is therefore a window, it must be mouse-transparent, and it must refuse to appear when
# that cannot be arranged.
$wallpaperWindow = Get-Content "$ROOT\app\wallpaper-window.cjs" -Raw -ErrorAction SilentlyContinue
Check 'Wallpaper layer is a window with an input API' (($wallpaperWindow -match 'setIgnoreMouseEvents\(value, \{ forward: false \}\)') -and ($wallpaperWindow -match 'focusable: false'))
Check 'Wallpaper layer refuses to show itself when it cannot be made click-through' ($wallpaperWindow -match 'if \(!mouseTransparent\)')
Check 'Wallpaper window document exists and carries no script' ((Test-Path "$ROOT\app\extensions\mega\ui\wallpaper-window.html") -and (-not ((Get-Content "$ROOT\app\extensions\mega\ui\wallpaper-window.html" -Raw) -match '<script')))
Check 'The shell never stacks a view over the official page for the wallpaper' (((Get-Content "$ROOT\app\desktop-main.cjs" -Raw) -match 'return createWallpaperLayer\(\)') -and (-not ((Get-Content "$ROOT\app\desktop-main.cjs" -Raw) -match 'wallpaperOnly|paintWallpaper')))
Check 'Wallpaper hit-test acceptance exists and drives the OS hit test' ((Test-Path "$ROOT\scripts\wallpaper-hit-test.cjs") -and (Test-Path "$ROOT\scripts\hit-test-window.ps1") -and ((Get-Content "$ROOT\scripts\wallpaper-hit-test.cjs" -Raw) -match 'WindowFromPoint'))
Check 'Wallpaper render acceptance exists and reads back the computed cut' ((Test-Path "$ROOT\scripts\wallpaper-render-acceptance.cjs") -and ((Get-Content "$ROOT\scripts\wallpaper-render-acceptance.cjs" -Raw) -match 'capturePage'))
# ---- startup: usable first, enhanced behind it (updateplan/startup.md) ----
$startupModule = Get-Content "$ROOT\app\startup.cjs" -Raw -ErrorAction SilentlyContinue
$desktopMain = Get-Content "$ROOT\app\desktop-main.cjs" -Raw
Check 'Startup state machine exists with the four states' (($startupModule -match 'BOOTING') -and ($startupModule -match 'CORE_READY') -and ($startupModule -match 'INTERACTIVE') -and ($startupModule -match 'ENHANCED'))
Check 'Startup reports every phase in one log shape' (($startupModule -match "\[BOOT\]") -and ($startupModule -match 'overBudget'))
Check 'Deferred work cannot fail or delay the boot' (($startupModule -match 'function defer') -and ($startupModule -match 'the boot carries on'))
Check 'The window is on screen with a skeleton before the Harness is asked anything' (($desktopMain.IndexOf('await showStartupSkeleton()') -ge 0) -and ($desktopMain.IndexOf('await showStartupSkeleton()') -lt $desktopMain.IndexOf('const readyUrl = await waitForHarness()')))
Check 'INTERACTIVE is declared before every optional layer' (($desktopMain.IndexOf("startup.mark('interactive')") -ge 0) -and ($desktopMain.IndexOf("startup.mark('interactive')") -lt $desktopMain.IndexOf("startup.defer('extensions-ready'")) -and ($desktopMain.IndexOf("startup.mark('interactive')") -lt $desktopMain.IndexOf("startup.defer('dock-ready'")))
Check 'Startup skeleton exists and carries no script' ((Test-Path "$ROOT\app\splash.html") -and (-not ((Get-Content "$ROOT\app\splash.html" -Raw) -match '<script')))
# ---- The Harness profile's copy of the plugin DS-Hns ships (app\harness-profile.cjs) ----
# The profile holds a plain *copy* of `app\plugins\mega-core` (pnpm materialises a `file:` dependency),
# and the round that synced it by hand carried the package manifest into `lib/` along with the two halves.
# The Harness resolves a client plugin's bundle through the nearest manifest that names the package, so
# that file made it look for `lib\lib\client.js`: the plugin tree failed to compose and the launch ended
# before the official UI existed. The launch now refreshes the copy from the shipped package first.
Check 'The shipped plugin keeps its manifest at the root' (-not (Test-Path "$ROOT\app\plugins\mega-core\lib\package.json"))
Check 'The launch refreshes the profile copy of the shipped plugin' ((Test-Path "$ROOT\app\harness-profile.cjs") -and ($desktopMain -match 'syncShippedPackage') -and ($desktopMain.IndexOf('syncHarnessProfilePlugin()') -lt $desktopMain.IndexOf("logLine('--- DSH launch begin ---')")))
$profileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
$profilePlugin = "$ROOT\data\profiles\$profileName\node_modules\dsh-plugin-mega-core"
Check 'The installed profile copy carries no manifest below its root' ((-not (Test-Path $profilePlugin)) -or (-not (Test-Path "$profilePlugin\lib\package.json")))
Check 'Startup failures carry the Harness own last words' (($desktopMain -match 'function harnessOutputTail') -and ($desktopMain -match 'Harness output \(tail\)'))
# ---- MEGA Protection Layer: the enhancement layer fails safely (startup2.md section 12-section 18) ----
$protection = Get-Content "$ROOT\app\extensions\mega\protection\index.cjs" -Raw -ErrorAction SilentlyContinue
Check 'MEGA Protection Layer exists with the six module states' (($protection -match 'DISABLED') -and ($protection -match 'STARTING') -and ($protection -match 'HEALTHY') -and ($protection -match 'DEGRADED') -and ($protection -match 'FAILED') -and ($protection -match 'RECOVERING'))
Check 'Protected modules are started with a budget, a fallback ladder and a bounded retry' (($protection -match 'function register') -and ($protection -match 'function withTimeout') -and ($protection -match 'runFallback') -and ($protection -match 'for \(const delay of \[0, retryDelayMs\]\)'))
Check 'The protection layer reports what the MEGA panel shows' (($protection -match 'lastError') -and ($protection -match 'startMs') -and ($protection -match 'fallbackState') -and ($protection -match 'retries'))
# ---- Bundled community plugins (startup2.md section 19-section 23) ----
$bundled = Get-Content "$ROOT\app\extensions\mega\plugins\index.cjs" -Raw -ErrorAction SilentlyContinue
Check 'Bundled Plugin Manager exists with both bundled plugins' (($bundled -match 'dsh-wallpaper-engine') -and ($bundled -match '@dsh-market/plugin'))
Check 'Bundled references are pinned, and nothing chases latest' (($bundled -match "ref: '") -and (-not ($bundled -match "ref:\s*'latest'")))
# The rule is asserted against the *code*, not against the shipped flag: the two bundled pins were flipped to
# `tested: true` when the manual UI review passed them (pluginize Phase 7), and the next plugin anyone adds
# arrives untested. `entry.tested !== true` is what still refuses it.
Check 'An untested pin is never installed' (($bundled -match 'UNTESTED') -and ($bundled -match 'entry\.tested !== true'))
Check 'Both bundled pins are marked tested, and the review that earned it is recorded' ((([regex]::Matches($bundled, 'tested: true')).Count -ge 2) -and ($bundled -match 'manual UI review'))
Check 'The user''s decision and unknown versions are respected, not overwritten' (($bundled -match 'USER_DISABLED') -and ($bundled -match 'AHEAD_OF_PIN'))
Check 'Bundled plugins are registered as protected modules' (($bundled -match 'registerProtected') -and ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match 'bundled\(\)\.registerProtected\(\)'))
Check 'The bundled set belongs to MEGA, and its policy pass is not on the boot path' (((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match "ipcMain\.handle\('mega:bundled-plugins'") -and ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match '\.then\(\(\) => bundled\(\)\.ensure\(\)\)'))
# ---- MEGA rail: registry-driven, deduplicated, budgeted (startup2.md section 36-44) ----
$megaItems = Get-Content "$ROOT\app\extensions\mega\mega-items.cjs" -Raw -ErrorAction SilentlyContinue
$dockHtml = Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw
$dockJs = Get-Content "$ROOT\app\extensions\mega\ui\dock.js" -Raw
Check 'MegaItemRegistry exists with a budget' (($megaItems -match 'function createMegaItems') -and ($megaItems -match 'MEGA_ITEM_BUDGET = 5') -and ($megaItems -match 'overflow'))
Check 'Zero is not news: a quiet item is not rendered' (($megaItems -match 'if \(item\.quiet\) continue') -and ($megaItems -match 'quiet'))
Check 'The rail is a container fed by the registry, not fixed boxes' ((($dockHtml -match 'id="railItems"') -and ($dockHtml -match 'id="railItemTemplate"')) -and (-not ($dockHtml -match 'id="railRunning"')))
Check 'The dock renders the rail and knows nothing about what the items mean' (($dockJs -match 'function renderRail') -and ($dockJs -match 'snapshot\.megaItems'))
Check 'The rail no longer duplicates the sub-worker state or the price window' ((-not ($dockHtml -match 'railSubWorker')) -and (-not ($dockHtml -match 'railPeak')))
# ---- Appearance controller and readability presets (startup2.md section 26-28) ----
$appearance = Get-Content "$ROOT\app\extensions\mega\appearance\index.cjs" -Raw -ErrorAction SilentlyContinue
Check 'Appearance controller ships the three readability presets' (($appearance -match "'work'") -and ($appearance -match "'immersive'") -and ($appearance -match "'reading'"))
Check 'Readability comes first: every preset is complete without a wallpaper' (($appearance -match 'works with \*no\*') -and ($appearance -match 'scrim'))
Check 'One layer failing does not take the other with it' (($appearance -match 'the glass layer refused') -and ($appearance -match 'the wallpaper refused'))
Check 'The presets are wired to both layers and to the panel' (((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match "ipcMain\.handle\('mega:appearance'") -and ((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'id="appearancePreset"'))
# ---- MEGA Control Center and Protection panel (startup2.md section 45-47) ----
$control = Get-Content "$ROOT\app\extensions\mega\control-center.cjs" -Raw -ErrorAction SilentlyContinue
Check 'Control Center builds the six sections from the dock snapshot' ((($control -match "'execution'") -and ($control -match "'automation'") -and ($control -match "'resources'") -and ($control -match "'extensions'") -and ($control -match "'protection'") -and ($control -match "'diagnostics'")))
Check 'Control Center actions come from the module state' (($control -match 'function moduleActions') -and ($control -match 'function pluginActions'))
Check 'The protection panel and the repair entry points exist in the dock' (((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'id="controlModules"') -and ((Get-Content "$ROOT\app\extensions\mega\ui\control-panel.js" -Raw) -match 'data-control-action'))
Check 'Control Center channels are wired end to end' (((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match "ipcMain\.handle\('mega:control-action'") -and ((Get-Content "$ROOT\app\extensions\mega\ui\preload.cjs" -Raw) -match 'control: \{'))
# ---- Startup cache (startup2.md section 52-54) ----
$cache = Get-Content "$ROOT\app\extensions\mega\startup-cache.cjs" -Raw -ErrorAction SilentlyContinue
Check 'Startup cache exists and forgets' (($cache -match 'function createStartupCache') -and ($cache -match 'maxAgeMs') -and ($cache -match 'function warm'))
Check 'An unreadable cache is an empty cache, and a write is never fatal' (($cache -match 'this is a cold start') -and ($cache -match 'the run continues'))
Check 'The cache records what the owners said, and does not keep the Harness sessions' (((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match 'function rememberStartup') -and ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match 'is deliberately not written'))
# ---- Appearance providers and the missing-plugin path (startup2.md section 43-44) ----
$providers = Get-Content "$ROOT\app\extensions\mega\appearance\providers.cjs" -Raw -ErrorAction SilentlyContinue
Check 'The three appearance providers exist' ((($providers -match "'official'") -and ($providers -match "'simple'") -and ($providers -match "'community'")))
Check 'The community provider is never installed automatically' (($providers -match 'installsAutomatically') -and ($providers -match 'dsh-wallpaper-engine'))
Check 'A refusal keeps the user and names the fallback' (($providers -match 'kept: current') -and ($providers -match 'fallback: provider.fallback'))
Check 'The provider choice is persisted like every other preference' (((Get-Content "$ROOT\app\extensions\mega\appearance\state.cjs" -Raw) -match 'APPEARANCE_STATE_DEFAULT') -and ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match 'appearancePreference\(\)\.set'))
Check 'The settings page offers the mode and the way to the plugin' (((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'id="appearanceProvider"') -and ((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'id="appearanceOpenStore"'))
# ---- Appearance token boundary (startup2.md section 27) ----
$tokens = Get-Content "$ROOT\app\extensions\mega\appearance\tokens.cjs" -Raw -ErrorAction SilentlyContinue
Check 'The appearance vocabulary is the seven tokens the plan names' (($tokens -match '--dsh-surface-opacity') -and ($tokens -match '--dsh-surface-blur') -and ($tokens -match '--dsh-surface-tint') -and ($tokens -match '--dsh-wallpaper-brightness') -and ($tokens -match '--dsh-wallpaper-contrast') -and ($tokens -match '--dsh-wallpaper-saturation') -and ($tokens -match '--dsh-wallpaper-darken'))
Check 'A provider may paint, not take over' (($tokens -match 'FORBIDDEN_SURFACES') -and ($tokens -match 'may paint, not take over'))
Check 'The picture filter is the same numbers under both names' (((Get-Content "$ROOT\app\extensions\mega\wallpaper.cjs" -Raw) -match '--dsh-wallpaper-brightness') -and ((Get-Content "$ROOT\app\extensions\mega\ui\wallpaper-window.html" -Raw) -match 'brightness\(var\(--dsh-wallpaper-brightness'))
# ---- Appearance cost and the MEGA log vocabulary (startup2.md section 55-57) ----
$cost = Get-Content "$ROOT\app\extensions\mega\appearance\cost.cjs" -Raw -ErrorAction SilentlyContinue
Check 'The appearance cost ledger measures without limiting' (($cost -match 'function estimateAppearanceCost') -and ($cost -match 'never clamped|does \*\*not\*\* take the user') -and ($cost -match '\[PERF\]'))
Check 'The layers report the bytes they carry' ((((Get-Content "$ROOT\app\extensions\mega\wallpaper.cjs" -Raw).Split('bytes: inlined.dataUrl')).Length - 1) -ge 2)
Check 'The log vocabulary is the one the plan greps for' (((Get-Content "$ROOT\app\extensions\mega\protection\index.cjs" -Raw) -match '\[MEGA\] protection-ready') -and ((Get-Content "$ROOT\app\extensions\mega\protection\index.cjs" -Raw) -match '\[MEGA\] fallback:') -and ((Get-Content "$ROOT\app\extensions\mega\protection\index.cjs" -Raw) -match '\[MEGA\] module '))
Check 'The Control Center shows the appearance cost' ((Get-Content "$ROOT\app\extensions\mega\control-center.cjs" -Raw) -match 'Cost warnings')
# ---- Store revisions: a pin that is a commit (startup2.md section 22-23) ----
$store = Get-Content "$ROOT\app\extensions\mega\store\installer.cjs" -Raw -ErrorAction SilentlyContinue
Check 'The store can stage a pinned revision' (($store -match 'options\.revision') -and ($store -match "fetch', '--depth', '1'") -and ($store -match 'FETCH_HEAD'))
Check 'A revision is validated, recorded and never combined with a branch' (($store -match 'is not a commit revision') -and ($store -match 'not both') -and ($store -match 'revision: revision \|\| null'))
Check 'The bundled manager uses the revision path for a commit pin' ((Get-Content "$ROOT\app\extensions\mega\plugins\index.cjs" -Raw) -match 'store\.stage\(\{ source: entry\.repo, revision: entry\.ref \}\)')
# ---- Appearance cost acceptance (startup2.md section 56) ----
$costAcceptance = Get-Content "$ROOT\scripts\appearance-cost-acceptance.cjs" -Raw -ErrorAction SilentlyContinue
Check 'Appearance cost acceptance exists and measures the real layers' (($costAcceptance -match 'getAppMetrics') -and ($costAcceptance -match 'createWallpaperWindow'))
Check 'A case that cannot be measured is skipped with a reason, never guessed' (($costAcceptance -match 'skipped:') -and ($costAcceptance -match 'the community plugin renders'))
# ---- Surface ownership (startup2.md section 48, section 55's CSS ownership) ----
Check 'Every dock channel has an owner that declares it' (Test-Path "$ROOT\tests\unit\surface-ownership.test.js")
Check 'The token vocabulary stays inside the appearance boundary' (-not ((Get-Content "$ROOT\app\extensions\mega\ui\dock.css" -Raw) -match '--dsh-'))
Check 'One stylesheet, one document' ((-not ((Get-Content "$ROOT\app\extensions\mega\ui\dock.css" -Raw) -match '#wallpaper-scrim')) -and (-not ((Get-Content "$ROOT\app\extensions\mega\ui\wallpaper-window.html" -Raw) -match '#rail|#detail')))
# ---- Bundled channels: each entry names the channel it can be installed through (startup2.md section 19-23) ----
$bundledPlugins = Get-Content "$ROOT\app\extensions\mega\plugins\index.cjs" -Raw -ErrorAction SilentlyContinue
Check 'The bundled manifest names a channel per entry' (($bundledPlugins -match "channel: 'harness-profile'") -and ($bundledPlugins -match 'BUNDLED_CHANNELS'))
Check 'A Harness client plugin is installed by the Harness own CLI' (((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match "plugin', '--profile', profile, 'add'") -and ($bundledPlugins -match 'dsh-plugin-wallpaper-engine'))
Check 'An entry without a channel is reported, never installed' (($bundledPlugins -match 'BUNDLED_STATE.UNRESOLVED') -and ($bundledPlugins -match "action: 'report'"))
Check 'Removal and compatibility follow the same channel as installation' (($bundledPlugins -match 'async function removeBundled') -and ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match "checked: 'harness'") -and ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match "harnessRemove:"))
Check 'The channel is recorded as verified, and the runtime only after it was run' (($bundledPlugins -match 'channelVerified: true') -and ($bundledPlugins -match 'tested: true') -and ($bundledPlugins -match 'channelVerified: entry.channelVerified === true') -and ($bundledPlugins -match 'tested: entry\.tested === true'))
# ---- The optional community plugins at install time (branch better-install) ----
# Two plugins DS-Hns offers and does not depend on. The installer asks about each one separately, and
# every question has a parameter that answers it without asking -- so the checks below are about the
# surface a person chooses through, and about the two rules that keep an optional plugin optional.
$communityCli = Get-Content "$ROOT\app\extensions\mega\plugins\community-install-cli.cjs" -Raw -ErrorAction SilentlyContinue
$communityModule = Get-Content "$ROOT\app\extensions\mega\plugins\community-install.cjs" -Raw -ErrorAction SilentlyContinue
$installerScript = Get-Content "$ROOT\scripts\install.ps1" -Raw -ErrorAction SilentlyContinue
$communityScript = Get-Content "$ROOT\scripts\install-community-plugins.ps1" -Raw -ErrorAction SilentlyContinue
Check 'The community plugin installer exists, and reuses the release manifest rather than a second list' ($communityCli -and $communityModule -and ($communityModule -match 'require\(''\./index\.cjs''\)') -and ($communityModule -match 'installBundled\('))
Check 'Nothing optional is installed by a default nobody chose' (($communityModule -match 'unanswered') -and ($communityCli -match 'not selected; optional community plugins are skipped unless they are asked for'))
Check 'The installer accepts the parameters the requirement names' (($installerScript -match '\-InstallMarket') -and ($installerScript -match '\-InstallWallpaper') -and ($installerScript -match '\-SkipOptionalPlugins') -and ($installerScript -match '\-NonInteractive'))
Check 'A contradictory invocation is an error with a reason, never a silent override' (($communityModule -match 'COMMUNITY_CONFLICTING_PARAMETERS') -and ($installerScript -match 'cannot be combined with'))
Check 'Each plugin is asked about separately, in both languages' (((Get-Content "$ROOT\app\extensions\mega\plugins\community-labels.json" -Raw) -match 'Plugin Market') -and ((Get-Content "$ROOT\app\extensions\mega\plugins\community-labels.json" -Raw) -match 'Wallpaper Engine') -and ($communityCli -match 'askSelected'))
Check 'The installer never clones a plugin into place' ((-not ($installerScript -match 'git clone')) -and (-not ($communityScript -match 'git clone')))
Check 'The installer reports what happened rather than what it intended' (($installerScript -match 'Installation summary') -and ($installerScript -match 'Plugin Market') -and ($installerScript -match 'Wallpaper Engine') -and ($installerScript -match 'Adapter registry'))
Check 'A failed community plugin warns and lets the installation succeed' (($installerScript -match 'This plugin is optional; DS-Harness itself is installed and usable without it') -and ($installerScript -match 'Write-Warning'))
Check 'The Harness-profile channel has its own adapter, registered on the framework' (((Get-Content "$ROOT\app\core\plugin-adapters\adapters\harness-profile.cjs" -Raw) -match "id: 'dshns\.harness-profile'") -and ((Get-Content "$ROOT\app\plugin-host.cjs" -Raw) -match 'createHarnessProfileAdapter'))
Check 'A profile plugin is verified from its own declarations, never run by this host' (((Get-Content "$ROOT\app\core\plugin-adapters\adapters\harness-profile.cjs" -Raw) -match 'loaded: false') -and ((Get-Content "$ROOT\app\core\plugin-adapters\adapters\harness-profile.cjs" -Raw) -match 'never run by this host'))
# ---- The two built-in long-hosting plugins (branch target-standby) ----
# The health scheduler decides; the restart supervisor executes. The checks below are about the line
# between them, about the two plugins being part of the shipped set, and about the installer carrying
# them -- which is the half of the requirement a source scan is the only way to assert.
$healthIndex = Get-Content "$ROOT\app\plugins\health-scheduler\index.cjs" -Raw -ErrorAction SilentlyContinue
$healthEngine = Get-Content "$ROOT\app\plugins\health-scheduler\health.cjs" -Raw -ErrorAction SilentlyContinue
$healthProviders = Get-Content "$ROOT\app\plugins\health-scheduler\providers.cjs" -Raw -ErrorAction SilentlyContinue
$healthSeverity = Get-Content "$ROOT\app\plugins\health-scheduler\severity.cjs" -Raw -ErrorAction SilentlyContinue
$supervisorIndex = Get-Content "$ROOT\app\plugins\restart-supervisor\index.cjs" -Raw -ErrorAction SilentlyContinue
$supervisorPolicy = Get-Content "$ROOT\app\plugins\restart-supervisor\policy.cjs" -Raw -ErrorAction SilentlyContinue
$supervisorBudget = Get-Content "$ROOT\app\plugins\restart-supervisor\budget.cjs" -Raw -ErrorAction SilentlyContinue
$supervisorHeartbeat = Get-Content "$ROOT\app\plugins\restart-supervisor\heartbeat.cjs" -Raw -ErrorAction SilentlyContinue
$supervisorLifecycle = Get-Content "$ROOT\app\plugins\restart-supervisor\lifecycle.cjs" -Raw -ErrorAction SilentlyContinue
$supervisorCompanion = Get-Content "$ROOT\app\plugins\restart-supervisor\companion.cjs" -Raw -ErrorAction SilentlyContinue
$supervisorMain = Get-Content "$ROOT\app\plugins\restart-supervisor\companion\main.cjs" -Raw -ErrorAction SilentlyContinue
$mountedIndex = Get-Content "$ROOT\app\plugins\mounted\index.cjs" -Raw -ErrorAction SilentlyContinue
$bundledList = Get-Content "$ROOT\scripts\bundled-plugins.json" -Raw -ErrorAction SilentlyContinue
$bundledInstaller = Get-Content "$ROOT\scripts\install-bundled-plugins.ps1" -Raw -ErrorAction SilentlyContinue
$uninstaller = Get-Content "$ROOT\scripts\uninstall-ds-harness.ps1" -Raw -ErrorAction SilentlyContinue
$hostSource = Get-Content "$ROOT\app\plugin-host.cjs" -Raw -ErrorAction SilentlyContinue
$soakHarness = Get-Content "$ROOT\scripts\longhost-soak.cjs" -Raw -ErrorAction SilentlyContinue
$chaosHarness = Get-Content "$ROOT\scripts\longhost-chaos.cjs" -Raw -ErrorAction SilentlyContinue
$registrationProbe = Get-Content "$ROOT\scripts\plugin-registration-check.cjs" -Raw -ErrorAction SilentlyContinue
$supervisorDocs = Get-Content "$ROOT\docs\restart-supervisor.md" -Raw -ErrorAction SilentlyContinue

Check 'Both built-in plugins are part of the shipped set, mounted through the one adapter' (($mountedIndex -match 'healthSchedulerPlugin\(\)') -and ($mountedIndex -match 'restartSupervisorPlugin\('))
Check 'The health scheduler cannot stop anything, and the supervisor has no health policy' (
  (-not ($healthIndex -match 'taskkill|process\.kill|node:child_process|SIGTERM|SIGKILL|shutdown|reboot')) -and
  (-not ($healthEngine -match 'taskkill|process\.kill|node:child_process|SIGKILL')) -and
  (-not ($healthProviders -match 'taskkill|process\.kill|node:child_process|SIGKILL')) -and
  (-not ($healthSeverity -match 'taskkill|process\.kill|node:child_process|SIGKILL')) -and
  (-not ($supervisorIndex -match "'health-pressure'|'hardware-health'|os\.cpus|os\.freemem|health-scheduler")) -and
  (-not ($supervisorBudget -match "'health-pressure'|os\.cpus|health-scheduler"))
)
Check 'The monitor reaches the authority only through the capability registry' (($healthIndex -match "context\.require\('restart-control', \{ optional: true \}\)") -and (-not ($healthIndex -match 'require\(.*restart-supervisor')))
Check 'The supervisor provides exactly restart-control, and needs nothing to provide it' (($supervisorIndex -match "PROVIDES = Object\.freeze\(\[RESTART_CONTROL_CAPABILITY\]\)") -and ($supervisorIndex -match 'requires_capabilities: \[\]'))
Check 'The capability vocabulary names the supervisor as the restart authority' ((Get-Content "$ROOT\app\core\contracts\capability.cjs" -Raw) -match "providers: \['dshns\.restart-supervisor'\]")
Check 'The restart budget, the backoff and the crash-loop ladder are all present and bounded' (($supervisorPolicy -match 'maxRestarts') -and ($supervisorPolicy -match 'backoffMaxMs') -and ($supervisorPolicy -match 'safeModeAt') -and ($supervisorBudget -match 'REFUSAL_CODES\.BUDGET_EXHAUSTED') -and ($supervisorBudget -match 'SUPERVISOR_HEALTH\.SAFE_MODE'))
Check 'Safe mode refuses every automatic restart and offers a human reset' (($supervisorBudget -match 'REFUSAL_CODES\.SAFE_MODE') -and ($supervisorIndex -match 'resetRestartBudget') -and ($supervisorIndex -match 'manualRestart'))
Check 'The heartbeat keeps process liveness and runtime responsiveness on separate clocks' (($supervisorHeartbeat -match 'livenessTimeoutMs') -and ($supervisorHeartbeat -match 'forced-restart') -and ($supervisorHeartbeat -match 'graceful-recovery') -and ($supervisorPolicy -match 'livenessTimeoutMs'))
Check 'The lifecycle is ordered, bounded and leaves resuming to Core continuity' (($supervisorLifecycle -match 'beforeRestart') -and ($supervisorLifecycle -match 'pendingWork') -and ($supervisorLifecycle -match 'afterRestart') -and ($supervisorLifecycle -match 'readinessAttempts') -and ($supervisorLifecycle -match 'does not implement task recovery'))
Check 'Readiness retries a gate that is not up yet, and only a required gate fails the boot' (($supervisorLifecycle -match 'requiredGates') -and ($supervisorLifecycle -match 'timedOut'))
Check 'The out-of-process companion exists and refuses to run twice' (($supervisorCompanion -match 'function claimRestartLock') -and ($supervisorCompanion -match 'restartLockHeldByOther') -and ($supervisorMain -match 'companion\.claim\(\)') -and ($supervisorMain -match 'companion\.release\(\)'))
Check 'The companion is registered nowhere as a startup entry' (($bundledList -match '"startupRegistration": "none"') -and (-not ($bundledInstaller -match 'Run\\')))
Check 'Both plugins are in the installer list as required built-ins' (($bundledList -match 'dshns\.health-scheduler') -and ($bundledList -match 'dshns\.restart-supervisor') -and ($bundledList -match '"required": true'))
Check 'The installer installs the built-ins in their own step, before the optional plugins' (($installerScript -match 'install-bundled-plugins\.ps1') -and $installerScript.IndexOf('Sign the shipped plugins into the Harness profile') -lt $installerScript.IndexOf('Optional community plugins'))
Check 'The uninstaller removes the companion and scans for orphans' (($uninstaller -match 'companion stopped') -and ($uninstaller -match 'no orphan companion process') -and ($uninstaller -match 'no supervisor startup entry'))
Check 'The plugin host reports both services, and the panel has an action for each' (($hostSource -match 'function serviceRecordOf') -and ($hostSource -match 'serviceReports') -and ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match 'SERVICE_ACTIONS'))
Check 'Mega owns the advanced configuration, validated by the host that writes it' (($hostSource -match 'ADVANCED_SCHEMA') -and ($hostSource -match 'function setPath') -and ((Get-Content "$ROOT\app\extensions\mega\control-center.cjs" -Raw) -match 'advanced'))
Check 'The synthetic 6/12/24-hour soak harness exists with a real-machine entry point' (($soakHarness -match 'soak-6h') -and ($soakHarness -match 'soak-12h') -and ($soakHarness -match 'soak-24h') -and ($soakHarness -match '--realtime'))
Check 'The long-hosting chaos harness injects the failures the requirement names' (($chaosHarness -match 'kill-core') -and ($chaosHarness -match 'controlled-restart') -and ($chaosHarness -match 'plugin-crash') -and ($chaosHarness -match 'plugin-timeout') -and ($chaosHarness -match 'network-failure') -and ($chaosHarness -match 'host-restart') -and ($chaosHarness -match 'git-interruption') -and ($chaosHarness -match 'false-success'))
Check 'The chaos harness drives the real companion and records the reboot it did not run' (($chaosHarness -match "companion', 'main\.cjs'") -and ($chaosHarness -match 'NOT exercised'))
Check 'The installer verifies registration, not only the files it wrote' (($registrationProbe -match 'plugin-registration-check') -and ($registrationProbe -match 'duplicateRegistrations') -and ((Get-Content "$ROOT\scripts\install.ps1" -Raw) -match 'plugin-registration-check\.cjs'))
$acceptanceDir = Join-Path $ROOT 'docs\acceptance'
$acceptanceFiles = @('architecture-before.json', 'architecture-after.json', 'cleanup-candidates.json', 'cleanup-review-needed.json', 'dead-code-report.json', 'ui-surface-report.json', 'restart-recovery-report.json', 'longhost-chaos-report.json', 'longhost-soak-report.json', 'installer-registration-report.json', 'LONGHOST-ACCEPTANCE.json', 'LONGHOST-ACCEPTANCE.md')
$missingAcceptance = @($acceptanceFiles | Where-Object { -not (Test-Path (Join-Path $acceptanceDir $_)) })
Check 'The long-hosting acceptance record ships, every document the requirement names' ($missingAcceptance.Count -eq 0)
$acceptanceJson = Get-Content (Join-Path $acceptanceDir 'LONGHOST-ACCEPTANCE.json') -Raw -ErrorAction SilentlyContinue
Check 'The acceptance record states the metrics the requirement asks for' (($acceptanceJson -match 'lostTasks') -and ($acceptanceJson -match 'falseSuccess') -and ($acceptanceJson -match 'infiniteRestartLoops') -and ($acceptanceJson -match 'duplicatePluginRegistrations') -and ($acceptanceJson -match 'unexpectedDeletedFeatures'))
Check 'The acceptance record names what was not exercised rather than claiming it' (($acceptanceJson -match 'notExercised') -and ($acceptanceJson -match 'real Windows reboot'))
Check 'The acceptance record is generated from the harness reports, not written by hand' ((Get-Content "$ROOT\scripts\longhost-acceptance.cjs" -Raw) -match 'longhost-chaos-report\.json')
Check 'The restart status is a formal, persisted record with the three recovery claims' (((Get-Content "$ROOT\app\plugins\restart-supervisor\status.cjs" -Raw) -match 'restart_status\.json') -and ((Get-Content "$ROOT\app\plugins\restart-supervisor\status.cjs" -Raw) -match 'PROCESS_ONLY') -and ((Get-Content "$ROOT\app\plugins\restart-supervisor\status.cjs" -Raw) -match 'failedReason'))
Check 'Task continuity parks, remembers and resumes through Core, not through the supervisor' (((Get-Content "$ROOT\app\core\task-continuity.cjs" -Raw) -match 'resume-intent\.json') -and ((Get-Content "$ROOT\app\core\task-continuity.cjs" -Raw) -match 'semantic'))
Check 'The health decision gates new work through one seam' (((Get-Content "$ROOT\app\core\work-admission.cjs" -Raw) -match 'PAUSE_NEW_WORK') -and ((Get-Content "$ROOT\app\extensions\mega\scheduler\scheduler.js" -Raw) -match 'setWorkAdmission'))
Check 'One action vocabulary is shared by the page, the panel and the bridge' (((Get-Content "$ROOT\app\core\contracts\service-actions.cjs" -Raw) -match 'DANGEROUS_ACTIONS') -and ((Get-Content "$ROOT\app\core\governance-bridge.cjs" -Raw) -match "contracts/service-actions\.cjs") -and ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match "contracts/service-actions\.cjs"))
Check 'The restart supervisor is documented, with the authority line stated' (($supervisorDocs -match 'application restart\*\* authority') -and ($supervisorDocs -match 'resume tasks'))Check 'A profile dependency is joined to the manifest by package name, not confused with the plugin id' (((Get-Content "$ROOT\app\extensions\mega\plugins\index.cjs" -Raw) -match 'function entryForPackage') -and ((Get-Content "$ROOT\app\extensions\mega\index.cjs" -Raw) -match 'entryForPackage'))
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
Check 'The glass layer is the only appearance input of the dock UI' ((Test-Path "$ROOT\app\extensions\mega\ui\glass-layer.js") -and ((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'glass-layer\.js'))
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
# ---- The system floating orb: a window of ours over every application (system-orb.cjs) ----
$systemOrb = Get-Content "$ROOT\app\extensions\mega\system-orb.cjs" -Raw -ErrorAction SilentlyContinue
$orbPreload = Get-Content "$ROOT\app\extensions\mega\ui\orb-preload.cjs" -Raw -ErrorAction SilentlyContinue
Check 'The system orb is a window that floats over other applications' (($systemOrb -match 'alwaysOnTop: true') -and ($systemOrb -match 'skipTaskbar: true') -and ($systemOrb -match 'focusable: false'))
Check 'It takes no click it was not offered' (($systemOrb -match 'setIgnoreMouseEvents\(!next, \{ forward: true \}\)') -and ($systemOrb -match 'let interactive = null') -and ($systemOrb -match 'hovering = false'))
Check 'An open panel or a drag keeps the window interactive, so the pointer cannot chase itself' (($systemOrb -match 'hovering \|\| dragging \|\| open') -and ($systemOrb -match 'function sameBounds'))
Check 'The ball is a top-level window, so it can cover other applications' (-not ($systemOrb -match 'getParentWindow'))
Check 'The ball grows its panel toward the middle of the screen' (($systemOrb -match 'function layoutOrbWindow') -and ($systemOrb -match 'const above = ballCentre\.y > areaCentre\.y') -and ($systemOrb -match 'const toTheRight = ballCentre\.x < areaCentre\.x'))
Check 'The ball remembers where it was left, in a file rather than in a page' (($systemOrb -match 'function createOrbState') -and ($mega -match "data', 'state', 'system-orb\.json'"))
Check 'The orb window has a document, a stylesheet and an enumerable surface' ((Test-Path "$ROOT\app\extensions\mega\ui\orb.html") -and (Test-Path "$ROOT\app\extensions\mega\ui\orb.css") -and (Test-Path "$ROOT\app\extensions\mega\ui\orb.js") -and ($orbPreload -match 'mega:orb-snapshot') -and ($orbPreload -match 'mega:orb-action'))
Check 'The ball draws the same view model as the official page' (($mega -match "mega-core', 'lib', 'view\.js'") -and ($mega -match 'buildMegaView\(\{'))
# There IS a ball again, in the official overlay slot, and the plugin's browser half also draws the settings
# section: one view model, two surfaces, and the system ball is the same module's (`system-orb.cjs`).
$orbClient = Get-Content "$ROOT\app\plugins\mega-core\lib\client.js" -Raw -ErrorAction SilentlyContinue
# The ball is the plugin's, drawn into the official overlay slot: on the surface the user is looking at.
Check 'The plugin draws the ball, into the official overlay slot' (($orbClient -match "inject\('shell\.overlay'") -and ($orbClient -match 'function MegaOrb'))
Check 'The plugin still draws the settings section' ($orbClient -match "inject\('settings\.section'")
Check 'The ball closes when the user clicks outside it' (($orbClient -match "addEventListener\('pointerdown'") -and ($orbClient -match 'node\.contains\(target\)') -and ($orbClient -match 'setOpen\(false\)'))
# The two surfaces draw the two halves of the view model: the ball the live dashboard, the page the governance
# fields. Both come from `view.js`, so a number on one cannot disagree with the other.
Check 'The ball draws the dashboard and the page draws governance' (($orbClient -match 'dashboard: view\.dashboard') -and ($orbClient -match 'view\.fields \|\| \[\]\)\.map\(FieldRow\)') -and ($orbClient -match 'COUNTDOWN_ROW'))
Check 'The system orb is opt-in, and torn down with the other windows' (($mega -match "if \(process\.env\.DSH_SYSTEM_ORB === '1'\) createSystemOrbWindow\(\)") -and ($mega -match 'if \(systemOrb\) systemOrb\.stop\(\)'))
# ---- The old Mega dock is retired: off by default, back on request ----
Check 'The old Mega dock does not start on screen' (($main -match "let megaDockShown = process\.env\.DSH_MEGA_DOCK === '1'") -and ($main -match "if \(megaDockShown\) await startup\.defer\('dock-ready'"))
Check 'A hidden dock reserves no strip and no wallpaper notch' (($main -match 'megaDockShown\s*\r?\n?\s*\?\s*Math\.max\(MEGA_DOCK_COLLAPSED_WIDTH') -and ($main -match 'if \(!megaDockShown \|\| !megaDockView'))
Check 'It comes back when it is asked for, creating the view if needed' (($main -match 'async function showIntegratedMegaDock') -and ($main -match 'if \(!megaDockView\) await createIntegratedMegaDock\(\)') -and ($mega -match 'if \(dockExpanded && !dockWindow && dockEnabled\(\)\) createDock\(\)'))
Check 'The extension does not build its own dock at boot either' (($mega -match 'function dockAutoStart') -and ($mega -match 'if \(dockAutoStart\(\)\) createDock\(\)'))
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

Write-Output ''
Write-Output '== Computer Use runtime (Update-Plan/computer-use.md) =='
foreach ($file in @('index.cjs','constants.cjs','errors.cjs','ports.cjs','contract.cjs','criteria.cjs','action.cjs','target.cjs','world-state.cjs','state-machine.cjs','safety.cjs','routing.cjs','log.cjs','stabilization.cjs','verification.cjs','miss.cjs','recovery.cjs','stall.cjs','observer.cjs','executor.cjs','isolation.cjs','autonomy.cjs','host-electron.cjs')) {
  Check "Computer Use core module $file present" (Test-Path "$ROOT\app\computer-use\$file")
}
# Long-running execution (Update-Plan/24h.md Tasks 1-20): these modules are part of
# the shipped surface, so the same presence-and-non-empty assert applies to them.
foreach ($file in @('focus.cjs','modal.cjs','evidence.cjs','progress.cjs','processes.cjs','resources.cjs','health.cjs','workspace.cjs','command.cjs','mutation.cjs','reconnect.cjs')) {
  Check "Computer Use long-running module $file present" ((Test-Path "$ROOT\app\computer-use\$file") -and ((Get-Item "$ROOT\app\computer-use\$file").Length -gt 0))
}
foreach ($file in @('browser.cjs','desktop.cjs','vision.cjs','shell.cjs','file.cjs')) {
  Check "Computer Use controller $file present" (Test-Path "$ROOT\app\computer-use\controllers\$file")
}
foreach ($file in @('cdp-page.cjs','win32.cjs','win32-input.ps1','uia.cjs','uia.ps1','screenshot.cjs','screenshot.ps1')) {
  Check "Computer Use real driver $file present" (Test-Path "$ROOT\app\computer-use\drivers\$file")
}
$cuAction = Get-Content "$ROOT\app\computer-use\action.cjs" -Raw
$cuTarget = Get-Content "$ROOT\app\computer-use\target.cjs" -Raw
$cuExecutor = Get-Content "$ROOT\app\computer-use\executor.cjs" -Raw
$cuSafety = Get-Content "$ROOT\app\computer-use\safety.cjs" -Raw
$cuStab = Get-Content "$ROOT\app\computer-use\stabilization.cjs" -Raw
$cuVerify = Get-Content "$ROOT\app\computer-use\verification.cjs" -Raw
$cuRouting = Get-Content "$ROOT\app\computer-use\routing.cjs" -Raw
$cuConstants = Get-Content "$ROOT\app\computer-use\constants.cjs" -Raw
$cuLog = Get-Content "$ROOT\app\computer-use\log.cjs" -Raw
$cuStall = Get-Content "$ROOT\app\computer-use\stall.cjs" -Raw
$cuIndex = Get-Content "$ROOT\app\computer-use\index.cjs" -Raw
$cuDesktop = Get-Content "$ROOT\app\computer-use\controllers\desktop.cjs" -Raw
$cuBrowser = Get-Content "$ROOT\app\computer-use\controllers\browser.cjs" -Raw
$cuVision = Get-Content "$ROOT\app\computer-use\controllers\vision.cjs" -Raw
$cuWorld = Get-Content "$ROOT\app\computer-use\world-state.cjs" -Raw
Check 'The full action surface exists (plan 6)' (($cuConstants -match 'SCREENSHOT_FULL') -and ($cuConstants -match 'ACCESSIBILITY_SET_VALUE') -and ($cuConstants -match 'WAIT_STATE') -and ($cuConstants -match 'SHELL_EXEC'))
Check 'The explicit state machine is complete (plan 51)' (($cuConstants -match 'POST_ACTION_GRACE') -and ($cuConstants -match 'REVALIDATING') -and ($cuConstants -match 'STALLED') -and ($cuConstants -match 'const CU_TRANSITIONS'))
Check 'Target resolution prefers structured identifiers (plan 7)' (($cuTarget -match 'DOM selector') -and ($cuTarget -match 'visual coordinate') -and ($cuTarget -match 'function revalidate'))
Check 'Revalidation thresholds are 3 / 10 px and configurable (plan 10)' (($cuConstants -match 'stablePx: 3') -and ($cuConstants -match 'updatePx: 10'))
Check 'Stabilization is bounded, never a sleep (plan 9/section 11/section 25)' (($cuStab -match 'function settle') -and ($cuStab -match 'function grace') -and ($cuConstants -match 'settleMaxMs: 300') -and ($cuConstants -match 'cooldownHardMaxMs: 500'))
Check 'Waiting is event-driven, not fixed (plan 12)' (($cuStab -match 'async function waitFor') -and ($cuExecutor -match 'waitForEffect'))
Check 'Every action is verified with three states (plan 14/section 46)' (($cuVerify -match 'VERDICTS.UNKNOWN') -and ($cuVerify -match 'VERDICTS.FAILURE') -and ($cuVerify -match 'VERDICTS.SUCCESS'))
Check 'Miss detection exists and is distinct from failure (plan 17)' ((Get-Content "$ROOT\app\computer-use\miss.cjs" -Raw) -match 'no_state_change')
Check 'The recovery ladder ends in a bounded failure (plan 18/section 19/section 21)' (($cuExecutor -match 'recoverFromStall') -and ($cuStall -match 'STALL_RECOVERY_LADDER') -and ($cuStall -match 'fail_with_context'))
Check 'Screenshot escalation climbs one level at a time (plan 22)' (($cuVision -match 'function nextLevel') -and ($cuConstants -match 'REGION: 1'))
Check 'Dynamic cooldown only uses the current step (plan 23/section 24)' (($cuStab -match 'function dynamicCooldown') -and (-not ($cuStab -match 'Chrome is slow')))
Check 'No long-term learning anywhere in the runtime (plan 42)' (-not (($cuIndex + $cuExecutor + $cuWorld + $cuStab) -match 'userProfile|appProfile|latencyModel|reinforcement|learnedProfile'))
Check 'Capability routing prefers api > shell > dom > accessibility > gui > vision (plan 29)' (($cuRouting -match 'api.*shell.*dom') -and ($cuRouting -match "case 'vision'"))
Check 'Window safety refuses a click when the foreground window is wrong (plan 33)' (($cuSafety -match 'WINDOW_MISMATCH') -and ($cuSafety -match 'function checkWindow'))
Check 'Focus safety verifies focus before typing (plan 31)' (($cuSafety -match 'function checkFocus') -and ($cuSafety -match 'FOCUS_MISMATCH'))
Check 'Destructive actions are gated by the contract (plan 34)' (($cuSafety -match 'DESTRUCTIVE_FORBIDDEN') -and ($cuSafety -match 'DESTRUCTIVE_NEEDS_CONFIRMATION'))
Check 'Secrets never reach the execution log (plan 32)' (($cuSafety -match 'function redactAction') -and ($cuLog -match 'redactDetails'))
Check 'Screenshots are only retained by policy (plan 40)' (($cuLog -match 'function shouldRetain') -and ($cuLog -match 'transient capture'))
Check 'A blocking modal pauses the action instead of being ignored (plan 30)' (($cuExecutor -match 'handleModal') -and ($cuSafety -match 'function inspectModals'))
Check 'Controller failures stay inside their own boundary (plan 37/section 38)' ((Get-Content "$ROOT\app\computer-use\isolation.cjs" -Raw) -match 'function isolateController')
Check 'Autonomous continuation is wired into the loop (plan 49)' ((Get-Content "$ROOT\app\computer-use\autonomy.cjs" -Raw) -match 'function createAutonomy' -and ($cuIndex -match 'autonomy.decide'))
Check 'Every action goes through the executor (plan 43)' (($cuExecutor -match 'async function performAction') -and ($cuIndex -match 'executeAction'))
Check 'The shell owns the runtime and its IPC' (($main -match 'ensureComputerUseRuntime') -and ($main -match 'COMPUTER_USE_CHANNELS') -and ($main -match 'disposeComputerUseOnExit'))
Check 'The dock exposes the Computer Use panel' (((Get-Content "$ROOT\app\extensions\mega\ui\dock.html" -Raw) -match 'id="computerUsePanel"') -and (Test-Path "$ROOT\app\extensions\mega\ui\computer-use-panel.js"))
Check 'The panel bridge is exposed through the preload' ((Get-Content "$ROOT\app\extensions\mega\ui\preload.cjs" -Raw) -match 'megaComputerUse')
Check 'Computer Use is configured in config/app.json' ((Get-Content "$ROOT\config\app.json" -Raw) -match '"computerUse"')
Check 'Subdirectories are covered by the syntax gate' (((Get-Content "$ROOT\scripts\check-syntax.cjs" -Raw) -match 'computer-use/controllers') -and ((Get-Content "$ROOT\scripts\check-syntax.cjs" -Raw) -match 'computer-use/drivers'))
Check 'Computer Use reference doc exists' (Test-Path "$ROOT\docs\computer-use.md")
Check 'Real Computer Use acceptance harness exists' (Test-Path "$ROOT\scripts\computer-use-acceptance.cjs")
# Long-running execution gates (Update-Plan/24h.md Tasks 1-20).
$cuFocus = Get-Content "$ROOT\app\computer-use\focus.cjs" -Raw
$cuModal = Get-Content "$ROOT\app\computer-use\modal.cjs" -Raw
$cuEvidence = Get-Content "$ROOT\app\computer-use\evidence.cjs" -Raw
$cuProgress = Get-Content "$ROOT\app\computer-use\progress.cjs" -Raw
$cuProcesses = Get-Content "$ROOT\app\computer-use\processes.cjs" -Raw
$cuResources = Get-Content "$ROOT\app\computer-use\resources.cjs" -Raw
$cuHealth = Get-Content "$ROOT\app\computer-use\health.cjs" -Raw
$cuWorkspace = Get-Content "$ROOT\app\computer-use\workspace.cjs" -Raw
$cuCommand = Get-Content "$ROOT\app\computer-use\command.cjs" -Raw
$cuMutation = Get-Content "$ROOT\app\computer-use\mutation.cjs" -Raw
$cuReconnect = Get-Content "$ROOT\app\computer-use\reconnect.cjs" -Raw
Check 'Focus is trusted only after verification (24h plan 1)' (($cuFocus -match 'HARD_INVALIDATIONS') -and ($cuFocus -match 'FOCUS_INVALIDATION'))
Check 'Modal handling is fail-safe and never picks the first button (24h plan 2)' (($cuModal -match 'DESTRUCTIVE_LABELS') -and ($cuModal -match 'SAFE_DISMISS_LABELS') -and ($cuModal -match 'USER_ACTION_REQUIRED'))
Check 'Stabilization consumes every adaptive signal (24h plan 3/16)' (($cuStab -match 'function dynamicCooldown') -and ($cuStab -match 'navigationPending') -and ($cuStab -match 'targetDetached'))
Check 'Evidence is graded by action risk (24h plan 4)' (($cuEvidence -match 'GRADE_ORDER') -and ($cuEvidence -match 'RISK_BAR') -and ($cuEvidence -match 'must declare its expected effect'))
Check 'Progress counts only meaningful events (24h plan 5)' (($cuProgress -match 'PROGRESS_KINDS') -and ($cuProgress -match 'lastProgressAt'))
Check 'The stall ladder is bounded and ends in fail_with_context (24h plan 6)' (($cuStall -match 'STALL_RECOVERY_LADDER') -and ($cuStall -match 'fail_with_context'))
Check 'Owned processes are supervised, not forgotten (24h plan 7)' (($cuProcesses -match 'PROCESS_MODE') -and ($cuProcesses -match 'not_owned') -and ($cuProcesses -match 'function dispose'))
Check 'Resource ceilings and screenshot retention are enforced (24h plan 8)' (($cuResources -match 'maxScreenshots') -and ($cuResources -match 'maxEvidenceBytes') -and ($cuResources -match 'transient'))
Check 'Reconnection is bounded per step (24h plan 10)' (($cuReconnect -match 'RECONNECT_EXHAUSTED') -and ($cuReconnect -match 'function beginStep'))
Check 'Workspace continuity is verified before every operation (24h plan 11)' (($cuWorkspace -match 'function resolveCwd') -and ($cuWorkspace -match 'WORKSPACE_UNAVAILABLE') -and ($cuWorkspace -match 'WORKSPACE_MISMATCH'))
Check 'Filesystem mutations are verified against disk (24h plan 12/14)' (($cuMutation -match 'RESUME_VERDICT') -and ($cuMutation -match 'already_complete') -and ($cuMutation -match 'unverifiedError'))
Check 'Shell commands carry a bounded contract (24h plan 13)' (($cuCommand -match 'COMMAND_DEFAULTS') -and ($cuCommand -match 'maxTimeoutMs') -and ($cuCommand -match 'function judge'))
Check 'Health reports healthy / degraded / blocked with its block reasons (24h plan 19/20)' (($cuHealth -match 'HEALTH_STATUS') -and ($cuHealth -match 'BLOCK_REASONS') -and ($cuHealth -match 'state_integrity_uncertain'))
Check 'Long-running log hygiene is implemented (24h plan 18)' (($cuLog -match 'DEFAULT_MAX_FILES') -and ($cuLog -match 'function rotate') -and ($cuLog -match 'reasonCode'))
Check 'Long-running execution tests ship with the runtime' ((Test-Path "$ROOT\tests\unit\computer-use-longrun-modules.test.js") -and ((Get-Content "$ROOT\tests\unit\computer-use-longrun-modules.test.js" -Raw) -match 'Task 20'))
Check 'The accelerated soak and failure-injection harness ships (24h plan 23-26)' ((Test-Path "$ROOT\scripts\computer-use-longrun-acceptance.cjs") -and ((Get-Content "$ROOT\scripts\computer-use-longrun-acceptance.cjs" -Raw) -match 'FAILURE_INJECTIONS') -and ((Get-Content "$ROOT\scripts\computer-use-longrun-acceptance.cjs" -Raw) -match 'Update-Plan/24h.md'))

# ---- the engineering runtime (Update-Plan/24h-1.md) ----
Write-Output ''
Write-Output '== Engineering runtime (Update-Plan/24h-1.md) =='
$engineeringModules = @(
  'index.cjs', 'episode.cjs', 'supervisor.cjs', 'repository.cjs', 'discovery.cjs',
  'plan.cjs', 'mutation.cjs', 'git.cjs', 'verifier.cjs', 'scheduler.cjs',
  'checkpoint.cjs', 'context.cjs', 'result.cjs', 'failure.cjs', 'process.cjs',
  'autonomy.cjs', 'locking.cjs'
)
foreach ($file in $engineeringModules) {
  Check "Engineering module $file present" ((Test-Path "$ROOT\app\engineering\$file") -and ((Get-Item "$ROOT\app\engineering\$file").Length -gt 0))
}
Check 'The project adapters ship' ((Test-Path "$ROOT\app\engineering\adapters\index.cjs") -and ((Get-Content "$ROOT\app\engineering\adapters\index.cjs" -Raw) -match 'nodeAdapter') -and ((Get-Content "$ROOT\app\engineering\adapters\index.cjs" -Raw) -match 'pythonAdapter') -and ((Get-Content "$ROOT\app\engineering\adapters\index.cjs" -Raw) -match 'rustAdapter') -and ((Get-Content "$ROOT\app\engineering\adapters\index.cjs" -Raw) -match 'genericAdapter'))
$engSupervisor = Get-Content "$ROOT\app\engineering\supervisor.cjs" -Raw
Check 'The supervisor runs the documented engineering loop' (($engSupervisor -match 'DISCOVERING') -and ($engSupervisor -match 'PLANNING') -and ($engSupervisor -match 'REPAIRING') -and ($engSupervisor -match 'VERIFYING'))
$engResult = Get-Content "$ROOT\app\engineering\result.cjs" -Raw
Check 'Completion is refused without fresh evidence' (($engResult -match 'FRESHNESS') -and ($engResult -match 'NOTHING_RAN') -and ($engResult -match 'REFUSED'))
$engGit = Get-Content "$ROOT\app\engineering\git.cjs" -Raw
Check 'Destructive git commands are not implemented (24h-1 plan 18/76)' (($engGit -match 'FORBIDDEN_COMMANDS') -and ($engGit -match 'allowCommit') -and ($engGit -match 'reset\\s\+--hard'))
$engScheduler = Get-Content "$ROOT\app\engineering\scheduler.cjs" -Raw
Check 'The 24h scheduler parks instead of busy-waiting (24h-1 plan 103-106)' (($engScheduler -match 'WAKE_REASONS') -and ($engScheduler -match 'function park') -and ($engScheduler -match 'function deadlineState'))
Check 'The engineering test matrix ships' (((Test-Path "$ROOT\tests\unit\engineering-scenarios.test.js")) -and ((Test-Path "$ROOT\tests\unit\engineering-plan.test.js")) -and ((Test-Path "$ROOT\tests\unit\engineering-verifier.test.js")) -and ((Test-Path "$ROOT\tests\unit\engineering-context.test.js")) -and ((Test-Path "$ROOT\tests\unit\engineering-checkpoint.test.js")))
$engCheck = Get-Content "$ROOT\scripts\check-syntax.cjs" -Raw
Check 'The syntax gate covers the engineering runtime' (($engCheck -match "'engineering'") -and ($engCheck -match "'engineering/adapters'"))
Check 'The reference doc records the long-running guarantees (24h plan 1-20)' ((Get-Content "$ROOT\docs\computer-use.md" -Raw) -match 'Long-running execution')
Check 'The acceptance record targets the soak and the failure matrix (24h plan 23-25)' (((Get-Content "$ROOT\docs\computer-use-acceptance.md" -Raw) -match 'soak') -and ((Get-Content "$ROOT\docs\computer-use-acceptance.md" -Raw) -match 'failure-injection'))

# ---- The installed shape of the shipped plugin (the one acceptance that leaves the checkout) ----
# Every other check above reads the source tree. This one is about what the installer puts on disk: the
# bundle is discovered, is loadable from the profile's own node_modules, and reaches the official Settings.
Check 'The installation-level Mega Core acceptance ships' (Test-Path "$ROOT\tests\unit\mega-core-install-acceptance.test.js")
Check 'The install acceptance is asserted by name in the test gate' ((Get-Content "$ROOT\scripts\test-all.ps1" -Raw) -match 'mega-core-install-acceptance\.test\.js')
Check 'The install acceptance is asserted by name in the CI gate' ((Get-Content "$ROOT\.github\workflows\verify.yml" -Raw) -match 'mega-core-install-acceptance\.test\.js')
$installAcceptance = Get-Content "$ROOT\tests\unit\mega-core-install-acceptance.test.js" -Raw -ErrorAction SilentlyContinue
# The three facts, each named in the suite itself: a suite that quietly stopped asserting one of them would
# still be green, so the words it has to contain are asserted here.
Check 'The install acceptance checks discovery, loading and the official Settings' (($installAcceptance -match 'shipped') -and ($installAcceptance -match 'settings\.section') -and ($installAcceptance -match 'shadowManifests'))

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
