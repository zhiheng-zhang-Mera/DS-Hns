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

## F5 — task continuity and evidence

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
