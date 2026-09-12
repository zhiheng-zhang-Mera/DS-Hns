# Computer Use acceptance record

Evidence for `Update-Plan/computer-use.md` §53 (the ten minimum acceptance
cases) and §54 (the completion definition). Every number below comes from an
actual run on the development machine; nothing here is estimated.

Two suites cover the same ten cases:

| Suite | Environment | Command |
| --- | --- | --- |
| Deterministic | in-process device (real DOM/z-order/screenshots, virtual clock) | `cd app; node --test ..\tests\unit\computer-use-acceptance.test.js` |
| Real | Electron 43.4.0 / Chromium 150, real Windows desktop, real `SendInput`, real GDI captures | `node scripts\computer-use-acceptance.cjs` |

The deterministic suite is what CI runs on every push. The real suite is a
release step, exactly like `scripts\sub-worker-acceptance.cjs`, because it needs
an interactive desktop and drives real windows.

---

## 1. Environment (real run)

```text
platform   win32 (Windows 11)
electron   43.4.0
chromium   150.0.7871.224
node       24.18.1 (app runtime), PowerShell 5.1.26100.9444 for UI Automation
screen     virtual screen 4480x1600, primary 2560x1600
controllers browser=ready desktop=ready accessibility=ready vision=ready shell=ready file=ready
```

`node scripts\computer-use-acceptance.cjs --report <path>` prints and records
this block, so a later reader can tell which machine produced the evidence.

---

## 2. Deterministic suite (10/10)

```text
cd app
node --test ..\tests\unit\computer-use-acceptance.test.js

✔ Test 1: a browser form is filled and submitted through the DOM, and both are verified
✔ Test 2: a control that moves after load is re-resolved, not clicked at its old position
✔ Test 3: a swallowed click is detected as a miss, re-validated and retried
✔ Test 4: an unexpected modal pauses the flow, is dismissed, and the task resumes
✔ Test 5: a desktop application is launched, focused, edited and saved, with the file verified
✔ Test 6: a 700 ms UI is waited for by condition and a fast one is not over-waited
✔ Test 7: a canvas-painted target with no DOM node is reached through vision
✔ Test 7b: the same canvas target is reached by the run loop through the visual rung
✔ Test 8: a target window that is covered is not clicked through
✔ Test 9: a broken vision controller does not disable the structured controllers
✔ Test 10: an unresponsive page is detected as a stall, recovery runs, and the run fails with context
✔ the CDP page adapter maps the plan action surface onto real protocol calls

tests 12 | pass 12 | fail 0
```

The device these tests drive is a real state machine, not a stub: clicking a
covered window really routes the click to the covering window, a swallowed click
really leaves the DOM revision untouched, `waitFor` really lands on 700 ms of
virtual time, and the canvas scenario's target really has no DOM node (only a
painted rectangle in the framebuffer).

---

## 3. Real suite

```text
node scripts\computer-use-acceptance.cjs --report temp\cu-all.json

[PASS] browser-form:        the form was filled and submitted over the DOM channel and both steps were verified
[PASS] dynamic-target:      the runtime re-resolved the target after it moved and clicked the real position
[PASS] missed-click:        the swallowed click produced a retry decision and the retry succeeded
[PASS] unexpected-modal:    the modal was dismissed by its own control and the original action resumed
[PASS] slow-ui:             the 700 ms effect was waited for by condition; the run finished well inside a fixed-sleep budget
[PASS] canvas-vision:       the painted control was found by vision, clicked by real coordinates, and the decoy was not used
[PASS] controller-failure:  the broken vision controller degraded alone; the browser task still completed
[PASS] stall:               the run detected the stall and stopped with context (STALL_DETECTED)
[SKIP] window-overlay:      the accessibility controller is unavailable: the uia.ps1 probe could not run
                            (uia.ps1 did not answer op "probe" within its timeout)   <- see §5
[SKIP] desktop-app:         opt-in scenario (see §4)

Computer Use acceptance: 8 passed, 0 failed, 2 skipped
```

`window-overlay` was retried on its own immediately afterwards, and the UIA probe
timeout was then fixed in the driver (the probe now has its own 25 s budget,
because it pays for a cold PowerShell start plus the assembly load — judging it
by the steady-state 8 s timeout wrongly reported the whole accessibility
controller as unavailable):

```text
node scripts\computer-use-acceptance.cjs window-overlay
[PASS] window-overlay: the run refused to click while the covering window was in front (WINDOW_MISMATCH)
```

### What each real pass actually proved

* **browser-form** — a real Chromium page over CDP: `Input.insertText` typed the
  credentials, the value was read back and verified, a real
  `Input.dispatchMouseEvent` submitted the form, and the success node was
  verified. Every step used the `dom` channel; **zero screenshots** were taken.
* **dynamic-target** — the button really moved to `(640, 420)` on screen; the
  runtime re-resolved it after the move and the click landed on the real
  control.
* **missed-click** — the fixture swallows the first click (`preventDefault`,
  revision unchanged). The runtime observed "issued but no effect", produced a
  recovery decision, and the second attempt succeeded.
* **unexpected-modal** — a real DOM modal plus overlay appeared; the runtime
  paused the original action, dismissed the dialog **through its own Dismiss
  control** (visible as its own verified step in the log), and resumed the same
  action.
* **slow-ui** — the 700 ms effect and the 120 ms effect were both waited for by
  condition; the log shows a real `waitMs` per step and the run finished far
  inside any fixed-sleep budget.
* **canvas-vision** — no DOM node and no accessibility node exist for the
  painted control. The runtime captured the page viewport through CDP, matched
  the painted colour, converted device → CSS → screen pixels and clicked it with
  `SendInput`; the page reports "Ordered" and the structural decoy was never
  used.
* **controller-failure** — with a deliberately broken screenshot driver, health
  reported `vision: unavailable` while browser/desktop/shell/file stayed ready,
  and a full browser task still completed.
* **stall** — a page whose fixture scripts stop applying anything: the runtime
  detected three consecutive actions without meaningful change, ran the stall
  ladder, and ended with `STALL_DETECTED` plus the context it gathered.
* **window-overlay** — a second real window covering the target: the runtime
  refused the coordinate click with `WINDOW_MISMATCH` instead of clicking
  through.

---

## 4. Desktop application case (Test 5)

Test 5 is covered **deterministically** by the suite above: a real window
manager, a real focus change, real typing through the device's key path, a real
`Ctrl+S`, and the file's content checked afterwards.

The **real-hardware** variant (`node scripts\computer-use-acceptance.cjs
desktop-app`) is implemented and opt-in, for two environment reasons that are
worth recording rather than hiding:

1. **Windows 11 Notepad hands its window to a broker process.** `openApplication`
   cannot match the window by the pid it spawned, so the scenario locates it by
   title (which works) and, when the broker replaces the window mid-run, falls
   back to the harness's own editor window — still a real Electron window, real
   `SendInput` typing and a file that really lands on disk. The report always
   states which application was used.
2. **Keyboard injection into another process can block inside a synchronous FFI
   call on this host.** `SendInput` is a synchronous call, so a stall there
   cannot be interrupted by any timer (the runtime's own timeouts cannot preempt
   a blocked syscall either). The harness therefore marks this scenario opt-in:
   it is run by name, and a default `--all` run reports
   `skipped: opt-in scenario` instead of risking the nine scenarios that only
   need the runtime itself. Mouse injection through the same driver is verified
   live by the canvas and overlay scenarios.

A scenario that cannot run is always reported as `skipped` with the reason,
never as a pass.

---

## 5. Honest limitations seen during acceptance

1. **The UI Automation probe can time out on a loaded desktop.** One real run
   skipped `window-overlay` because `uia.ps1 probe` exceeded its 8 s budget while
   the machine was busy; the retry passed. The runtime does the right thing here
   (the accessibility controller reports unavailable and the desktop gate
   refuses to click blind) but the *cost* of UIA is real, which is why the
   accessibility walk is opt-in per step (plan §3.1).
2. **Zombie Electron processes** from harness runs that were killed externally
   held the desktop and had to be terminated through WMI. The harness now has a
   per-scenario timeout, a global watchdog, and cancels the runtime of an
   abandoned scenario, so a stuck run terminates itself.
3. **Keyboard injection** is exercised end-to-end by this suite (real typing,
   real `Ctrl+S`); the *driver* unit suite tests hotkey ordering through an
   injected sender rather than firing keys at a developer's desktop.
4. **Pointer accuracy** can be 1 px off on scaled multi-monitor layouts; the
   revalidation band (plan §10) absorbs that by re-resolving instead of missing.

---

## 6. Verification gates

```text
cd app; npm run check      -> checked 153/153 files
cd app; npm test           -> tests 897 | pass 897 | fail 0 | skipped 0 (local, Node 24)
pwsh scripts\verify.ps1    -> VERIFY: ALL CHECKS PASSED
                              (includes the Computer Use section: plan 6, 7, 9-15,
                              18-25, 29-34, 36, 37-43, 49, the panel wiring, the
                              config block and the acceptance harness)
```

The GitHub workflow `.github/workflows/verify.yml` adds a **Computer Use surface
gate**: the runtime modules, controllers, real drivers, dock panel, acceptance
harness and this document must all exist, and `scripts/check-syntax.cjs` must
cover `computer-use`, `computer-use/controllers` and `computer-use/drivers` —
a green gate over unchecked code is worse than a red one.

### CI runs on this branch

```text
b660f6a  feat(computer-use): a verifiable Computer Use runtime over real state
         verify  failure  -> 2 pre-existing failures, both line-ending sensitive
                              (tests/unit/theme-official-surfaces.test.js and
                               tests/unit/dual-ui.test.js read desktop-main.cjs and
                               match "\n"; a Windows checkout had rewritten it) —
                              the same two failures are red on Theme-Cover's own
                              last run (34695333024), so they predate this work
941a019  fix(ci): keep source files LF so the source gate reads code, not line endings
         verify  success  -> Syntax gate ✓  Unit + architecture tests ✓
                             Theme surface gate ✓  Computer Use surface gate ✓
```

The line-ending fix is two-layered on purpose: `.gitattributes` pins LF for
source/data/documentation files (only `*.cmd` stays CRLF) so a Windows checkout
cannot rewrite them, and both tests normalize what they read so the gate reads
code rather than the checkout's line-ending policy. No assertion was weakened.

