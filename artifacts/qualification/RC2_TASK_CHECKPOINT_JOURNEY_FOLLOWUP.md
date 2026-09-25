# RC2 bounded task/checkpoint UI journey follow-up

**Result: `PASS_BOUNDED_VISIBLE_JOURNEY`; full task/recovery qualification remains partial.**

On 2026-09-25, Codex Computer Use interacted with the visible candidate Electron window identified as `DeepSeek Harness`, launched from the isolated D-drive cleanroom candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` (`dev/hns-final-qualification-rc2`). This was an actual desktop interaction, not a DOM-only, source-only, or log-only exercise.

The UI displayed the model label `DeepSeek-V41-Flash` at High. A bounded task asked the app to create a Markdown acceptance record and JSON checkpoint in `D:\qf\manual-journey-4ef9c0d\workspace`, perform plan/checkpoint/verify, read both files back, and avoid shell/network use. The visible task completed with 5 tool calls (checkpoint write, Markdown write, Markdown read, checkpoint read, present) and 3 messages. The result view and Trace view were captured. Then the same process navigated to a prior session and back; the task transcript, result, checkpoint card, and file card were restored.

The two output files were independently read back from disk. The Markdown has 9 lines; the JSON checkpoint records task id `journey-acceptance-001`, plan stages, workspace/target paths, and `shell_network_used: false`.

| Evidence | D-drive path | SHA-256 |
|---|---|---|
| Result screenshot (1474x913) | `D:\qf\manual-journey-4ef9c0d\evidence\journey-acceptance-result.jpg` | `A324E85C8B0EE0E728FC6854F83E2E994348B184ACBAA43614B015E08E3EE42B` |
| Trace screenshot (1474x913) | `D:\qf\manual-journey-4ef9c0d\evidence\journey-acceptance-trace.jpg` | `4EBA459CE397DA0515DD4B6BE2CD727144BE45B0B5F47AD8160555CF9F6E7995` |
| User task output | `D:\qf\manual-journey-4ef9c0d\workspace\journey-acceptance.md` | `702FB15FFF42699E0C4CFF7C3689A45C178B76A2DF42F73810498824E433A32E` |
| Checkpoint output | `D:\qf\manual-journey-4ef9c0d\workspace\journey-acceptance.checkpoint.json` | `0B2C1D5D5EFDCE362C29B7C6ACF77DE2BBE44CF84288E9D60387E13EE20FDA06` |

The displayed `DeepSeek-V41-Flash` label is a UI observation only; provider/backend identity was not independently verified. The task duration was displayed as 15 seconds; this is not a latency benchmark.

This run **does not** establish post-process-restart or reboot persistence, provider failure/retry recovery, plugin workflows, a long-running task, or the real 24-hour soak. Those remain `NOT_RUN` or incomplete as applicable. It improves the task/checkpoint journey from wholly untested to a bounded same-process visible pass, without changing the overall finalization blocker status.
