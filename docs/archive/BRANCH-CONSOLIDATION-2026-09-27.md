# Branch Consolidation Ledger — 2026-09-27

## Snapshot and deletion gate

- Repository: `zhiheng-zhang-Mera/DS-Hns`; remote: `origin`.
- Captured: 2026-09-27 17:35:29 Australia/Sydney (07:35:29 UTC), before deleting any remote branch.
- `main` at snapshot: `56dc1f94873767ecd266a24b8d5a1072a0d9161d`.
- Main merge commit `56dc1f9` has parents `c70fbe18a674882a82408188aaf68c8a33733399` (PR #5) and `b2f978c85761bca85b48611506348582cc97027f` (PR #6 head). The PR #6 branch merge commit `30ee75bd1c4e11307c5fb19703481292ec7839fd` preserves the prior recovery and `main` histories.
- Ahead/behind values use `git rev-list --left-right --count origin/main...origin/<branch>` and are written as `ahead / behind`. All eight non-main heads below are ancestors of this `main` (`ahead=0`).
- No remote branch has been deleted as of this snapshot. Deletion is gated on this ledger merging to `main`, then a fresh remote-head and ahead-count check.

## Remote branch dispositions

| Remote branch | Head at snapshot | Ahead / behind | Role and PR record | Main containing head | Rename or merge collision | Remote deletion at snapshot |
|---|---|---:|---|---|---|---|
| `better-install` | `a5d89b9ae63a8eb996e3cb6be521aadd7cbcc7b6` | 0 / 130 | Installer verification; no PR found | `56dc1f94873767ecd266a24b8d5a1072a0d9161d` | No rename collision | Not deleted; eligible after this ledger merges |
| `target-standby` | `5efa302acd381d57d44bc87bbdc36f80a21dda9a` | 0 / 126 | Plugin service record; no PR found | `56dc1f94873767ecd266a24b8d5a1072a0d9161d` | No rename collision | Not deleted; eligible after this ledger merges |
| `try-auto` | `432cf431f2b40843ab3ec5287ffd7e5296cb6626` | 0 / 121 | Long-host boot and official view; no PR found | `56dc1f94873767ecd266a24b8d5a1072a0d9161d` | No rename collision | Not deleted; eligible after this ledger merges |
| `dev/runtime-ui-separation-v1` | `923f5293a2ada553cb7f91a4bc1b54e750dfe7c3` | 0 / 118 | Runtime/UI boundary; no PR found | `56dc1f94873767ecd266a24b8d5a1072a0d9161d` | No rename collision | Not deleted; eligible after this ledger merges |
| `dev/hns-integration-visual-rc1` | `2ae08a73ee3e7b32b31e7e84a4dfe8ab49ebaa1d` | 0 / 102 | Integration and visual acceptance; no PR found | `56dc1f94873767ecd266a24b8d5a1072a0d9161d` | No rename collision | Not deleted; eligible after this ledger merges |
| `codex/hns-final-evidence-docs` | `fb008fb100364f67e12eddd4850254e4c19e9663` | 0 / 48 | Qualification and paper evidence; PR #3 merged | `56dc1f94873767ecd266a24b8d5a1072a0d9161d` | No rename collision | Not deleted; eligible after this ledger merges |
| `dev/hns-final-qualification-rc2` | `95614f0053952308b62c9c1793bb92868049a53e` | 0 / 30 | Qualification RC2; PR #2 and PR #5 merged, with PR #5 containing this exact head | `56dc1f94873767ecd266a24b8d5a1072a0d9161d` | No rename collision; evidence filenames retained | Not deleted; eligible after this ledger merges |
| `dev/crash-resume-recovery-v1` | `b2f978c85761bca85b48611506348582cc97027f` | 0 / 1 | V5 recovery and cross-volume cleanup; PR #6 merged | `56dc1f94873767ecd266a24b8d5a1072a0d9161d` | No rename collision; semantic merge conflicts resolved as recorded below | Not deleted; retain until this ledger merges, then eligible |

## Integration record

PR #5 merged RC2 at `c70fbe18a674882a82408188aaf68c8a33733399`. PR #6 merged at `56dc1f94873767ecd266a24b8d5a1072a0d9161d`, preserving both parent histories. Its final head was `b2f978c85761bca85b48611506348582cc97027f`.

PR #6 had textual conflicts in `.gitattributes`, `.github/workflows/verify.yml`, `app/desktop-main.cjs`, `scripts/check-syntax.cjs`, and `tests/unit/instance-isolation.test.js`. Resolutions retained the union of recovery artifact and immutable evidence attributes, both workflow trigger sets, the shared reboot target adapter, both syntax-check file sets, and the stronger canonical-path assertions together with recovery behavior. No file was renamed to resolve a collision. The reboot adapter regression test was observed failing before the fix and passing after it.

The post-merge test commit `b2f978c` updates only test fixtures: it selects an existing temporary directory on a device volume different from the work root, so a D-isolated test run does not mistake redirected `LOCALAPPDATA` for a cross-volume path.

## Verification and evidence limits

- Syntax gate: 307/307 files passed.
- Integration/recovery/wiring tests: 59 passed, 0 failed.
- D-isolated recovery suite: 102 passed, 0 failed, 2 skipped. The cross-volume/host-resume subset passed 17/17.
- `scripts/test-all.ps1`: 2,121 passed, 0 failed, 4 skipped, using Node v24.19.0 and its matching npm CLI.
- Bundled plugin packaging checks: 2 passed, 0 failed with that Node/npm toolchain.
- PR #6 GitHub `check + tests` runs 36303026512 and 36303030034 both passed on head `b2f978c`.
- Published candidate `candidate-64d2c39` SHA-256 list: 14/14 entries matched. Its evidence remains bound to SHA `64d2c396b7649452c0858e4915af17e6bbbb2368`: one W0 fault-4 observation; 20 E5 observations (11 PASS, 9 EXPECTED_BLOCK); E3, E4, and E7 NOT_RUN; E6 NOT_RUN_MAINTENANCE_WINDOW; O5 has no applicable observation. This merge does not upgrade those results.
- Temporary cleanup exception: the first direct full-unit invocation inherited C: `TEMP` and left 45 test-named directories (674 descendants) in `C:\Users\15601\AppData\Local\Temp`. Their exact roots and descendants were verified to stay under that directory and contain no reparse points, but automatic approval review rejected both cleanup attempts with `blocked by policy`. A later D-isolated `test-all.ps1` run passed, and its explicit cross-volume fixtures cleaned up in their `finally` blocks. The 45 earlier roots therefore remain at the time this ledger is written.
