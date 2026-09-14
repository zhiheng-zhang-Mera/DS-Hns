# Frontend: the official renderer, and the removal of Daily

DS-Hns used to ship **two frontends in one window**: a native HNS chat workspace called
*Daily* (the default) and the official DeepSeek Harness Web UI called *Work*, with a mode
state machine between them, a synchronisation layer that tried to keep the two views on the
same session, and a dock panel offering the switch.

**Daily has been removed.** The official renderer is the product's frontend — not one of
two — and the application boots straight into it. This document records what was removed,
what replaced it, and why.

## 1. What the window contains now

```text
DS-Hns Main Window
│
├── official_renderer   the window's own page   ← the official @deepseek-ai/dsh Web UI
├── official_shell      WebContentsView         ← the frame drawn around it (outer band only,
│                                                  input-transparent, no script)
├── official_overlay    WebContentsView         ← the theme overlay (input-transparent)
└── hns_native dock     WebContentsView         ← the Mega control centre (right-hand strip)
```

The official renderer **is the window's page** rather than a sibling view. That was already
true before the removal, for a reason worth keeping written down: a sibling view that is
meant to be hidden is still drawn (so the wrong frontend showed through), and a sibling that
was moved out of the window comes back without a compositor surface (so the page was blank).
Making the official UI the window's own page removed both failure modes at the cost of the
second frontend ever sharing the rectangle.

## 2. What was removed

```text
app/native-ui/**                     the 16-file native frontend (views, components, themes)
app/frontend-mode/state.cjs          the durable mode + per-mode session store
app/frontend-mode/manager.cjs        the mode state machine and renderer visibility
app/frontend-mode/sync.cjs           Daily <-> Work session synchronisation
the native WebContentsView           in app/desktop-main.cjs
createNativeFrontendView/...         the view, the theme adapter and the mode adapter
registerNativeModeIpc()              hns:native-mode, -set-mode, -toggle-mode, -failure,
                                     -regions, -diagnostics
the native data plane                hns:native-snapshot/-create-session/-select-session/
                                     -send/-cancel/-theme/-update-settings/-pick-workspace/
                                     -rename-session/-delete-session
mega:mode-snapshot/-set/-toggle/...  the dock's mode surface, kept only as mega:compatibility
the Interface Mode dock panel        and the collapsed rail's H/N mode switch
DSH_FRONTEND_MODE                    the per-run startup-mode override
scripts/dual-ui-acceptance.mjs       the dual-UI acceptance run
```

What survived is the part the dock actually reads, and it is still called the *frontend
runtime*: `frontend-mode/backend.cjs` (the Harness bridge), `adapter.cjs` (the domain model
the dock renders sessions and tasks from), `model.cjs` (that vocabulary) and `probe.cjs` (the
DSH compatibility probe). The directory keeps its historical name; nothing in it has a mode
any more.

## 3. Why

* **Two frontends meant two of everything.** A session could be shown in one and remembered
  in the other, a theme had to be applied to both, and every feature had to decide which
  surface it was for. The mode switch was the largest single source of "which UI am I looking
  at?" bugs in the product, and it existed to serve a frontend that was never the official
  one.
* **The official renderer is not ours to drive.** The native frontend existed partly to
  re-skin and re-arrange a UI whose contract DS-Hns does not own. Keeping it meant keeping a
  second implementation of the session model beside the official one, and a compatibility
  probe whose verdict depended on which one was on screen.
* **The work that mattered continued elsewhere.** The dock panels, the scheduler, the plugins and
  the theme engine all live on the HNS-owned surfaces that remain. The dock itself is frosted
  glass and is never skinned: the `hns_native` theme surface id still names it in the surface
  model, and the engine paints the two surfaces DS-Hns draws around the official renderer — the
  official shell and the input-transparent overlay — instead.

## 4. What the compatibility probe reports now

The probe used to answer per frontend (`nativeFrontend`, meaning "can the native frontend
still be driven by this DSH build?"). It now reports one verdict named **`frontend`**, and
the rule is unchanged: any `blocked` check blocks the upgrade, any `changed` check holds it
for review, and a blocked verdict never stops the product — the installed Harness stays and
the official renderer keeps working, with the repair items becoming a compatibility task.

## 5. How this is kept true

`tests/unit/official-frontend.test.js` sweeps every shipped source file for the removed
vocabulary (`nativeView`, `native-ui`, the mode modules, `MODE.DAILY`, `mega:mode-`,
`hns:native-`, `modePanel`, `applyFrontendVisibility`, the mode adapters, `DSH_FRONTEND_MODE`)
and asserts the positive end state: the removed files are gone, the runtime exports no mode,
the shell shows the official view without a parking rectangle, the dock has no mode control,
and this document records the decision.

A deletion of this size is only trustworthy if something fails when a reference survives,
because the dangling references are exactly the ones no unit test exercises: an IPC handler
nobody calls yet, a view the shell no longer creates, a channel the preload still invokes.
That sweep is the check, and it is what the surface gate repeats for the directories.
