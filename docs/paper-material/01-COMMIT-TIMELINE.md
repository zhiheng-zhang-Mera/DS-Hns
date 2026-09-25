# Commit timeline and logical lineage

## Method

History was inspected with `git log --all`, graph/merge-base queries, `git show`, branch ancestry, tags, and stable patch IDs. Merge commits preserve provenance but are not counted as separate contributions. The following patch-equivalent pairs are one logical change each:

| Original | Integrated copy | Stable patch-id |
|---|---|---|
| `22b3261` | `db5ebab` | `def35337e01da733c0cf71c27cfa7044e123902d` |
| `7969807` | `d44d835` | `159b5d64731e6283a7f134d5dc950dbaa4506c64` |
| `791773d` | `9417ca8` | `35c8c23d2948bc3fb0676a340d4839675337605a` |
| `96c571f` | `16d722c` | `0199c249a0c9575db6327b320f4a3e5923a49708` |
| `d76dc3d` | `1965f33` | `90187c443e10db04b03577f57917487d16b39ac2` |

## Timeline

| Date | Phase | Representative commits | Evidence-bearing change |
|---|---|---|---|
| 2026-09-07 | Alien rebuild | `4eeb491`, `026e613`, `2b26890` | Alien shell baseline, optional Mega layer, architecture contract. |
| 2026-09-08 | startup/runtime ownership | `2b4fc26`, `d657412`, `40c01e0` | authenticated handshake and owned-orphan recovery. |
| 2026-09-10–12 | supervised execution | `e783ba0`, `736762a`, `367baf3` | task lifecycle, optional worker, adaptive multi-process execution. |
| 2026-09-13–15 | pluginization and operator UI | `b1dee06`, `74c3961`, `400f3ed`, `e15385f` | plugin workbench, governed bridge, Mega host/client split, official-slot UI. |
| 2026-09-14 | official UI protection | `784db3f`, `8ad0dbb`, `66e371a` | official renderer becomes sole frontend; dock stays glass; wallpaper moves to click-through window. |
| 2026-09-14–16 | real community installation | `1b0a550`, `9bddc34`, `9035cf4`, `3490437` | registry/channel correction, real activation, profile materialization, installer choices. |
| 2026-09-16 | heterogeneous adapters | `db5ebab`, `d44d835`, `9417ca8`, `16d722c`, `1965f33` | format-neutral manager, controlled Cordis bridge, managed process, native HNS, one install pipeline. |
| 2026-09-17 | long-host governance | `572bf52`, `45a66d9`, `f009619`, `ec79430`, `432cf43` | health/restart authority split, fault isolation, continuity/admission, chaos and UI acceptance. |
| 2026-09-20 | runtime/UI separation | `532f805`, `d0b02e0`, `0d4ada9`, `5a34f30`, `923f529` | per-instance identity, desktop as Runtime Host client, single-host rule. |
| 2026-09-21–22 | Integration RC | `dba5f3d`, `137523b`, `974072e`, `2ae08a7` | selective integration, isolated launch repair, visual RC and C-drive fail-closed gate. |
| 2026-09-22 | Final Qualification | `277ef17` through `be743a7` | D-only roots, installer reconciliation, Phase C repair, P2 UI repairs, immutable evidence runner, clean-room fixture materialization. |

All dates are repository author dates. They describe engineering sequence, not independent experimental replications.

## Qualification follow-up snapshot (2026-09-23)

Remote refs were refreshed at candidate `1a2fa2c`;340commits are reachable, versus326in the original mining snapshot. The14additional commits have14distinct stable patch IDs. This finite snapshot does not count the commit containing this refresh or any future production merge.

| Commits | Observed follow-up | Boundary |
|---|---|---|
| `734bc64`, `1c7d338`, `bf2c9dc` | paper corpus, isolated profile wiring assertion, final evidence contracts | catalog/contract work, not new runtime contributions |
| `f03cc37`, `e32d55d`, `80ffe0e` | live PID handoff, canonical Windows paths, recovered-process readiness | preserve old failed runs; focused checks are not full qualification |
| `f90660b`, `9e7404d` | refuse recovery after failed verification; preserve negatives and unknowns | prevents false success; no real reboot claim |
| `9989ea7` | direct-test scratch containment and broader C-write detection | historical C-write failure remains recorded |
| `c20e6f5`, `7afe8bc` | actual orb click repair and unambiguous local scheduling labels | observed interaction, not an unconstrained UI rewrite |
| `231fd7f` | retract unsupported host-policy attribution | NOT_RUN must state observed prerequisites, not an invented prohibition |
| `9900555` | packaged built-in modules included in tarballs | real installation is not proof of real launch |
| `1a2fa2c` | targeted native input replaces broad-title global keystrokes | actual operator input plus catalog/disk evidence; no fallback PASS |

The subsequently observed UI-precondition and Debugger-listener failures are documented in `artifacts/qualification/POST_PICKER_UI_FOLLOWUP.md` and `artifacts/qualification/ELECTRON_LISTENER_FOLLOWUP.md` and in negative entriesN27/N28. Repairs are independently committed as `65121f1` (dock/focus preconditions) and `2d76ca3` (native listener lifecycle). Reading their actual diffs extends the cutoff to342reachable commits at `2d76ca3`; their stable patch IDs are recorded separately from the earlier340commit snapshot. The first listener repair's failed full regression is retained, followed by1930pass/0fail/2definedskip and a real dirty/UI-only131/131 diagnostic, not final qualification.

## Final-qualification follow-up snapshot (2026-09-24)

At the `dafd3bf` candidate, `git rev-list --all --count` returned 364 reachable commits. The 24 commits after `1a2fa2c` were read in order with `git log` and their changed-file summaries. This is a fixed historical snapshot, not a claim about future production merge commits. The two repairs above are included in the 24, not added again.

| Logical follow-up | Commits | Evidence and limitation |
|---|---|---|
| Desktop input, close and reconnect | `65121f1`, `1068527`, `997345f`, `1f901d0`, `e9d8232` | Post-picker focus, detached Runtime on window close, exact-instance reopen and PureAlien dock disable. Original native stderr is retained; these are not real reboot data. |
| Computer Use ownership and diagnostics | `2d76ca3`, `cc3d909`, `7fef904` | Debugger listener lifecycle, owned UIA roots and CI failure retention; owned fixtures do not establish universal desktop compatibility. |
| Orb and service boundary | `491c4fd`, `174318d`, `42b48b9`, `fe436c2`, `dafd3bf` | Orb ownership/hover geometry, service-action contracts and named health routing. The `dafd3bf` clean-room Journey later observed native Orb click, expansion and panel feedback; private account captures are not public artifacts. |
| Health, restart and policy lifecycle | `545462a`, `4a823ae`, `ce0bb20`, `9821066`, `27eea59`, `5cec025`, `d67ecd0` | Policy propagation, epoch-zero distinction, lifecycle intent, refreshed restart authority, effective settings and stronger factory verification. Tests are bounded engineering evidence, not a real reboot. |
| Provenance repairs | `658fa17`, `5afb25c`, `08900a8`, `b3fec70` | Native-input and Fresh17 failures retained, immutable claims bound, and lifecycle rebuild failure added as a negative result; documentation commits are not independent runtime contributions. |

The current candidate's fresh qualification and three Phase C repeats are outside this historical commit-count snapshot and must be cataloged by their own run IDs and SHA. Real 24-hour and reboot results remain separate from synthetic evidence.

## Qualified production-baseline snapshot (2026-09-24)

The full fetched project history contained 366 reachable commits at the qualified product baseline. The final candidate was `63eabc9a9341abd2e612bf603e3ce340eaa2cc57`, tree `8e6884e6b25bb3989509bd9d623dca4c0abb2bf1`. It passed one immutable fresh-remote-clone run (`2026-09-24T06-54-31-334Z-09571b4b`, 17/17 mandatory gates), was merged through PR #2 as `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`, and the merge tree exactly matched the qualified tree. Annotated tag `hns-production-v1` (tag object `2d4aeeda945b410d3e35ad82b456f7b74de922fc`) targets that merge commit. Candidate CI run `35953056840` and merge CI run `35972160064` both passed. The later paper/report delivery is documentation-only and is not another product contribution or a tag move.

Branch dispositions were based on commit/diff review and ancestry, not branch existence: `better-install`, `target-standby`, and `dev/hns-integration-visual-rc1` were `ALREADY_INCLUDED`; `try-auto`, `dev/runtime-ui-separation-v1`, and qualified `dev/hns-final-qualification-rc2` were `INCLUDE`; `SUPERSEDED=none`, `EXCLUDE=none` for the reviewed release branch heads. Exact head SHAs and reasoning are in `data/commit-lineage.json.productionBaselineSnapshot` and `artifacts/qualification/FINAL_HNS_QUALIFICATION_REPORT.md`. Commit count remains a history cutoff, not a contribution count; patch-equivalent changes remain deduplicated.

## Post-release full-history refresh (2026-09-25)

After `git fetch --all --tags --prune`, all fetched refs reachable at report HEAD `d4d2e8757c7660a6130050cc718debf79c1ea252` contain 379 commits. The prior production merge cutoff remains 366; the delta is 13 commits, including two merges and 11 non-merge diffs. Each non-merge diff below was inspected and has its own stable patch-id. Merge commits preserve ancestry only and are not contributions.

| Commit | Kind and reviewed diff | Stable patch-id |
|---|---|---|
| `b7cf738` | Paper/evidence refresh after the production tag; report and catalog metadata only. | `e29dbabb4134b9cafd20f53aa77d07c1cc7d212d` |
| `f869173` | Qualification-report and 24-hour record refresh; documentation/evidence only. | `fb478a20cba1c4c2a9293d012de0f04f544c07f0` |
| `a34dcaf` | Preserved the historical failure boundary in the evidence index. | `e9372ebc51e29d85579d62dcd4e92027db2440a5` |
| `fb008fb` | Bound a retained visible-journey screenshot by SHA-256 in the report index. | `3410c0c27168786da668f87ef6048d75119568d4` |
| `8b91228` | PR #3 merge for published qualification evidence; merge-only ancestry. | — |
| `f4885b7` | Bounded the restart companion's open-ended trace and rejected nonpositive polling intervals; added focused regression tests. | `ade14d4e8475b4782108fe28b015f6482468381c` |
| `d36c490` | Merged PR #3 evidence and the restart-watch repair; merge-only ancestry. | — |
| `337169d` | Reworked integrated-dock ownership/layout to a disjoint BaseWindow/WebContentsView surface and added UI/layout regression coverage. | `dc24210c8ae61f1552a3352487bd50142cc53c0e` |
| `4ddb717` | Added an architecture/layout contract check for the integrated dock. | `6eff349b43bda6c473cf35a290eded46310e41e9` |
| `73d3332` | Reordered cold-install Node bootstrap and post-bootstrap install-state recording; added real installer regression coverage. | `f49fcd0e75ef8616b0bed8c464e2de8941c59463` |
| `61506b3` | Made host-capability JSON parsing consume the explicit JSON CLI output and retained a warning on measurement failure. | `d2e09b677292731de8526202746f6581b16a306a` |
| `4ef9c0d` | Made missing/failed required built-in plugins fail installation closed, avoid complete-state recording, and skip launch; added a focused installer regression. This is the current source candidate. | `c2643fe0101360d3879a80ccdbc2c62641f73fd52` |
| `d4d2e87` | Current qualification report/evidence snapshot; documentation only, no product-source change. | `d0db3a91b03c347f5a2af34be79fb2b84a61b46e` |

The 11 new non-merge patch-ids are distinct within this post-release delta; the two merge commits have no patch-id. Documentation/evidence commits are provenance, not product contributions. The three installer commits are a sequential repair lineage, while the dock-layout and restart-watch changes are separate bounded engineering changes. This 379-commit repository snapshot does not alter the historical 366-commit production baseline or imply a new production release.
