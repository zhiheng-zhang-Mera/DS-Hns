# DS-Hns Runtime / UI Separation

> **UI MUST NOT OWN RUNTIME LIFETIME**
>
> Electron may disappear; DS-Hns Runtime must continue to exist.

This document describes the split, why it exists, and the rules that keep it true.
It is the design record for `dev/runtime-ui-separation-v1`.

---

## 1. The problem

DS-Hns used to be one process tree. `app/desktop-main.cjs` — the Electron main
process — spawned the Harness (`dsh web`), owned the Sub-worker manager, lazily
built the Engineering and Plugin hosts, and tore all of them down in
`before-quit`. The consequences were structural rather than incidental:

* **Closing the window stopped the engine.** `window-all-closed` → `app.quit()` →
  `before-quit` → `teardownManagedResources()` → `stopHarness()`. A running task
  died with the window.
* **Killing the shell killed everything.** The Harness and every worker were
  children of Electron, so `taskkill /T` on the UI took them with it.
* **Two checkouts could not coexist.** Electron's single-instance lock lives in
  `userData`, `userData` was derived from the checkout, and the Harness port
  defaulted to 3080 — so a second copy either refused to start or collided.
* **The installer had no memory.** Every run redid everything, including the
  whole unit suite, and a wall-clock benchmark could fail an installation.

## 2. The shape now

```
Windows
│
├── DS-Hns Runtime Host          app/runtime/host.cjs      (plain Node, detached)
│   ├── Harness child lifecycle  app/runtime/harness-service.cjs
│   ├── runtime ownership        app/runtime-process.cjs   (the one ownership system)
│   ├── Sub-worker manager       app/sub-worker/manager.cjs
│   ├── Engineering host         app/engineering-host.cjs
│   ├── Plugin host              app/plugin-host.cjs
│   ├── Computer Use core        app/computer-use/index.cjs
│   ├── host capability          app/runtime/host-capability.cjs
│   └── task/health/recovery state
│
├── Electron Desktop Client      app/desktop-main.cjs       (UI)
│   ├── BrowserWindow / WebContentsView / Tray / Menu
│   ├── wallpaper window, notifications, renderer IPC
│   ├── Computer Use Electron provider  app/computer-use/host-electron.cjs
│   └── runtime client           app/runtime/client.cjs
│
└── Browser / Computer Use capability
```

The Runtime Host is a **program**, not a library: `node app/runtime/runtime.cjs
serve` runs it with no UI at all. That is what makes the claim testable rather
than aspirational.

### Ownership

| Thing | Owner |
|---|---|
| Harness (`dsh web`) child | Runtime Host |
| Sub-worker process tree | Runtime Host |
| Engineering supervisor | Runtime Host (created on demand) |
| Plugin platform | Runtime Host (created on demand) |
| Computer Use core (scheduler, state, policy, history) | Runtime Host |
| Computer Use *page* capability | Electron Client (attached / withdrawn) |
| Windows, tray, wallpaper, notifications | Electron Client |
| The connection between them | `app/runtime/client.cjs` |

## 3. Instance identity

`app/runtime/instance.cjs` is the single place that answers *"which DS-Hns am I?"*.
Everything derived from that answer is per-instance:

```
instance_id = sha256(canonical root).slice(0, 16)

DSH_HOME              <root>/data (or $DSH_HOME)
state                 <home>/state
logs                  <root>/logs
temp                  <root>/temp
cache                 <root>/cache
userData              primary: <home>/desktop-shell
                      isolated: <home>/electron/<instance-id>
browser profile       <home>/browser/<instance-id>
IPC endpoint          \\.\pipe\dsh-hns-<instance-id>   (Windows)
                      <runtime-dir>/dsh-hns-<id>.sock (POSIX)
Harness port          requested → available? use : allocate
ownership records     <root>/runtime/*.json
```

Three rules make this safe:

1. **Identity is a pure function of the canonical root.** The same root yields the
   same id on every run; a different root yields a different one. A record found
   on disk can therefore be *proven* to belong to this instance before anything is
   killed.
2. **Paths keep the filesystem's spelling.** `canonicalize()` produces a
   lower-cased form for *comparison and hashing only*; `resolveRoot()` produces the
   path to *use*, by taking the real spelling of the deepest existing ancestor.
   Lower-casing a path and then opening it works on a case-insensitive volume and
   silently fails on a case-sensitive one.
3. **The primary instance is not migrated.** An isolated instance gets an
   id-keyed `userData`; the primary keeps `desktop-shell`, because that is where
   its window state and cache already live and moving it would be a migration with
   no isolation benefit.

### The Harness port

`3080` is a **preference, never a requirement**. `3081` is not special-cased
anywhere.

```
requested port (explicit, else persisted, else 3080)
    ↓ available?
    ├─ yes → use it
    └─ no  → walk a bounded window, then ask the OS
    ↓
persist the answer in <home>/state/instance.json
```

An instance that chose 3093 last run still gets 3093, because otherwise it would
drift to a new port on every restart just because its own previous Harness had not
released it yet.

## 4. The protocol

Newline-delimited JSON over the instance's own pipe, versioned
(`dshns-runtime/v1`). One object per line means a frame can be logged, replayed and
tested without sockets, and `JSON.stringify` escapes any newline inside a payload,
so a frame can never be split by its own contents.

```
client → host   hello status snapshot subscribe command cancel health shutdown ping
host → client   welcome status snapshot event result error health bye pong
```

Commands: `harness.start|stop|url`, `worker.start|stop|describe`,
`engineering.status`, `plugins.status`, `computerUse.status|capability`,
`host.capability`, `runtime.shutdown`.

**The credential.** The Harness announces an authenticated `?token=…` URL on its
own stdout. The Host captures it and returns it through `harness.url`, over the
same-user pipe — the only place it is disclosed. It is never logged (`redact`
guards the log lines), never broadcast, and never in a snapshot.

## 5. Lifecycle

| Event | Result |
|---|---|
| Runtime absent, GUI starts | Client starts a Runtime, then attaches |
| Runtime alive, GUI starts | Client attaches; **no second Runtime is created** |
| GUI closes / is killed | Runtime, Harness and workers keep running |
| Runtime dies | UI stays alive, reports `disconnected`, retries |
| Runtime restarts | UI reattaches |
| "Stop DS-Hns Completely" | Runtime drains, checkpoints, terminates its own children, then exits |

The last row is the only UI path that ends the Runtime. Closing a window is not a
shutdown, and `process.on('exit')` no longer kills the Harness — that handler was
the one path that would have silently undone the split however the process ended.

## 6. Computer Use boundary

The core is Electron-free by construction — `computer-use/index.cjs` takes *ports*
— so it lives in the Runtime and survives the UI. The page is the one port it
cannot own: driving the visible surface needs `webContents.debugger`, which only
the Electron Client has.

That is a **capability**, not a dependency:

* the core starts with `page: null`;
* the Electron Client announces `computerUse.capability`;
* when the Client goes away the capability is withdrawn and the core reports
  `CAPABILITY_UNAVAILABLE` — it keeps running, and so does everything else.

Withdrawal belongs to **subscribers**. A one-shot client asking
`computerUse.status` is not a UI, and must not withdraw the capability it is
asking about.

## 7. Installer

Three questions used to be one:

```
INSTALLATION CORRECTNESS  ≠  REPOSITORY QUALIFICATION  ≠  PERFORMANCE BENCHMARK
```

Only the first is the installer's to answer.

| Mode | Runs |
|---|---|
| `Fast` | syntax preflight, dependency reuse decision, required files, installer smoke set. No verification, no performance measurement. |
| `Standard` (default) | Fast + profile/plugin correctness + the deterministic smoke set + the verifier. **Never the whole unit suite.** |
| `Qualification` | the full suite, architecture checks, dual-instance acceptance, performance qualification. For a release, CI, a major refactor, or an explicit owner request. |

`-SkipTests` still skips the test tier in every mode; `-SkipVerify` skips
verification, which was previously impossible.

### Incremental state

`scripts/install-fingerprint.cjs` records, under `<DSH_HOME>/state/install-state.json`:

| Unit | Valid when |
|---|---|
| dependencies | `package-lock.json` hash, `package.json` hash, Node build, expected `dsh`/Electron versions all unchanged, **and** `lib/bin.js`, `electron/install.js`, `electron.exe` all present |
| profile plugin | the profile declares this checkout's `file:` spec **and** both installed halves exist |
| optional plugins | the user's decision is recorded |

Two rules keep it honest: a fingerprint **never overrides a missing file**, and an
**unknown key is invalid** — so the failure direction is "reinstall", never "reuse
something broken".

The lockfile hash is the entry that was missing: `npm ci` consumed
`app/package-lock.json` but nothing ever compared it, so a lock change that left
`dsh` and Electron at the same versions was invisible to every reuse decision.

## 8. Hardware adaptation

`app/runtime/host-capability.cjs` measures the host rather than looking it up.
A CPU-model table is a guess made by someone who has never seen the machine; what
matters is what the machine *is* and what it *does*:

```json
{
  "cpu": { "logicalCores": 16, "architecture": "x64" },
  "memory": { "totalMB": 32522, "availableMB": 20042 },
  "calibration": { "nodeSpawnP50Ms": 1158, "nodeSpawnP95Ms": 1170 },
  "capacity": { "class": "CAPABLE", "score": 5 },
  "workers": { "recommended": 10, "aggressiveScaling": true }
}
```

Capacity classes: `LOW_CAPACITY`, `CONSERVATIVE`, `BALANCED`, `CAPABLE`,
`HIGH_CAPACITY`. **`LOW_CAPACITY` is not an error state.** A 2-core 4 GB host is
classified conservatively, gets one worker and longer timeouts, and installs.

### Dynamic budgets

```
dynamic_budget = intrinsic_work_ms
               + calibrated_startup_overhead   (per-start cost × starts)
               + host_variance_margin          (observed spread, bounded)
```

### Dynamic timeouts

```
timeout = base × class_factor + per_start_cost × starts
```

The scaling is **additive on purpose**. Multiplying a long timeout by a
spawn-latency ratio is wrong in both directions: a 1 s process-creation cost is
under 1 % of a two-minute Harness startup, so scaling it to twelve minutes is not
caution but an unbounded wait — while on a quiet host the same ratio would shrink
the timeout below what the work needs. Timeouts also distinguish a **deadlock
bound** (liveness, generous, roughly host-independent) from a **budget**
(expectation, reported, not a gate).

### Performance policy

```
Correctness gates       structural: workers truly overlap, both nodes in flight,
                        plan completed, tasks recorded. Always gate.
Performance benchmarks  measured and printed as [benchmark] lines.
Strict gates            only under an explicit DSH_SUPERVISOR_WALL_CLOCK_GATE=strict,
                        in Qualification.
```

A slow host runs slowly. It is never declared incorrectly installed.

## 9. Commands

```powershell
# Runtime only — no UI
node app\runtime\runtime.cjs serve       # foreground host
node app\runtime\runtime.cjs start       # ensure a detached host is running
node app\runtime\runtime.cjs status      # report the instance and the Runtime
node app\runtime\runtime.cjs stop        # graceful shutdown
node app\runtime\runtime.cjs capability  # this host's profile and derived policy

# Install
.\scripts\install.ps1 -Mode Fast|Standard|Qualification [-SkipTests] [-SkipVerify] [-ReportReuse]
.\scripts\install.ps1 -Mode Qualification -CommunityFixtureMap <json>   # test seam
```

## 10. Deliberately unchanged

* The plugin adapter architecture, capability registry, event bus, lockfile and
  every plugin's own code.
* The Harness CLI: the profile is installed by `dsh plugin … add`, and the profile
  manifest is read, never written.
* The renderer's IPC surface. Its handlers are unchanged in name and shape; what
  changed is who owns the lifetime of the object behind them.
* The official Harness renderer, which is never given a preload.

## 11. Boundaries this round did **not** cross

* **The Electron session cookie.** `app/extensions/mega/deepseek/official-session-client.js`
  reads the `dsh-auth-*` cookie from `electron.session.defaultSession`, which a
  plain-Node runtime cannot do. It stays on the Electron side, which is correct —
  it is a browser-session facility, not a runtime one.
* **A third GUI program.** The requirement's later option of a separate Electron
  Browser Host is not built; the *interface* boundary for it is (the page is
  already a capability).
* **Every renderer IPC handler moving to the Host.** The handlers are stateless
  request/response adapters; the lifetime-bearing objects are what moved. Moving
  ~900 lines of renderer login into the Host would have been a rewrite of the
  plugin integration surface, which this round explicitly must not do.
