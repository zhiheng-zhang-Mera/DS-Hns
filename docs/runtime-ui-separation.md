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
instance_id = sha256(canonical root + canonical DSH_HOME + app name + userData choice).slice(0, 16)

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

Four rules make this safe:

1. **The id covers every input that decides a derived path** — the root, the data
   directory, the run's name, and an explicit `DSH_USER_DATA_DIR`. The id names the
   IPC endpoint, the Electron `userData` and the single-instance lock, so two runs
   that differ in *any* of those must not share one. This took three attempts to
   get right, and each wrong version was found by running the code rather than by
   reading it: the id started from the root alone (so one checkout served from two
   data directories shared a lock), gained the home, and finally gained the run
   name and userData choice. The isolation test now states the property directly:
   five runs differing in exactly one input each must produce five ids, five
   endpoints and five userData paths.
2. **Paths keep the filesystem's spelling.** `canonicalize()` produces a
   lower-cased form for *comparison and hashing only*; `resolveRoot()` produces the
   path to *use*, by taking the real spelling of the deepest existing ancestor.
   Lower-casing a path and then opening it works on a case-insensitive volume and
   silently fails on a case-sensitive one.
3. **A record is trusted only when its id, its root and its userData all match.**
   A record found at this instance's path that names another root is a leftover — a
   copied `data` directory, a moved checkout — and is ignored. A record with no
   recorded userData is refused rather than trusted. A record written by an earlier
   naming scheme matches nothing, which is the correct answer: its port and
   endpoint belong to a scheme this build no longer uses.
4. **The primary instance is not migrated.** An isolated instance gets an
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

### Measured on this host (16 logical cores, 32 GB, Node 24.14.1)

Per-phase, as the installer reports it:

| Step | Cost |
|---|---|
| 0/9 parser preflight | 0.3 s |
| 1/9 stale-runtime cleanup + directories | 0.4 s |
| 2/9 dependencies | **8.6 s measured / 0.1 s reused** |
| 3/9 API key | ~0.1 s |
| 4/9 profile plugin | **0.1 s reused** / ~1 s when signed in |
| 5/9 optional plugins | **0.1 s reused** |
| 6/9 tests | **56 s smoke set** (Standard/Fast) / 7.3 min full suite (Qualification) |
| 7/9 verification | 0 s (Fast) / ~40 s (Standard) |
| 8/9–9/9 shortcuts, summary | 0.2 s |

Whole-run totals with state cleared vs. warm, and the smoke set skipped so the
reuse path is what is being measured:

| Run | Total | What ran |
|---|---|---|
| fresh-equivalent (`install-state.json` removed) | **18.2 s** | dependency re-derivation + profile sign-in + optional decision |
| warm reinstall, no code change | **12.9 s** | nothing re-downloaded, nothing re-installed, no suite |
| Fast, with the smoke set | **69.7 s** | the smoke set dominates at 56 s |
| Standard (warm) | **~2 min** | smoke set + verifier |
| Qualification | **~7.4 min** | the full 1812-test suite |

There is deliberately **no universal wall-clock pass/fail number** here. These
figures are one machine's timings, reported so the *shape* of the cost is visible:
the warm path skips dependency work, the profile install, the optional-plugin
setup, the full suite, and every qualification benchmark.

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

## 12. What running it found

Every one of these was a real defect that reading the code did not reveal. They
are recorded because they are the argument for the acceptance runs, not a list of
apologies:

| What happened | Why | Fix |
|---|---|---|
| A one-shot `computerUse.status` query withdrew the page capability it was asking about | a blanket `close` handler called `handleDisconnect()` for *every* connection, not only subscribers | withdrawal belongs to subscribers |
| The second instance could not restart after its own Harness was orphaned | a listening port was treated as "somebody else's" without consulting the ownership record | the record decides: foreign listener / own orphan (reaped) / another live Host (reported) |
| A path that did not exist yet resolved to a *different case* than the filesystem | `canonicalize` lower-cased paths for use, not only for comparison | `resolveRoot` takes the real spelling of the deepest existing ancestor |
| The CLI reported a different instance id for the same checkout than the Desktop had | the id covered the root and home but not the run name | the id covers every input that decides a derived path |
| An isolated instance's `userData` was keyed by an id naming nothing else in the instance | `userDataFor` re-derived the id with two of the four inputs | the id is computed once and passed in |
| The install state said "no previous state" on every run | the CLI's argument parser never initialised its positional list, so `write` silently ran `describe` | positional list initialised |
| The cached host profile was ignored forever | `Set-Content -Encoding UTF8` writes a BOM, which JSON rejects | BOM stripped in both readers |
| The installer invoked the *full* test suite even in Fast mode | an index-based assertion matched prose in a comment | tests locate steps by named markers, not by offset |
