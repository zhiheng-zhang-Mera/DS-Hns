# DS-Hns Computer Use

> 一个无长期学习依赖、结构化状态优先、视觉兜底、具备瞬态稳定、动作验证、失败恢复与自主连续执行能力的通用计算机任务执行 Runtime。

Reference implementation of `Update-Plan/computer-use.md`. This document is the
operating manual: what the runtime is, where every piece lives, how a task is
executed, how to run it, and what it honestly cannot do yet.

---

## 1. What it is

DS-Hns Computer Use receives an **execution contract** and drives it to a
verified finish on the current machine:

```text
Goal -> Observe -> Act -> Verify -> Recover if needed -> Continue -> Finish
```

It is deliberately **not** a planner, **not** a learner and **not** a profile of
your applications. Long-term planning belongs to Boss or another upper agent;
this runtime adapts to the *current state* of the machine and discards what it
observed when the task ends (plan §1, §5, §42).

Design rules, in priority order:

```text
Structure first. Events second. Vision only when necessary.
Short forced delay. Long conditional wait.
Verify every meaningful action.
Adapt to current state. Do not learn the application.
Retry intelligently. Do not retry blindly.
Fail locally. Do not crash globally.
```

---

## 2. Where it lives

```text
app/computer-use/                     the runtime (Electron-free core)
  index.cjs                           createComputerUseRuntime(): assembles everything
  constants.cjs                       the closed vocabulary (actions, states, timings)
  errors.cjs                          typed failures with stable codes
  ports.cjs                           the interfaces a host injects
  contract.cjs                        plan §35 execution contract
  criteria.cjs                        plan §36 success criteria
  action.cjs                          plan §6/§16 action contract
  target.cjs                          plan §7/§10 target ladder + revalidation
  world-state.cjs                     plan §5 world state, progress vs evidence
  state-machine.cjs                   plan §51/§52 states and legal transitions
  safety.cjs                          plan §30-§34 gates
  routing.cjs                         plan §29 capability routing
  log.cjs                             plan §39/§40 execution log + screenshot policy
  stabilization.cjs                   plan §8-§13, §23-§25 settle/grace/cooldown
  verification.cjs                    plan §14/§15/§46 three-state verification
  miss.cjs                            plan §17 miss detection
  recovery.cjs                        plan §18/§19/§21/§22 recovery ladder
  stall.cjs                           plan §20/§21 stall detection and ladder
  observer.cjs                        plan §3 structured observation with fault boundaries
  executor.cjs                        plan §2/§43/§52 the closed loop
  isolation.cjs                       plan §37/§38 per-controller fault boundaries
  autonomy.cjs                        plan §49 autonomous continuation
  host-electron.cjs                   the only file that knows about Electron objects
  controllers/                        browser, desktop, vision, shell, file
  drivers/                            cdp-page, win32(+ps1), uia(+ps1), screenshot(+ps1)

app/extensions/mega/ui/computer-use-panel.js   the dock panel (control surface)
scripts/computer-use-acceptance.cjs            real end-to-end acceptance (Electron)
tests/unit/computer-use-*.test.js              the deterministic half
tests/helpers/computer-use-device.cjs          in-process device (browser + desktop)
```

The shell owns the runtime exactly like it owns the Sub-worker manager:
`app/desktop-main.cjs` registers the `computer-use:*` IPC surface, builds the
host bridge on demand, and disposes it on exit. The dock panel only edits a
contract and reads reports; it never drives the machine itself.

---

## 3. Execution contract

```jsonc
{
  "goal": "sign in on the internal console and open the release page",
  "success_criteria": [
    { "kind": "dom_text", "selector": "#status", "text": "Saved" },
    { "kind": "url_matches", "pattern": "/releases" }
  ],
  "allowed_capabilities": ["browser", "desktop", "shell", "filesystem", "vision"],
  "safety": { "destructive_actions": "confirm" },   // allowed | confirm | forbidden
  "limits": {
    "max_steps": 200,
    "max_retries_per_action": 2,
    "max_stall_recoveries": 2
  },
  "vision": { "retention": "failure", "allow_full_screen_fallback": true },
  "autonomy_enabled": false,
  "plan": [
    { "id": "user", "action": { "type": "DOM_TYPE", "target": { "selector": "#username" }, "text": "alice",
                                "expected_effect": { "any": [{ "value_equals": "alice" }] } } },
    { "id": "submit", "action": { "type": "DOM_CLICK", "target": { "selector": "#sign-in" },
                                  "expected_effect": { "any": [{ "text_appears": "Saved" }] }, "timeout_ms": 5000 } }
  ]
}
```

* **Success criteria decide completion.** "The script finished" is not completion
  (plan §36). A contract without criteria is judged by the implicit criterion
  "every planned step ran and was verified"; an empty contract can never report
  success.
* **`confirm`** for a destructive action with no confirmation channel is a
  refusal, not an assumption. The shell supplies a real modal dialog; the IPC
  panel supplies the contract's own callback.
* **Nothing can widen its own contract.** The allowed capabilities are checked
  before every action, and an alternative interaction that would need a withheld
  capability is not offered (plan §35).

---

## 4. Action surface (plan §6 + file capability)

```text
MOVE  CLICK  DOUBLE_CLICK  RIGHT_CLICK          TYPE  KEY_PRESS  HOTKEY
SCROLL  DRAG  FOCUS  SELECT                     OPEN_APP  CLOSE_WINDOW  SWITCH_WINDOW
BROWSER_NAVIGATE  BROWSER_BACK  BROWSER_FORWARD  BROWSER_REFRESH
DOM_CLICK  DOM_TYPE  DOM_SELECT                 ACCESSIBILITY_INVOKE  ACCESSIBILITY_SET_VALUE
SHELL_EXEC                                      WAIT_EVENT  WAIT_STATE
SCREENSHOT_REGION  SCREENSHOT_WINDOW  SCREENSHOT_FULL
FILE_READ  FILE_WRITE  FILE_COPY  FILE_MOVE  FILE_DELETE  FILE_MKDIR  FILE_EXISTS
```

Every action carries `target`, `precondition`, `stabilization`, `expected_effect`,
`timeout_ms` and `retry`. The executor refuses to run an action it cannot
validate, so an upper layer cannot smuggle a raw pyautogui-style script past the
runtime (plan §43).

---

## 5. The loop, step by step

```text
OBSERVE            structured state first: page DOM/URL/focus, windows, foreground,
                   dialogs, file events. Each source has its own fault boundary and
                   its own time budget; a dead source degrades the world state
                   instead of failing the observation.
PLAN               the contract's plan first, then the optional planner hook.
STABILIZE          short forced delay (50-300 ms), then check stability.
REVALIDATE         re-resolve the target and compare: <3 px act, 3-10 px use the
                   refreshed point, >10 px re-observe (never click a stale point).
ACT                route to the cheapest capable channel, then act through the
                   controller that owns it.
POST_ACTION_GRACE  bounded 80-250 ms so a click that needs 120 ms is not a miss.
VERIFY             wait for the expected effect (event-driven, bounded), then
                   return success | failure | unknown.
RECOVER            retry (revalidate first) -> alternative interaction -> replan
                   -> bounded failure with context.
```

Stall detection counts **consecutive actions without meaningful progress** — a
spinner cannot fake progress, and the runtime's own bookkeeping cannot fake it
either. Three in a row enters the stall ladder:

```text
structured re-observe -> window check -> target re-resolution -> targeted screenshot
-> alternative interaction -> replan -> full screenshot -> FAIL_WITH_CONTEXT
```

Capability routing (plan §29):

```text
api  ->  file  ->  shell  ->  dom / accessibility  ->  gui  ->  vision + gui
```

The router also answers "is this channel *suitable*": a DOM click needs a target
that resolved inside a page, a GUI click needs a coordinate, and a vision click
needs the visual level the contract allows.

---

## 6. Perception and vision

Priority is fixed (plan §3.1): structured state, then system events, then
targeted vision, then a full screenshot.

* **Browser:** DOM, accessibility tree, URL/title/loading/revision, tabs, DOM
  modals, JS dialogs — all over CDP.
* **Desktop:** window list, foreground, bounds, process, UI Automation tree. The
  UIA walk crosses process boundaries and is therefore *opt-in per step*: it is
  read for accessibility actions, for a recovery that asked for a full
  re-observe, and once per desktop-only run. Dialogs are still caught cheaply
  from the window list (`#32770` and other dialog classes).
* **Vision levels:** region (1) → window (2) → full (3). The level climbs one
  rung per recovery and a full-screen capture additionally needs the contract's
  permission (plan §22). A *visual target* (`{"visual": {"paint": {...}}}` or a
  template) inside a page is looked for in the page's own viewport capture, and
  the hit is converted device-pixels → CSS-pixels → screen-pixels before a real
  click is issued.
* Screenshots are captured through GDI (koffi, `BitBlt`) or `System.Drawing`
  (PowerShell fallback) on the desktop, and through CDP inside a page.

---

## 7. Safety

| Gate | Behaviour |
| --- | --- |
| §30 modal | A blocking dialog (page modal, JS dialog, `#32770`) pauses the action; the runtime dismisses it with the dialog's **own** control and resumes the original action. It never guesses which button is safe, and it refuses to dismiss dialogs in a loop. |
| §31 focus | Typing requires verified focus: the target must be the focused element, or a verified FOCUS receipt. Otherwise the runtime inserts a FOCUS step instead of typing blind. |
| §32 input | Passwords/tokens are redacted from the action, from the step log and from the world-state summary of *later* steps. The log records `[redacted]`. |
| §33 window | A coordinate click is refused unless the expected window is in front; an unobservable foreground is a refusal, not a guess. |
| §34 destructive | DELETE / FORMAT / INSTALL / PUBLISH … are classified, then allowed, confirmed (host dialog) or refused by the contract. The shell command deny-list is enforced independently. |

---

## 8. Execution log

One JSON line per step (`logs/computer-use/<task>.jsonl`):

```json
{"kind":"step","step":23,"action":"DOM_CLICK selector:#save","channel":"dom","controller":"browser",
 "preState":{"url":"...","controls":12,"notes":["desktop observation timed out after 8000ms"]},
 "stabilizationMs":140,"graceMs":150,"waitMs":62,"result":"success",
 "verification":"text appeared: Saved","verificationKind":"direct","retryCount":0,
 "coordinateFallback":false,"resolvedPoint":null}
```

* A degraded source is part of the step's pre-state: a summary that hid "the
  desktop controller timed out" would hide the reason a step failed.
* Screenshots are written only in debug/audit mode, on a failing run, or when
  explicitly requested (plan §40); otherwise a capture is used and dropped.
* No application profile, no latency model, no user data ever reaches the log.

---

## 9. Running it

### From the dock

Mega dock → **Computer Use**: edit the contract (goal, plan, criteria, limits,
destructive mode, capabilities, autonomy), press **执行** (run) or **单步**
(single step), watch controller health, the live state machine and the step log.
**截图记录** explains whether a capture was retained and why.

### From the code

```js
const { createComputerUseRuntime } = require('./app/computer-use/index.cjs')
const { createElectronHost } = require('./app/computer-use/host-electron.cjs')

const host = createElectronHost({ getWebContents: () => view.webContents })
const runtime = createComputerUseRuntime({ host: host.host, log: { mode: 'normal' } })

const report = await runtime.run(contract)          // full task
const single = await runtime.executeAction(action)  // one action, same machinery
runtime.cancel('user pressed stop')
runtime.health()                                    // controller-by-controller truth
```

Host knobs: `page`/`getPage`, `desktop`, `accessibility`, `screenshot`,
`planner`, `confirm`, `facts` (extra facts for criteria), `workspace`, `clock`.

### Tests

```powershell
cd app; npm test                                  # every unit + architecture gate
node --test ..\tests\unit\computer-use-*.test.js  # just Computer Use

# The ten minimum acceptance cases against the in-process device (deterministic):
node --test ..\tests\unit\computer-use-acceptance.test.js

# The same cases against the real machine (real Chromium, real screen, real input):
node scripts\computer-use-acceptance.cjs                    # all scenarios
node scripts\computer-use-acceptance.cjs browser-form       # one scenario
node scripts\computer-use-acceptance.cjs --list             # what exists
node scripts\computer-use-acceptance.cjs --report out.json  # machine-readable
node scripts\computer-use-acceptance.cjs --stream --progress run.log   # live diagnosis
```

The acceptance harness reports `passed`, `failed` or **`skipped` with the real
reason** — a missing prerequisite is never rounded up to a pass. Every scenario
also has a wall-clock ceiling, so a stuck environment cannot hang the run.

---

## 10. Acceptance: the ten cases (plan §53)

| # | Case | What the runtime must prove |
| --- | --- | --- |
| 1 | Browser form | DOM first, input verified, submission verified, no screenshot needed |
| 2 | Dynamic button | A target that moves is re-resolved; the old coordinate is never clicked |
| 3 | Missed click | "Issued" ≠ "had an effect": the miss is detected and recovered |
| 4 | Unexpected modal | The flow pauses, the dialog is dismissed by its own control, the action resumes |
| 5 | Desktop app | Window + focus verified, text typed through the real keyboard, file verified on disk |
| 6 | Slow UI | A 700 ms effect is waited for by condition, inside a fixed-sleep-free budget |
| 7 | Canvas UI | No DOM node, no AX node: vision finds the painted control and the decoy is not used |
| 8 | Window overlay | A covered target window is not clicked through |
| 9 | Controller failure | A broken vision controller degrades alone; the rest keeps working |
| 10 | Stall | A page that stops responding is detected, recovered, and fails with context |

`tests/unit/computer-use-acceptance.test.js` runs all ten deterministically
against the in-process device; `scripts/computer-use-acceptance.cjs` runs them
against the real machine. `docs/computer-use-acceptance.md` records an actual
run, with the environment, the evidence and everything that was skipped.

---

## 11. Configuration (`config/app.json` → `computerUse`)

```jsonc
{
  "enabled": true,               // false removes the IPC surface entirely
  "autonomyEnabled": false,      // continuous execution through recovery
  "limits": { "maxSteps": 200, "maxRetriesPerAction": 2, "maxStallRecoveries": 2,
              "stepTimeoutMs": 30000, "runTimeoutMs": 1800000 },
  "timing": { "settleMinMs": 50, "settlePreferredMs": 100, "gracePreferredMs": 150,
              "cooldownSoftMaxMs": 400, "navigationCooldownMs": 800, "eventPollMs": 40 },
  "safety": { "destructiveActions": "confirm", "requireForegroundWindow": true,
              "requireFocusForTyping": true },
  "vision": { "retention": "failure", "allowFullScreenFallback": true }
}
```

Per-contract overrides win over these; both are clamped into the documented
bands, so no contract can order a `sleep(5)`.

---

## 12. Environment and honest limitations

Verified on this machine (Windows 11, Electron 43.4.0 / Chromium 150, Node 24):

* Win32 driver: **koffi** FFI (user32/kernel32) with a PowerShell 5.1 P/Invoke
  fallback; window enumeration, focus, move, close, clipboard, cursor, real
  `SendInput` mouse and Unicode keyboard, `openApplication`.
* UI Automation driver: PowerShell 5.1 + `UIAutomationClient`, re-resolvable
  `w:<hwnd>/0.3.2` refs, `invoke`/`setValue`/`focus`/`value`, bounded walks.
* Screenshot driver: GDI capture through koffi (`BitBlt`/`CAPTUREBLT`,
  `PrintWindow`), `System.Drawing` fallback, PNG via the repository's own codec.
* Browser driver: CDP over `webContents.debugger` (or any WebSocket transport),
  real `Input.dispatchMouseEvent`, `Input.insertText`, `Accessibility.getFullAXTree`.

Known limits, stated rather than hidden:

* **Keyboard injection was exercised through the acceptance run** (real Notepad
  typing, Ctrl+S in the editor window) but the *unit* driver suite deliberately
  tests hotkey ordering through an injected sender instead of firing keys at the
  developer's desktop.
* **Windows 11 Notepad hands its window to a broker process.** The desktop
  scenario therefore locates the window by title, and when the broker replaces
  the window mid-run it falls back to the harness's own editor window — still a
  real window, real `SendInput` typing and a file that really lands on disk. The
  report says which application was used.
* A **session-0 / non-interactive desktop** is reported as
  `available: true, detail.interactive: false`; real input there is meaningless
  and the runtime degrades rather than pretending.
* **Absolute pointer accuracy** can be 1 px off on scaled multi-monitor layouts;
  coordinates are re-validated before a click, so a 1 px error is inside the
  "stable" band and the target is re-resolved rather than missed.
* **UI Automation is slow** on a loaded desktop (seconds per walk). That is why
  the AX walk is opt-in per step and why a source that exceeds its budget is
  reported as unavailable instead of blocking the run.
* `captureFull()` returns the **virtual screen**, not the primary monitor.
* A page-hosted visual target is mapped device → CSS → screen pixels using the
  page's own `devicePixelRatio` and screen origin; the mapping is verified by the
  canvas acceptance case, and a page whose zoom differs from the device scale
  would need `visual.level` set explicitly.

---

## 13. Long-running execution (Update-Plan/24h.md Tasks 1–20)

The ten acceptance cases prove a *task* can finish. They do not prove an executor
can run for hours, which is a different failure mode: nothing crashes, the state
quietly drifts, and every later step is built on a false assumption. The
long-running modules exist for that second question, and each one has a rule it
enforces rather than a heuristic it applies.

**Focus trust after verification (Task 1).** An *attempted* focus is not a
*verified* focus. Typing is authorized only by a verification that succeeded —
`failure` and `unknown` clear the reference, and so does a window change, a
navigation, a detached target or a failed/unknown verification. "We could not
tell" is never permission to type.

**Modal fail-safe (Task 2).** A dialog's controls are classified before anything
is pressed: safe dismiss, neutral acknowledge, positive confirm, destructive, or
unknown. Dismissing is always preferred because it is the only class that cannot
change anything outside the dialog, and a destructive label is matched *before* a
safe one ("Delete and close" is destructive). A destructive confirmation is
pressed only when the contract allows it **and** the action declared that effect
**and** the safety gate passed; anything else is `USER_ACTION_REQUIRED`. When no
control can be classified the runtime asks the user — it never presses "the first
button". A bland label can still be destructive: a dialog whose message says
"Delete this file?" makes the confirmation destructive.

**Adaptive bounded stabilization (Task 3, Task 16).** When an action may run is
decided in one place, from the current step's own state only: the UI is changing,
the target moved, a previous miss, a window change, an animation, a pending
navigation, a modal, or a detached target. The cooldown is the minimum plus one
bounded step per signal, capped at the soft ceiling; a pending navigation jumps
to the navigation budget; past the ceiling the caller must use a conditional wait
instead of sleeping. The forced minimum can never overshoot the action's own
maximum. No application latency profile exists anywhere in the runtime.

**Evidence grading by action risk (Task 4).** A verification's *verdict* is
graded by how directly it observed the intended effect — strong, medium, weak —
and the grade has to clear the bar the action's own risk sets. `TYPE` needs value
equality, `SAVE` needs file evidence, `DELETE` needs authorization plus the target
gone, `SEND`/`SUBMIT`/`PUBLISH` need a specific success state, and a generic
low-risk click accepts a local state change. Weak evidence cannot satisfy a
high-risk action, and a critical action must declare its expected effect before
it may run at all; otherwise it is reported as unverified rather than successful.

**Meaningful progress (Task 5).** `lastProgressAt` moves only for progress that
proves the world changed: a verified effect, a completed subprocess, a verified
filesystem operation, a state transition, or a satisfied criterion. A heartbeat
never counts, an issued action never counts, and a `direct` world-change verdict
is explicitly refused as progress — it is exactly what a spinner produces
forever. Repeated no-ops are counted rather than smoothed away.

**The bounded stall ladder (Task 6).** The eight rungs are defined once, in
`stall.cjs`: structured re-observe → window check → target re-resolution →
targeted screenshot → alternative interaction → replan → full screenshot →
`fail_with_context`. The recovery module reports the same ladder instead of
carrying its own copy, escalation is bounded by `maxRecoveries`, and the ladder
never loops back to rung one.

**Owned-process supervision (Task 7).** Builds, test runs, linters, dev servers,
package managers and git are registered with pid, command, cwd, start time,
ownership, expected lifetime and status. A foreground process that outlives its
budget is detectable as hung; an intended dev server is not. The runtime kills
only what it started, the owned count has a ceiling, and shutdown disposes
everything it owns.

**Resource ceilings and screenshot retention (Task 8).** Screenshot records, the
caller's observation ring and the evidence byte total are all bounded. Transient
diagnostics are evicted before failure evidence, and the capture that explains
why a run stopped is retained — a long run must not accumulate a visual history
of everything it ever saw.

**Controller fault isolation and bounded reconnect (Task 9, Task 10).** A broken
controller degrades alone: the rest of the runtime keeps working, and an action
that needs a missing capability reports `CAPABILITY_UNAVAILABLE` for that action
rather than crashing the run. A transport failure marks the channel degraded and
spends a *per-step* reconnect budget; backoff is capped, a stale target is never
reused, and exhausting the budget reports `RECONNECT_EXHAUSTED`. A non-transport
error (a stale target, a capability the contract withheld) is not retried as a
reconnect.

**Verified workspace continuity (Task 11).** Every shell and file operation
carries a resolved cwd that was checked against the verified workspace boundary.
A relative path with no verified workspace is refused, a path outside the root is
refused unless the contract allows it, and drift is reported as a mismatch. A
workspace that has become inaccessible is reported as unavailable and blocks —
never silently replaced by the system's current directory.

**Verified filesystem mutations (Task 12).** A write is checked against the
disk: the file exists, its content reads back as written, its mtime moved and its
size matches what the controller reported. A copy is checked against its source's
size, a move needs the source gone *and* the destination present, a delete needs
the target absent, and a mkdir needs the directory to exist. An unverifiable
mutation is a failure, not a success.

**The bounded command contract (Task 13).** Every shell action states its
command, cwd, timeout, expected exit, output capture and process mode. Missing
values fall back to bounded defaults and an over-long timeout is clamped, so
"just run this" can never become an unbounded wait. A caller-declared mode always
beats the inferred one, and the verdict maps onto the runtime's own
`STEP_RESULTS` vocabulary.

**Resume-safe step boundaries (Task 14).** If the runtime restarts with a
mutation's outcome unknown, the first thing it does is re-observe the effect and
answer `already_complete`, `retry` or `failed` — never replay a half-finished
write. Clock skew inside the documented window is tolerated, so an mtime that has
not moved *yet* is not misread as a failed write.

**Executor, stabilization and recovery responsibility split (Task 15, Task 16,
Task 17).** The executor keeps orchestration, state transitions and controller
selection; the cooldown math, the modal label tables, the verification matching
and the stall ladder live in their own modules and have exactly one definition
each. Recovery answers with a closed five-word vocabulary — `RETRYABLE`,
`ALTERNATIVE_AVAILABLE`, `REPLAN_REQUIRED`, `USER_ACTION_REQUIRED`, `FAILED` —
and is a *report*: it never edits the goal, the criteria or the plan.

**Log hygiene (Task 18).** The execution log rotates by size with a bounded
number of files. Every line carries `runId`, `taskId`, `stepId`, `controller`,
`action`, `verdict`, `duration`, `retry` and `reasonCode`; repeated identical
events are summarized after a small limit instead of being rewritten; the
screenshot record ring is bounded; and errors, terminal evidence and important
recovery events survive rotation.

**The self-health snapshot (Task 19) and failure containment (Task 20).** The
runtime reports `healthy`, `degraded` or `blocked` together with its
capabilities, `lastProgressAt`, `activeOwnedProcesses` and `currentStep`. A
single failed action is not a fatal task and a single failed controller is not a
fatal runtime — those degrade. The runtime blocks only when no correct action
exists: the workspace is unavailable, every required capability is gone, safety
authorization is unavailable, a resource ceiling was reached, or state integrity
is uncertain. When it cannot vouch for its own state it stops rather than
guesses.

---

## 14. Non-goals (plan §42)

No app-specific learning, no latency learning, no reinforcement learning, no
user-behaviour modelling, no record-and-learn, no long-term accumulation of
anything observed. The runtime adapts to the current state and forgets.
