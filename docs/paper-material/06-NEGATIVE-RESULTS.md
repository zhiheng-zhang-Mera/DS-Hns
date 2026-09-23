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

| N23 | billing timezone label was ambiguous beside a browser-local datetime input | `artifacts/qualification/TIMEZONE_LABEL_FOLLOWUP.md` | explicitly distinguish local send time from billing windows; preserve scheduling semantics |

| N24 | built-in packages omitted contract/status files; source junctions concealed the missing dependencies | `artifacts/qualification/PACKAGING_FOLLOWUP.md` | actual pack/extract/require tests protect package boundaries; installer smoke does not replace real launch |
| N25 | concurrent UI occupied a unit test's required-free port3099 | `artifacts/qualification/NATIVE_PICKER_SAFETY_FOLLOWUP.md` | isolate ports and serialize UI; a focused pass cannot replace a failed full run |
| N26 | broad-title activation plus global keystrokes sent a fixture path into another conversation | `artifacts/qualification/NATIVE_PICKER_SAFETY_FOLLOWUP.md` | targeted native input, exclusive coordination record and actual installed-state assertions; no fallback certificate |

| N27 | a real picker collapsed the dock before a geometry assertion; descendant blur polluted window focus counts | `artifacts/qualification/POST_PICKER_UI_FOLLOWUP.md` | explicit surface preconditions and correctly scoped observations; failed full run preserved |
| N28 | repeated observation and detach accumulated native Electron Debugger listeners | `artifacts/qualification/ELECTRON_LISTENER_FOLLOWUP.md` | current-view adapter ownership, native listener cleanup and bootstrap invalidation; no raised warning limit |
| N29 | paper claim IDs drifted between Markdown/JSON and generic paths/SHA labels failed to identify actual evidence | `artifacts/qualification/PAPER_PROVENANCE_FOLLOWUP.md` | fail-closed catalog validation and immutable hash-bound child evidence; whole-run failure remains visible |

| N30 | a real UIA test depended on an arbitrary foreign window; root-first plus Subtree also returned a duplicate ref and consumed a distinct child's slot | `artifacts/qualification/UIA_OWNED_WINDOW_FOLLOWUP.md` | owned real-provider fixture, stronger descendant/uniqueness assertions, and Descendants-only query after the root check; preserve both full-run timeouts without blaming an unrecorded external application |

These failures motivate mechanisms; they do not by themselves demonstrate generality.

| N31 | primary-window close left Desktop/companion running despite no targetable window; relaunch evidence also contained a separate empty-environment-variable launcher defect | `artifacts/qualification/DESKTOP_CLOSE_FOLLOWUP.md` | bind primary closure to existing detach/quit ownership; distinguish product lifecycle failure from instrumentation failure; bounded native regression does not replace fresh full Journey |
| N32 | governance dropped native orb ownership, so the official view rendered an additional in-UI ball | `artifacts/qualification/ORB_OWNERSHIP_FOLLOWUP.md` | preserve ownership across the actual builder/serialization/view boundary; separate proven state propagation failure from unproven native input failure; renew candidate qualification |
| N33 | real UI service enable was refused; adapter argument shapes, stale host accessors, dropped action fields and lost refusal reasons broke the management chain | `artifacts/qualification/SERVICE_ACTION_FOLLOWUP.md` | exercise shipped adapters against real host state/config and real bridge envelopes; retain confirmation enforcement and renew immutable-candidate visual qualification |
