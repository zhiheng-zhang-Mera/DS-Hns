# RC2 visible journey — 2026-09-25

Status: `PARTIAL_NOT_FULL_ACCEPTANCE`

This is a direct Codex Computer Use observation of the exact source candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` (`816f513c98e40831f0e81f8567e72e6fd01adcd4`) from the fresh clean-room clone. It is not a provider acceptance or a complete user-journey pass.

## Observed journey

1. Launched the clean-room Electron executable visibly from `D:\Hns-Cleanroom-Qualification-20260925-4ef9c0d-r2\repo\app\node_modules\electron\dist\electron.exe`, with `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `DSH_HOME`, `DSH_USER_DATA_DIR`, `DSH_RUNTIME_DATA_DIR`, `DSH_RUNTIME_ROOT`, `DSH_TEMP_ROOT`, `DSH_TEST_ROOT`, workspace, npm cache, and Electron cache rooted under `D:\qf\manual-journey-4ef9c0d`.
2. Read the first-run view and used the native Windows folder picker to select `D:\qf\manual-journey-4ef9c0d\workspace`. The main workbench displayed `workspace`.
3. Opened Settings and visually inspected General and Plugins. Without changing settings, searched the visible plugin list for `Health Scheduler` and `Plugin Market`; both returned “no matching plugins”. This settings catalog is distinct from the installer/runtime plugin inventory and does not establish that either runtime capability is absent.
4. Closed the app normally and reopened the same isolated instance. The `workspace` selection was visible after restart.
5. Restarted with `DSH_MEGA_INTEGRATED_DOCK=1`. Mega appeared in the same window while the official composer remained visible. The visible dock reported 27 loaded, 1 unhealthy, and 1 off; the aggregate unhealthy row was not identified or diagnosed. The collapse control hid the dock, and the app's visible `Ctrl+Shift+M` shortcut reopened it.

## Boundaries and evidence

- No provider request was sent. The environment contained only the literal placeholder `sk-qualification-placeholder-not-sent`; no message was submitted. A real-provider prompt/response and conversation persistence acceptance are `NOT_RUN`.
- The fresh-profile first-run disclosure with the opt-in expanded dock was not replayed in this manual session. Existing `FQ-UI-DOCK-OVERLAP-001` therefore remains `OPEN`; this session does not supersede the previous reproduction.
- The visible UI acceptance child in machine run `2026-09-25T04-37-57-947Z-f4caf3b3` separately passed 134/134 and included targeted operator input for its native picker. That bounded harness result does not turn this partial manual journey into a complete provider journey.
- No independent reviewer or delegated QA was used, per the user's no-agent/no-delegation instruction.

Screenshots retained on D: (not copied into the repository):

| Image | SHA-256 | What it shows |
|---|---|---|
| `D:\qf\manual-journey-4ef9c0d\08-workbench-after-plugin-search.jpg` | `c1480437dc38c048e50b583f33cf2fec93846338cdeed26c110f287a6d25c82d` | Main workbench with the selected D-drive workspace after the settings search. |
| `D:\qf\manual-journey-4ef9c0d\09-mega-dock-open-after-shortcut.jpg` | `ffad38ca77717cb268781caac201c5429e2028a9adfee51418f38038df8f6a1f` | Visible integrated Mega dock and workbench after `Ctrl+Shift+M`. |
