# Electron observation transport listener lifecycle

Real Electron diagnostic run `2026-09-23T06-02-13-322Z-8711f8dd` emitted MaxListenersExceededWarning for11message and11detach listeners on Debugger. Passing UI assertions did not erase the warning.

`createElectronHost.currentPage()` created a new adapter for every observation of the same WebContents. The transport also added anonymous native listeners on attachment and cleared only its subscriber array on detach, leaving the native listeners installed. Repeated observation and reconnection therefore accumulated resources.

Four behavioral regressions using a real EventEmitter at the Electron API boundary failed before repair: native listeners survive disposal; repeated observation creates multiple adapters; replacing the view retains its old listeners; a disconnected cached page skips CDP bootstrap. Repair retains one adapter for the current view, releases a replaced view, removes named native listeners, and invalidates page bootstrap on native connection loss. Both native loss and explicit disposal release connection-owned subscribers; the page subscribes afresh during reattachment. Listener limits are unchanged.

The focused lifecycle and input-scope suite passed6/6. An intermediate fixture counted the newly intentional Inspector.detached event as Page.loadEventFired; its counter was narrowed to the named Page event, retaining the exactly-once delivery requirement. All RED/intermediate/GREEN logs remain outside the checkout under `D:\Hns-Final-Qualification`.

The first pinned full regression (`ui-scope-listener-pinned-regression.log`) failed:1931tests,1928passed,1failed,2repository-defined skips. The existing resource-growth test correctly required subscriber release on both detach paths. An additional behavioral test reproduced delivery to an old subscriber after native reconnection. The repair now preserves that existing requirement rather than weakening its assertion. Focused lifecycle/resource-growth/input-scope regression passed11/11 (`listener-native-release-green.log`); its RED and failed full-run logs remain preserved.

The next full pinnedNode24.14.1 repository regression (`listener-release-full-regression.log`) passed:1932tests,1930passed,0failed,2repository-defined skips,449753.257ms. Both skips name absent external community sample directories, not skipped product failures.

Real Electron diagnostic run `2026-09-23T06-36-53-021Z-743ee342` passed131/131. Codex read and operated the current native folder dialog, with same-run screenshot `native-picker-selected-directory.png`. The complete `runtime/electron-data/logs/acceptance.err.log` contains only the DevTools listening line; noMaxListenersExceededWarning recurred. This bounded real-process check does not prove24-hour listener stability. The run is explicitly dirty/UI-only and cannot replace immutable full local/cleanroom qualification or CI.
