# Negative results and design lessons

| ID | Observed failure | Evidence/lineage | Design consequence |
|---|---|---|---|
| N1 | unref'd restart timer let the supervisor process exit | managed-process lineage `791773d`/`9417ca8`; external supervisor comments/tests | entry point owns a keep-alive while library timers remain non-blocking |
| N2 | crash before handshake could cancel a required restart | process supervisor tests in `9417ca8` | handshake death and steady-state death have distinct transitions |
| N3 | readiness wait could outlive a dead child | process supervisor tests | child-exit state cancels readiness waiting |
| N4 | runtime-discovered capabilities could widen permission surface | adapter framework tests, `db5ebab` | capabilities are declared and allow-listed before launch |
| N5 | weighted pressure made restart unreachable | health scheduler lineage `16d722c` | severe signals and restart authority are modeled separately |
| N6 | epoch-zero cooldown and reads mutating health state | scheduler unit history | reads are side-effect free; cooldown handles zero timestamps explicitly |
| N7 | Cordis parser/service mismatches | `d44d835`; Cordis acceptance | controlled providers and honest degraded browser-half report |
| N8 | broad route reservation and handler error→200 | bridge tests | exact route ownership and error-status propagation |
| N9 | activation failure overwritten/refusal counted twice/native `main` ignored | adapter/install tests | one terminal result per stage; native entry resolution tested |
| N10 | installer reported Plugin Market failure after materialization succeeded | `412ec64` | materialized package/profile state outranks stale transient result |
| N11 | project tests wrote C temp and left a host process | `277ef17`, `be743a7` | explicit D roots and post-test process/C-drive gates |
| N12 | Phase C achieved only 1.189x in a combined run | historical RC + `9cecd68`/`0bbd32e` | batch identical validations; retain 1.2 threshold and three repeats |
| N13 | evidence said soak passed while top summary exit was 2 | `67b741a` | immutable run directory and consistency checker |
| N14 | junction-based Plugin Market isolation returned zero rows | `task5-installed-canonical-with-duplicate-profile.png` | rejected experiment retained; canonical identity patch used instead |
| N15 | CDP target existed before `documentElement` | first final qualification run | explicit renderer document-ready gate |
| N16 | qualification depended on `D:\test-DSH` prebuilt samples | first final qualification run, `be743a7` | pinned upstream SHAs are freshly installed/built per run |

| N17 | stale companion PID file masked a newly launched live process | `f03cc37` | prefer the live launch during PID hand-off |
| N18 | Windows CI TEMP used an 8.3 alias while the test expected literal spelling | `e32d55d`, GitHub run `35784256767` | canonicalize existing ancestor; preserve missing tail case |
| N19 | crash ledger became visible before the relaunched stand-in wrote its PID | `80ffe0e`, run `2026-09-22T21-20-24-182Z-c820a927` | wait for a distinct live PID within the same 20-second budget |
| N20 | failed repository/checkpoint verification still resumed work and cleared its intent | `f90660b` | refuse parked recovery before side effects and preserve durable intent; regression failed before repair, 55 focused tests and 65 chaos checks passed after |

| N21 | direct instance tests inherited caller TEMP; C-drive audit missed `dshns` names | `artifacts/qualification/STORAGE_AUDIT_FOLLOWUP.md` | repository-volume scratch, behavioral audit-name regression, preserved historical failure and recoverable D-drive relocation |

| N22 | a stationary pointermove swallowed real orb clicks | `artifacts/qualification/ORB_POINTER_FOLLOWUP.md` | measure from press coordinates and require drag displacement; RED/GREEN regression plus real screenshot/click/detail feedback |

These failures motivate mechanisms; they do not by themselves demonstrate generality.
