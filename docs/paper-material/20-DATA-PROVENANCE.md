# Data provenance

| Data | Origin | Mutability/control | Use |
|---|---|---|---|
| Git history | DS-Hns refs fetched 2026-09-22 | immutable commit objects | evolution/lineage |
| Phase C artifacts | local Alien host, commits `9cecd68`/`0bbd32e` | retained JSON | paired performance |
| chaos/soak artifacts | repository scripts | synthetic/injected | recovery/endurance |
| UI screenshots | visible Alien desktop, real foreground input | construction-phase evidence | P2 journeys |
| qualification runs | `D:\Hns-Final-Qualification\test-artifacts\qualification-runs` | append-only per run | final gates |
| `dsh-restart` fixture | GitHub `e20fb6c…` | pinned external source, npm lock | process acceptance |
| `dsh-web` fixture | GitHub `c5679ff…` | pinned external source, pnpm lock | Cordis/install acceptance |
| wallpaper fixture | GitHub `b3937a3…` | pinned external source, npm lock | Cordis acceptance |

Host identity and tool versions are captured by qualification summary. API credentials are not included. Real reboot and real 24h outputs do not exist unless separately generated; absence is recorded as `NOT_RUN`, not zero.

The2026-09-23ref refresh through `1a2fa2c` reaches340commits and extends the326commit original snapshot by14distinct stable patches. Read `commit-lineage.json.refresh` and the timeline supplement for the finite cutoff. Diagnostic UI-only dirty-tree runs are explicitly excluded from final candidate qualification even when their individual checks pass. External observer component self-tests do not start a24-hour observation clock.

`commit-lineage.json.postRefreshRepairs` separately records the two observed UI/listener repair diffs through `2d76ca3` (342reachable commits), preserving the earlier finite snapshots rather than overwriting their counts. This metadata commit and subsequent release/ref changes are outside that cutoff.
