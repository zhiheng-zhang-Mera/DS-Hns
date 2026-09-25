# RC2 visible journey — 2026-09-25

Status: `PARTIAL_NOT_FULL_ACCEPTANCE`

This is a direct Codex Computer Use observation of the exact source candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` (`816f513c98e40831f0e81f8567e72e6fd01adcd4`) from the fresh clean-room clone. Later same-candidate sessions completed two bounded live provider UI smokes and same-process conversation navigation/reopen; the exact-text exchange was also inspected in the visible Trace tab. This is still not a complete user-journey pass.

## Observed journey

1. Launched the clean-room Electron executable visibly from `D:\Hns-Cleanroom-Qualification-20260925-4ef9c0d-r2\repo\app\node_modules\electron\dist\electron.exe`, with `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `DSH_HOME`, `DSH_USER_DATA_DIR`, `DSH_RUNTIME_DATA_DIR`, `DSH_RUNTIME_ROOT`, `DSH_TEMP_ROOT`, `DSH_TEST_ROOT`, workspace, npm cache, and Electron cache rooted under `D:\qf\manual-journey-4ef9c0d`.
2. Read the first-run view and used the native Windows folder picker to select `D:\qf\manual-journey-4ef9c0d\workspace`. The main workbench displayed `workspace`.
3. Opened Settings and visually inspected General and Plugins. Without changing settings, searched the visible plugin list for `Health Scheduler` and `Plugin Market`; both returned “no matching plugins”. This settings catalog is distinct from the installer/runtime plugin inventory and does not establish that either runtime capability is absent.
4. Closed the app normally and reopened the same isolated instance. The `workspace` selection was visible after restart.
5. Restarted with `DSH_MEGA_INTEGRATED_DOCK=1`. Mega appeared in the same window while the official composer remained visible. The visible dock reported 27 loaded, 1 unhealthy, and 1 off; the aggregate unhealthy row was not identified or diagnosed. The collapse control hid the dock, and the app's visible `Ctrl+Shift+M` shortcut reopened it.
6. In a subsequent fresh UI session against the same exact candidate, selected the D-rooted `workspace`, submitted one non-sensitive arithmetic prompt to the visible `DeepSeek-V41-Flash` model, read the visible answer `1109`, navigated to a new session, then selected the original session and visually confirmed the prompt and answer remained. This persistence check was within the same running process; the app was not closed/restarted after this prompt.

## Boundaries and evidence

- The original reused-profile session above contained only the literal placeholder `sk-qualification-placeholder-not-sent` and did not submit a message. The later exact-candidate smoke is separate: one generic arithmetic request returned `1109`, and the conversation was restored after in-app navigation. This does not establish a long task, provider failure/retry, close/restart persistence, plugin workflow, or complete Journey.
- The fresh-profile first-run disclosure with the opt-in expanded dock was not replayed in the original manual session. A separate exact-candidate r4 visual replay is recorded below and supersedes the historical overlap as a current-candidate finding.
- The visible UI acceptance child in machine run `2026-09-25T04-37-57-947Z-f4caf3b3` separately passed 134/134 and included targeted operator input for its native picker. That bounded harness result does not turn this partial manual journey into a complete provider journey.
- No independent reviewer or delegated QA was used, per the user's no-agent/no-delegation instruction.

Screenshots retained on D: (not copied into the repository):

| Image | SHA-256 | What it shows |
|---|---|---|
| `D:\qf\manual-journey-4ef9c0d\08-workbench-after-plugin-search.jpg` | `c1480437dc38c048e50b583f33cf2fec93846338cdeed26c110f287a6d25c82d` | Main workbench with the selected D-drive workspace after the settings search. |
| `D:\qf\manual-journey-4ef9c0d\09-mega-dock-open-after-shortcut.jpg` | `ffad38ca77717cb268781caac201c5429e2028a9adfee51418f38038df8f6a1f` | Visible integrated Mega dock and workbench after `Ctrl+Shift+M`. |

## Fresh-profile first-run dock and System Orb replay (r4)

This is a separate direct Computer Use session against the same exact source SHA/tree, not a continuation of the reused-profile journey above. The Electron app was launched from the fresh clean-room clone with isolated userData/runtime/cache/TEMP/profile roots on D:. The opt-in expanded Mega dock and first-run beta disclosure were both visible. After startup completed, Continue was clicked through the real visible control; the disclosure closed and the workbench appeared while the dock remained present. The stale overlap triage is therefore not reproduced on candidate `4ef9c0d`. No source change was made; `tests/unit/appearance-panel.test.js` independently passed 18/18 against the same source tree.

The separate System Orb window was activated, visually inspected, and clicked. Its panel expanded and displayed `Healthy`, `6 of 11 plugin(s) active`, `3/4` bundled plugins installed, and no pending/blocked/retrying tasks. It also disclosed the optional `dsh-wallpaper-engine` absence and `Computer Use unavailable — no host runtime attached; core unaffected`. No repair/retry action was taken. Clicking the visible Refresh control updated the displayed status time. This is an actual click-to-panel/status/refresh observation, not a source/DOM/log substitute.

Screenshots are retained on D: and hash-bound below:

| Image | SHA-256 | What it shows |
|---|---|---|
| `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\01-first-run-expanded-dock.jpg` | `2590F19B634248C2E1F8F58025C7BFB87D5DAAFF112A8AB46433580674B3170A` | Fresh first-run beta disclosure with expanded dock; Continue remains visible and unobscured. |
| `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\02-workbench-after-continue.jpg` | `658122A29F044D814AB2A0C185FAEC3FA930ECBB0B8A97A8D744B1DA940F1CD2` | Workbench after Continue; the disclosure no longer blocks the workspace. |
| `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\03-system-orb-closed.jpg` | `7C8E7C0D9A876171A485F84D7566281CF602B942D1E5E19E52D9C52E4A38AA90` | Orb closed before the real click. |
| `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\04-system-orb-open-0.jpg` | `EEBCA668229B17ECFD9CD1AA523D7A48427638FD1C4854568607DE3E3723B47B` | Visible main surface with the System Orb panel open. |
| `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\04-system-orb-open-1.jpg` | `761FB0673B12FD11004C1CB37DD32994EDB06AC9463E64AF51AFB20B88DBDA6BE` | Direct panel capture with status and optional capability warnings. |
| `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\05-system-orb-after-refresh.jpg` | `09442CE1401857139CE190B8F666F5C0147EF8C6EA652B252DE4AFD3C461D741` | Panel after visible Refresh interaction. |
| `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\reports\appearance-panel-test.stdout.txt` | `E92601DBB6E893D97DA98CB3E7848B1856E7545976A882D1044AA0418AC5BCB1` | Exact-source targeted regression output, 18/18 passed. |

## Exact-candidate live provider smoke follow-up

This follow-up used the visible clean-room candidate window (`D:\Hns-Cleanroom-Qualification-20260925-4ef9c0d-r2\repo`) and the D-rooted workspace `D:\qf\manual-journey-4ef9c0d\workspace`. Computer Use selected the workspace, typed and visibly submitted “Please compute 37 × 29 + 36 and give only the numeric result.” to `DeepSeek-V41-Flash` (High), and read the UI response `1109` with a displayed one-second duration. It then navigated to a new session and reopened the original conversation; both prompt and response remained visible. This verifies one live provider response and same-process navigation persistence only—not a process restart, task checkpoint/recovery, plugin operation, or full workflow. The app clock displayed `17:43`; the exact request timestamp was not independently bound to a wall-clock sample.

| Image | SHA-256 | What it shows |
|---|---|---|
| `D:\qf\rc2-current-candidate-visual-journey-4ef9c0d-20260925\01-provider-response-restored-session.jpg` | `30649C3245655FC3DB0F8B7B446E5261653268833FB9CD92D5A20157550DDCF2` | Exact-candidate conversation after navigating away and reopening it; the prompt and `1109` response are visible. |

The r4 dock/Orb replay remains a distinct visual sub-experiment and did not include a provider request. Neither it nor this one-shot smoke diagnoses the unnamed unhealthy plugin in the older reused-profile aggregate or constitutes independent QA. The overall journey remains `PARTIAL_NOT_FULL_ACCEPTANCE`.

## Additional exact-candidate provider and file-sidebar follow-up — 2026-09-25

On the exact clean-room candidate window, Settings → Models visibly showed the DeepSeek provider configured; no key was opened or changed. Settings → Plugins showed 28 session plugins and 156 global plugins; Agent presets showed Standard mode as current. These are visual inventory observations, not proof that every plugin is healthy.

A new conversation was created and the non-sensitive prompt `Reply with exactly this text: DS-Hns provider UI acceptance passed.` was sent through the visible `DeepSeek-V41-Flash` High model. The UI returned exactly `DS-Hns provider UI acceptance passed.` and displayed a one-second duration. I navigated to the earlier `Compute 37 × 29 + 36` session and back; both visible conversations retained their own prompt/answer in the same process. I opened the right-side Files panel and confirmed the visible path was `D:\qf\manual-journey-4ef9c0d\workspace`, shown as empty. This is a second bounded live provider request and same-process navigation restoration only; no process restart, durable checkpoint, long task, provider failure/retry, or plugin fault/recovery was exercised.

| Image | SHA-256 | What it shows |
|---|---|---|
| `D:\qf\manual-journey-4ef9c0d\10-provider-ui-roundtrip-sidebar.jpg` | `2744B7891AA448FA8E1181C7BC1CF2C6C9BFFA5B898B18DC94CC50D3344C2457` | Exact requested provider response restored in its session, with the right-side file panel visibly pointing to the D-rooted isolated workspace. |

### Computer Use launch side effect — preserved, not cleaned

During window recovery, launching the repository's raw `electron.exe` without the required application-directory argument opened Electron's bundled `default_app.asar` page instead of another DS-Hns instance. The shell was visibly closed. Its executable-path cohort was PID 52872 (Computer Use parent PID 16060) with three Electron children, and the default profile was `C:\Users\15601\AppData\Roaming\Electron`. That C directory pre-existed and contains unrelated/shared Electron data, but files under it received new writes during this shell's lifetime (latest observed timestamps around 2026-09-25 08:47 UTC). No cleanup was attempted. This is an additional D-only storage incident; the actual DS-Hns window continued using the D-rooted candidate configuration. Avoid launching Electron without the app path and D-root overrides.

## Visible trace-tab follow-up — 2026-09-25

Using Codex Computer Use on the exact-candidate app window, I opened the visible `轨迹` (Trace) tab and visually read the timeline for the exact-text provider request. The visible rows showed the user prompt, the runtime-context snapshot naming the D-rooted session workspace, request #1, and the assistant's exact response `DS-Hns provider UI acceptance passed.`. This verifies that this bounded exchange is represented in the operator trace surface; it does not establish a tool call, long task, durable checkpoint, failure/retry, or plugin workflow. The screenshot is retained at `D:\qf\manual-journey-4ef9c0d\11-provider-trace-visible.jpg`, SHA-256 `8a4c3f97dc2ebeb12899078eff8f97e8d2e41a2d93c736aa066b0681e7a6cc4a`.
