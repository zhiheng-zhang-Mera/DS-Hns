# Actual desktop journey, candidate 997345f

This is an in-progress observation record, not a qualification certificate.
Exact candidate: 997345fc8d0b7e219bfd6697ce9914427e0dd8e9.
Tree: 09cb3c1405bc65acc43f3078040db4fd533bb6eb.
Launch: launch-1.json; actual fresh14 installed profile, no acceptance flag,
no observer preload, no CDP. All input used @oai/sky and was followed by
actual screenshot inspection. Machine qualification had previously exercised
this installed profile; separate Electron userData does not erase that fact.

## Observed before real task execution

- Startup showed a disclaimer. A first attempted Continue click coincided with
  the inherited Mega dock expansion and did not dismiss it. Narrow dock and
  overlapping content were observed; a second visually targeted Continue click
  dismissed the disclaimer and restored a readable main page. This layout
  observation remains to be adjudicated, not silently counted as visual PASS.
- Plugin Market loaded 8411 catalog entries and an update advisory 0.4.7 ->
  0.4.9. No upgrade or plugin installation was performed.
- Installed tab visibly listed five distinct identities: dsh-health-scheduler
  2.0.1 (profile), @dsh-market/plugin, dsh-plugin-mega-core,
  dsh-plugin-wallpaper-engine, dsh-restart-supervisor. Four latter entries
  appeared under other installed / not catalogued. No duplicate logical row
  was seen. Screenshot 02-installed.png.
- In-UI orb expanded on actual click. Healthy, 7/11 active, 4/4 bundled installed,
  zero blocked/retrying; Computer Use explicitly unavailable with no host
  runtime attached and core unaffected. Price expanded and showed OFF-PEAK,
  peak windows 09:00-12:00 and 14:00-18:00 Asia/Shanghai. Screenshot
  03-price-health.png. This is UI contract evidence, not independent validation
  of externally current pricing.
- Empty new-task form exposed disabled Schedule. A draft marker was entered
  and Back clicked; pending/queue remained zero. Reopening showed an empty form.
- Exactly one harmless request was submitted via Schedule. It prohibits tools,
  file changes, commands, and other tasks and requests the literal response
  HNS_RC_JOURNEY_997345F_OK. Scheduled local time 2026-09-23 21:09.
- UI confirmed queued. Durable ID: task-1790161631369-abmr5. Raw queue snapshot
  queue-after-single-submit.json shows SUSPENDED / waiting-schedule, attempts 0,
  no session yet, and exactly one entry. Actual expanded Queue displayed
  '已挂起 · 等到点' and 21:09. No false completion was shown.

## Real task and desktop lifecycle

- At local 21:09 the queue emptied and one official conversation appeared.
  Opening its actual sidebar item showed the exact requested marker in the
  assistant response. Screenshot 05-real-provider-result.png. Actual session:
  session-62215e3a-a254-4199-b234-12c043619066. History recorded COMPLETED with
  durationMs 10012; this scheduler duration is not the renderer's 1-second
  response-time display. No notification was visually captured, so native
  notification delivery is NOT_OBSERVED rather than inferred PASS.
- First native Alt+F4 closed the main window and all owned Electron processes
  plus companion PID 26296. Runtime PID 16564 and Harness PID 7508 survived
  with identical creation identities. Raw before/after process inventories
  retained; launch-1.stderr.log was empty.
- Same-profile launch attempt 2 created Desktop PID 24404. The original
  conversation and exact response restored visually without another submission.
  Screenshot 06-reopened-result.png. Queue remained empty and history retained
  the same single ID. During initial startup the orb briefly showed governance
  unavailable, then Healthy after initialization; both observations retained.
- Attempt-2 Alt+F4 did not close the visible main window. A guard refused to
  launch another Desktop while it remained live. Re-observation showed no
  confirmation dialog. Clicking its native titlebar X subsequently closed all
  Electron processes and companion, leaving the same two Runtime/Harness PIDs.
  Do not report the unsuccessful key input as a successful close or infer its
  root cause. No force-kill recovery was used.

## Native System Orb attempt (not accepted)

- Launch system-orb-3, PID 23724, same profile and surviving Runtime,
  DSH_SYSTEM_ORB=1. Independent top-level Mega window 1443594, 60x60,
  displayed the green ball; screenshot 07-native-orb-collapsed.png.
- Native coordinate click at observed 30,30 failed with:
  `point (1882, 994) is over explorer.exe "FolderView", not target window electron.exe "Mega"`.
  Explicit activation + fresh screenshot + one retry returned the same error.
  Fresh accessibility exposed button 10, ID ball; accessibility click returned
  the same target guard. Tab did not establish button focus. No expansion,
  panel, or feedback was observed. Interaction remains NOT_RUN / input blocked.
- Source inspection confirms collapsed orb intentionally uses non-focusable,
  default mouse-passthrough window; renderer pointermove -> hover IPC is supposed
  to enable input. The tool guard alone does not prove a broken product hover
  implementation. No target guard was bypassed and no source was changed.
- Main-window screenshot while native System Orb was live ALSO showed an in-UI
  ball. This is a new ownership observation needing investigation; retained
  Runtime was originally started in in-UI mode. Do not assume the two surfaces
  have reconciled or silently count native interaction as PASS.

## Subsequent root-cause and cleanup evidence

At 2026-09-23T11:16:31.8902940Z the actual governance endpoint omitted `orb`,
and the actual view endpoint returned `mode: in-ui, hideInUi: false` while the
native system window was live. Source tracing found Desktop already supplies
the system ownership object, but `buildControlCenter` drops that input. A
builder -> JSON transport -> actual view regression reproduced the missing
system mode before repair. This establishes an ownership propagation defect;
it does not establish the separate native input-guard failure's cause.
Screenshot 08-in-ui-ball-while-native-orb-live.png retains the duplicate surface.

The final Desktop was closed through its native titlebar. The owned Runtime
was then explicitly stopped using its canonical CLI (runtime-stop.log).
post-journey-audit.json covers 11:00:13.1974582Z to 11:20:13.7166625Z and reports
POST_TEST_PROCESS_LEAK_GATE=PASS and C_DRIVE_WRITE_AUDIT=PASS, with empty
finding arrays. This is the named audit's scope, not proof of zero OS writes.

Startup dock overlap, native orb input, and native notification observation
remain unresolved. Ownership repair is under regression in construction,
not applied to this immutable installed candidate. Real 24h has not started.
