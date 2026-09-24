# FQ-CU-006 — uncontrolled desktop test and duplicate root results

Cleanroom run `2026-09-23T07-38-35-054Z-02f3b4b8` tested commit `5afb25ca07c23d5535301d8ad9a504a6d108a80d`, tree `746892de77cc4abf0ae0a024cd1d881524cbdd5c`. Both all-unit-tests and architecture-verifier failed the real UIA find test with `CONTROLLER_TIMEOUT` / `SIGTERM` (12283.8327 ms and 12382.7979 ms). The whole run is FAIL with two mandatory failures; its other fifteen gates, including UI131/131, combined52/52, storage/process audits and evidence consistency, do not override that result.

The test chose an arbitrary user window (`listWindows()[0]`) and requested up to five matches, while asserting only at least one. A successful root match therefore still entered a synchronous foreign-provider subtree call. Deadline checks cannot interrupt that native call; the outer process timeout correctly failed closed. The historical test did not record the selected target, so the exact foreign window and blocking UIA call are **unproven**, not attributed to any particular user application.

The replacement uses an owned, bounded-lifetime WinForms window, records its PID/handle, scopes search to that process, retains limit5 and the unchanged production timeouts, and requires the root plus four distinct real descendant references. No input is sent to other desktop applications. A separate child-only name verifies searching beyond the root even when it does not match; limit1 verifies the root-first path. Fixture teardown waits for its exact child process to exit. A60-second fixture timer is a parent-crash backstop, not a relaxed UIA timeout.

This stronger test exposed a separate production defect: the root-first fast path added the root, then `FindAll(Subtree)` returned it again. The same ref consumed two result slots and hid the fourth child. Valid RED: `uia-owned-window-red-3.log`, expected five unique refs, observed four. Repair changes that subsequent native query to `Descendants`; no retry, timeout increase, skip, or early-success fallback was added. Focused GREEN: `uia-owned-window-green-2.log`, one real-window test passed including all three queries, zero skipped,8922.7694ms total.

Earlier fixture diagnostics are retained, not called product RED: the hidden process startup suppressed the first form display; the fixture now explicitly re-shows its own form from its event loop. The host provider describes WinForms controls as panes, so coverage asserts real descendant refs rather than assuming an upstream role mapping.

Pre-commit full regression: `npm --prefix app test`,1938 tests,1936 passed,0 failed,2 previously explained absent-external-sample skips,460598.9124ms; the owned UIA case passed inside it in10432.9562ms. Raw log: `D:/Hns-Final-Qualification/uia-owned-window-full-regression.log`. Changed JS/CJS Node syntax checks, both PowerShell AST parses, and paper catalog validation also passed. These are repair regression results, not a new cleanroom or production certificate. New committed-candidate qualification remains required.

## Preserved negative evidence

Five original files are byte-identical under `history/5afb25ca07c23d5535301d8ad9a504a6d108a80d/2026-09-23T07-38-35-054Z-02f3b4b8/`. Original absolute paths in the summary are intentionally unchanged. This is a subset archive, not a self-contained rerunnable qualification or a new run.

| File | SHA256 |
| --- | --- |
| qualification-summary.json | fdcac58ea694bba4e8c300597f4af6c967821810658b7aee1fdd1b59c6934a67 |
| raw/all-unit-tests.stdout.txt | 16058f3557495f2264933aadf60286c962d03c41c19251e72fd970a80c21395e |
| raw/architecture-verifier.stdout.txt | 9812dd042488fb8f10593cb2d4fe0cf685f3714f600b69e7bd2296a60c03c98c |
| results/all-unit-tests.json | c4bd54f53e8df70baacab183c986bfc117d311db2d63004046c8879531b2e6fe |
| results/architecture-verifier.json | 1f9c0b9597b95beaba26faca19a5b16e4ba95d50cd59795d639f9106925d59df |
