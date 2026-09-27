# Figure plan

## F1 — final architecture

```mermaid
flowchart LR
  UI[Electron official page + Mega operator surfaces] -->|named-pipe client| RH[Runtime Host]
  RH --> PM[Plugin Manager]
  PM --> NA[Native HNS Adapter]
  PM --> CA[Cordis/DSH Adapter]
  PM --> PA[Managed Process Adapter]
  CA --> CB[Controlled Bridge]
  PA --> CP[External Companion]
  HS[Health Scheduler] -->|decision only| RC[restart-control capability]
  RC --> CP --> RS[Restart Supervisor]
  RH --> TC[Task Continuity + Work Admission]
```

## F2 — architecture evolution

```mermaid
flowchart LR
  A[Alien rebuild] --> B[Plugin manager] --> C[Adapter framework] --> D[Capability bridge]
  D --> E[Separated health/restart authority] --> F[Runtime Host/UI client] --> G[Immutable qualification]
```

## F3 — health/restart separation

```mermaid
sequenceDiagram
  participant T as Telemetry
  participant H as Health Scheduler
  participant C as restart-control
  participant S as External Supervisor
  T->>H: bounded samples
  H-->>H: NO_ACTION / PAUSE / REQUEST
  H->>C: REQUEST_RESTART (no process authority)
  C->>S: validate budget + boundary
  S-->>C: readiness/recovery result
```

## F4 — plugin adaptation pipeline

```mermaid
flowchart LR
  S[Source] --> D[Detect] --> A[Adapter] --> P[Risk/permission plan] --> C{Confirm}
  C -->|yes| I[Install record] --> M[Common manager lifecycle]
  C -->|no| R[Refusal with evidence]
```

## F5 — qualification evidence

```mermaid
flowchart TB
  Q[Qualification runner] --> R[unique runId + SHA + tree]
  R --> G1[child gates]
  G1 --> RAW[raw stdout/stderr + reports]
  RAW --> EC[evidence consistency]
  EC -->|consistent| V[verdict]
  EC -->|contradiction| F[fail closed]
```

Performance plot data: `(baseline, optimized)` = `(17198,9141)`, `(17218,9184)`, `(17381,9248)` ms. Failure/recovery matrix rows should use the eight named chaos scenarios, not aggregate counts alone.

## F6 — runtime/UI ownership

```mermaid
flowchart LR
  UI[desktop-main.cjs] --> Client[runtime/client.cjs]
  Client -->|named pipe| Host[runtime/host.cjs]
  Host --> Harness[runtime/harness-service.cjs]
  Host --> Plugins[plugin-host.cjs]
  Host --> CU[computer-use/index.cjs]
  UI -->|announce or withdraw page capability| Host
```

Host services are lazy. A UI detach withdraws its capability without implying a runtime shutdown; explicit complete-stop is a separate command.

## F7 — task continuity and restart

```mermaid
flowchart TD
  Park[core/task-continuity.cjs: park] --> Intent[Durable resume-intent.json]
  Intent --> Restart[restart-supervisor/lifecycle.cjs]
  Restart --> Resume[core/task-continuity.cjs: resume]
  Resume --> Verify{Repository and checkpoint verification}
  Verify -->|failure with parked work| Retain[Refuse execution and retain intent]
  Verify -->|valid| Target[Resume parked target only]
  Target --> Evidence[Record target result and semantic evidence]
  Evidence --> Clear[Consume intent]
```

The verification refusal was repaired in `f90660b`. This describes the implemented process-recovery path; it is not real OS-reboot evidence or a proof of exactly-once behavior under every possible crash.

## F8 — failure/recovery matrix

| Scenario ID | Injected condition | Required observed behavior | Scope |
| --- | --- | --- | --- |
| kill-core | watched application killed | companion launches a live replacement | real stand-in process |
| controlled-restart | restart-control request | continuity, boundary, stop, launch, readiness, recovery order | controlled lifecycle |
| plugin-crash | plugin fault | runtime and record survive | injected fault |
| plugin-timeout | call never answers | bounded response with honest health | injected timeout |
| network-failure | readiness network unavailable | bounded retries and optional-gate semantics | simulated network gate |
| host-restart | durable intent consumed on new start | checkpoint-aware continuation | simulated reboot path |
| git-interruption | interrupted repository stage | readable commit and no silently duplicated stage | real temporary Git repository |
| false-success | recovery claim without evidence | failure reason recorded | injected claim |

Populate measurements from the same candidate's immutable `reports/longhost-chaos.json`; each scenario has its own check count and outcome. The 65/65 focused regression after `f90660b` is separate from final full qualification.
