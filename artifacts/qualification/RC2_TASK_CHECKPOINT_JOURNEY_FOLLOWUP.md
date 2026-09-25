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

## Separate-conversation checkpoint resume (2026-09-25)

Codex Computer Use opened a new conversation in the same exact-candidate `DeepSeek Harness` application window (the app remained running; no process restart). The visible prompt restricted the task to the D-drive workspace files and the product's file read/write tools. The new conversation read the prior checkpoint and result, verified `task_id=rc2-task-resume-20260925-01`, observed `PAUSED_FOR_RESUME` and `next_step=resume_from_separate_conversation_read_checkpoint_and_result`, then checked the exact report title and its four phase rows. It created a new continuation note, updated only the checkpoint to `COMPLETE` for this narrow file-based acceptance, and read back both changed/new files. The original report remained read-only.

Codex visually inspected the completed response and opened the session-2 Markdown note in the application's side-panel preview. The UI labeled the selected model `DeepSeek-V41-Flash`; backend/provider identity was not independently verified. The on-screen screenshot was inspected during this interaction but was not retained as a separate image artifact. The durable artifacts and independent read-only disk hashes are:

| Evidence | D-drive path | SHA-256 |
|---|---|---|
| Prior result report (read-only) | `D:\qf\manual-journey-4ef9c0d\workspace\rc2-task-resume.md` | `540737B2034AE0DDA3AC181F33B2418E757059DD674764F4BB5E9F7C37A8E4C5` |
| Updated checkpoint | `D:\qf\manual-journey-4ef9c0d\workspace\rc2-task-resume.checkpoint.json` | `6D62A8B5F3FBB913F5DA033E44FF2A4B7B36547AFDC098754867ED333B07A6E6` |
| New session-2 note | `D:\qf\manual-journey-4ef9c0d\workspace\rc2-task-resume-session-2.md` | `E86B6E019D0F60C4E1587AC617E649C78FEF28D746E533B9D5FC283907C41A8E` |

The checkpoint's final status is `COMPLETE` with `next_step: null`; the new note records the independently observed pre-resume `PAUSED_FOR_RESUME` state and the four passing checks. This is a bounded cross-conversation file-checkpoint acceptance only. It does **not** establish application/process restart or reboot recovery, provider failure/retry, plugin recovery, long-task continuity, or provider identity. It does not upgrade the overall candidate Journey from partial.
