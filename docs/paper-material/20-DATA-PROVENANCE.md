# Data provenance

| Data | Origin | Mutability/control | Use |
|---|---|---|---|
| Git history | DS-Hns refs fetched 2026-09-22 | immutable commit objects | evolution/lineage |
| Phase C artifacts | local Alien host, commits `9cecd68`/`0bbd32e` | retained JSON | paired performance |
| chaos/soak artifacts | repository scripts | synthetic/injected | recovery/endurance |
| UI screenshots | visible Alien desktop, real foreground input | construction-phase evidence | P2 journeys |
| final qualification run | `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b` | immutable run and per-file SHA index (`8679cd6a04935de4113672c657cdd108c131300c490bdaadb2969780e5e987ea`) | exact candidate `63eabc9`; 17/17 mandatory gates |
| post-merge smoke | `D:\HQR\post-merge-5dcde76` | fresh clone and D-only state roots | merge SHA `5dcde76`; full syntax plus targeted post-merge tests |
| `dsh-restart` fixture | GitHub `e20fb6c…` | pinned external source, npm lock | process acceptance |
| `dsh-web` fixture | GitHub `c5679ff…` | pinned external source, pnpm lock | Cordis/install acceptance |
| wallpaper fixture | GitHub `b3937a3…` | pinned external source, npm lock | Cordis acceptance |

Host identity and tool versions are captured by qualification summary. API credentials are not included. Real reboot and real 24h outputs do not exist unless separately generated; absence is recorded as `NOT_RUN`, not zero.

The 2026-09-23 ref refresh through `1a2fa2c` reaches 340 commits and extends the 326-commit original snapshot by 14 distinct stable patches. Read `commit-lineage.json.refresh` and the timeline supplement for the finite cutoff. Diagnostic UI-only dirty-tree runs are explicitly excluded from final candidate qualification even when their individual checks pass. External observer component self-tests do not start a 24-hour observation clock.

`commit-lineage.json.postRefreshRepairs` separately records the two observed UI/listener repair diffs through `2d76ca3` (342reachable commits), preserving the earlier finite snapshots rather than overwriting their counts. This metadata commit and subsequent release/ref changes are outside that cutoff.

Historical experiment attribution was corrected after direct raw-report review (N29). The selected run `2026-09-23T05-33-13-145Z-0c277af6` is archived byte-identically under `artifacts/qualification/history/1a2fa2c4881cb7337f480c770b25337fd55b7654/`; its overall result is `FAIL`. Historical experiment children point to the exact preserved summary/report and SHA-256 values, not generic run-local labels or an unrelated code SHA. Historical Phase C measured SHA is `9cecd68`; `0bbd32e` is the later evidence commit. Archive attributes disable newline conversion to preserve raw byte hashes on Windows and Linux. This is historical evidence storage, never copied live runtime/profile/dependencies.

The final qualified candidate is `63eabc9a9341abd2e612bf603e3ce340eaa2cc57` (tree `8e6884e6b25bb3989509bd9d623dca4c0abb2bf1`), runId `2026-09-24T06-54-31-334Z-09571b4b`; its summary SHA-256 is `b0c76898e96cfc6ef1076913114892786090e7c9b2842b63a026943f42f94a99`. PR #2 merged it as `5dcde767020161f6f6c7a5fc3330bccaca1d14a3` with identical tree, and tag `hns-production-v1` points to that merge SHA. The release history cutoff is 366 reachable commits. Exact branch heads/dispositions and the annotated tag-object SHA are recorded in `data/commit-lineage.json.productionBaselineSnapshot` and the final qualification report.

Candidate checkout, npm cache, TEMP, userData, runtimeData, test artifacts, and qualification output were on D:. The post-merge clean clone and its npm cache, TEMP, local/app data roots, runtime, test artifacts, and userData were also under `D:\HQR\post-merge-5dcde76`. The scoped C-drive project audit found zero detected project-shaped writes. `C:\Users\15601\.npmrc` was read only as npm configuration and not modified. This does not assert that Windows made no ordinary system writes. A separate active wall-clock observer PID 13896 is prior-SHA evidence with an observed process-root mismatch; it was left running and is not accepted as final-candidate evidence. Real reboot and exact-candidate 24-hour wall-clock qualification remain `NOT_RUN`.
