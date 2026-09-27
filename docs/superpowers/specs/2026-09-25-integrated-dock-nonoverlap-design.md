# Integrated Dock Non-Overlap Design

## Problem and evidence

At the qualified 1472 px content width, the official first-run Continue control occupies x=888..1008 while the expanded dock begins at x=912. The 96 px intersection is a real click-target overlap. The current official UI is the `BrowserWindow`'s own document, so changing only the dock's x-coordinate does not reserve space in that document.

The pinned DSH layout dependency collapses its sidebar below 1024 px. Preserve that breakpoint with an 8 px margin: the official child view must be at least 1032 px wide. The dock's declared minimum expanded width is 440 px. Therefore expanded side-by-side mode needs a 1472 px content area; at the current 1472 px host size the correct geometry is official=1032 px and dock=440 px.

## Decision

The first implementation used a visible `WebContentsView` child under a `BrowserWindow` whose own page still rendered the startup skeleton. A fresh Codex screenshot showed that skeleton after boot, despite the official child being attached, visible, loaded, and reporting the correct bounds. This is not acceptable visual evidence. Electron documents `BaseWindow` as the flexible host for composing multiple web views; use it for the integrated mode so the shell, official renderer, and dock are all explicit sibling `WebContentsView`s rather than placing a child beneath the BrowserWindow's built-in page.

In integrated mode, create a backmost shell view first, load the inert startup skeleton there, and expose that view's `webContents` through the existing `mainWindow.webContents` compatibility property. Create and load the official renderer before attaching it so the startup skeleton stays visible during network startup; after successful load, attach the official view above the shell and keep it attached, visible, and never parked or hidden for the whole session. Attach the dock as a sibling above the shell, in a disjoint right rectangle. The non-integrated path and auxiliary windows remain `BrowserWindow`. Keep shell IPC process-owned by `ipcMain`, and preserve the shell webContents compatibility surface for existing main-process consumers.

The official child owns the left rectangle; the dock owns a disjoint right rectangle. Hiding the dock gives the official view the full content rectangle. Do not inject scripts/styles into the official renderer.

Add a pure layout function with explicit inputs and outputs. Expanded layout clamps the dock to its declared 440..720 px range and the remaining width after the 1032 px official minimum. If there is not room for both minimums, return an explicit blocked/hidden layout with the entire width assigned to the official view. A collapsed rail is only shown when the official view still meets 1032 px. At narrow window sizes, no portion of the dock may cover the official page; an explicit expansion request that cannot fit is rejected and reported to the user.

Use the existing wallpaper click-through BrowserWindow path. Do not add an input-catching WebContentsView above the official renderer. Leave the official renderer unmodified. Continue routing agent control, focus observation, keyboard shortcuts, and extension `officialWebContents` to the official child renderer; keep shell-owned IPC (including the dock layout event) on the shell view's compatibility webContents and `ipcMain`.

## Invariants

1. Official and dock rectangles have zero intersection in every shown layout.
2. Shown expanded dock width is at least 440 px; official width is at least 1032 px.
3. At 1472 px content width with a 560 px request, the dock is clamped to 440 px and the official view remains 1032 px.
4. At insufficient width, official gets the full content width and the expanded dock is not visible; the refusal is observable, never silent.
5. The official view remains attached, visible, loaded, and within the content bounds during dock show/hide/resize transitions.
6. The visible integrated host uses `BaseWindow`; no BrowserWindow-owned renderer can cover the composed views.
7. The startup skeleton remains visible until the official renderer loads, then the official first-run controls are physically visible and clickable.
8. No shell IPC wiring is accidentally redirected: official-renderer consumers use `officialView.webContents`, and shell-owned consumers retain the shell view's compatibility `webContents`.
9. Existing wallpaper remains click-through; no new topmost view captures official clicks.

## Verification and rollback criteria

Start with unit and direct acceptance RED evidence, then implement the minimum geometry/view-routing change. Verify unit/layout contracts, machine gates, production-like package, and an isolated real launch. Use Codex's visible computer-use surface to inspect screenshots and complete startup, dock, official conversation, first-run, and dock-hide journeys. Re-run all qualification gates after any repair. If the official view still blanks, a first-run control is covered/unreachable, shell or official IPC is misrouted, or any view is hidden/parked to work around a compositor defect, revert this architecture and report the blocker rather than weakening a gate.
