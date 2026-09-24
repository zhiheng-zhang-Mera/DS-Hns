# The native path and the health scheduler

Two changes that belong together: the platform's own plugins stopped having a private loader, and
the first complete plugin written for that loader's replacement arrived.

## 1. `NativeHnsAdapter`, and the loader it replaced

The adapter framework had one hole from the start. Store-installed plugins were adapted; the
product's own shipped sets were handed to the manager as **ready-made objects**, through a function
called `shippedPlugins()`. That was not an optimisation, it was a second loader, and the cost was
concrete: the shipped plugins skipped the standard sections, the per-artifact fault isolation and
the adaptation record that every other plugin had.

An audit of the current tree made the asymmetry visible in one line — a shipped plugin's `list()`
entry had no `adapter`, no `adaptation`, no `runtime` and no `permissions`, because nothing had ever
filled them in.

`NativeHnsAdapter` (`app/core/plugin-adapters/adapters/native-hns.cjs`) is the formal answer:

* `shippedPlugins()` is **gone**; `shippedArtifacts()` returns artifacts;
* `installedPlugins()` became `installedArtifacts()` — it no longer adapts anything either;
* `buildWorld()` runs **one** `adaptMany` over both halves, and there is exactly one occurrence of
  `adapters.adaptMany(` in the host;
* a shipped plugin that cannot be adapted is now a coded failure that affects *that plugin*, not a
  failure of the world build.

Verified rather than asserted: every shipped plugin's `list()` entry now carries
`adapter.id === 'dshns.native'`, `adaptation.detected_type`, a `runtime` block, `permissions` and a
`lifecycle` state — the same shape store installs have. 26 plugins at the time of the change; 27
after the health scheduler joined the set.

## 2. The long-term-hosting capability vocabulary

Long-running hosting needed words for four different things, and the vocabulary keeps them apart
because their **fallbacks** differ — which is the whole point of a documented capability:

| Capability | Meaning | When nobody provides it |
| --- | --- | --- |
| `hardware-health` | read the machine: CPU, memory, thermals, disk | the dimension is `unknown` and its weight is redistributed; unknown is never scored as healthy |
| `runtime-health` | read the runtime: uptime, worker state, loop delay | the runtime dimensions are `unknown` rather than assumed good |
| `health-pressure` | turn readings into one score and a decision | nothing is scored and nothing is mitigated; the runtime keeps running, unmonitored |
| `maintenance-scheduling` | decide whether a window allows work to be deferred | maintenance is never scheduled and work is never deferred for it |
| `restart-control` | *request* a restart; whoever holds the authority executes it | no restart can be requested; monitoring and mitigation continue, and the capability is reported **unavailable** |

The last row is deliberately not part of the health vocabulary. A monitor may **request** a restart;
the authority to perform one is a different capability with a different provider, because a monitor
whose bug can stop the machine is more dangerous than the condition it watches.

## 3. `dshns.health-scheduler`

A `dshns.plugin/v1` plugin in `app/plugins/health-scheduler/`, mounted through `NativeHnsAdapter`
like every other shipped plugin, shipping **disabled** — sampling a machine is a decision a user
makes.

* **Collects** the machine, the runtime, the process, the event loop, the heartbeat, the worker pool,
  the task queue and the restart history, each through an **isolated telemetry provider**. One provider
  throwing is a fault against *that provider*: its dimensions stay `unknown`, the sample's confidence
  drops, and every other provider still answers (`providers.cjs`).
* **Scores** a 0-100 pressure over four dimensions, with weights, and publishes `coverage` and
  `confidence` beside it. A sample that could see too little is `UNKNOWN`, and `UNKNOWN` never escalates
  to a maintenance action.
* **Models** five states — `HEALTHY`, `ELEVATED`, `DEGRADED`, `CRITICAL`, `UNKNOWN` — with hysteresis on
  the thresholds, a debounce on the transitions, and a least-squares **trend** beside them
  (`severity.cjs`).
* **Manages** a maintenance window that may wrap midnight (`23:00`-`01:00` is ordinary, not
  misconfigured) with a **bounded defer**: `maxDeferMs` is how long a restart may wait for the window,
  `deadlineMs` is the hard stop past which the answer is a refusal with a reason rather than another
  deferral.
* **Decides** `NO_ACTION → THROTTLE → PAUSE_NEW_WORK → REQUEST_RESTART` with hysteresis, and
  requests a restart through `restart-control` — never by doing it. A planned machine-level escalation
  is the *supervisor's* maintenance tier and is not reachable from here.
* **Explains** every decision: why it triggered, which metrics, how long it has lasted, the thresholds
  in force, the last action and why that action was chosen (`health-pressure.explain()`).

The restart authority it requests through is `dshns.restart-supervisor` — the one restart executor this
product allows, in process or as its out-of-process companion. `docs/restart-supervisor.md` is the other
half of this document.

### It cannot restart anything, and that is checkable

There is no command, no signal and no process handle in the plugin, and the test asserts it by
**scanning the source** for `shutdown`, `reboot`, `taskkill`, `execFile`, `spawn`, `process.kill`,
`node:child_process`, `SIGTERM` and `SIGKILL`. The scan covers comments too — which is why the
plugin's own prose does not use those words either. A guarantee that needs a parser to check is a
weaker guarantee.

### Starting and stopping on its own

`load` starts the sampler and publishes the four capabilities; `unload` clears the timer and drops
every handle, and the test enables, disables and re-enables the plugin to show that nothing
survives. When a restart authority *is* present, the request goes through it and nothing else
happens — the test uses a stand-in authority that records what it was asked and never acts, which is
exactly what the plugin must depend on.

### Without a restart authority

Everything keeps working. The plugin's health reports **`degraded`** with
`restart unavailable: no plugin provides restart-control`, and the monitoring capabilities answer
normally. `degraded` rather than `unhealthy` is the point: the monitor is working and cannot restart
things, and those are two different facts.

The authority is resolved **lazily, at the moment it is needed**, not once at load — so a companion
started later becomes usable without reloading the monitor, and one that disappears stops being
trusted.

## 4. Defects this phase found in itself

* **The weighted mean made a restart unreachable.** Memory *and* CPU both pinned at critical scored
  **65** — above `throttle`, below `pause` — because a young process and a responsive loop diluted
  them by weight. A monitor that cannot escalate on a machine it can see burning is not monitoring
  anything. The score now adds an escalation term for the worst dimension past 60, so critical
  memory and CPU reach 85, while ordinary load still has to accumulate.
* **`0` as "no restart ever requested"** was indistinguishable from "requested at epoch 0", so under
  an injected clock producing small timestamps the *first* restart request was suppressed by a
  cooldown that had never started. Real wall-clock timestamps hid it; a test clock did not.
* **`decide()` took a sample when it had none.** A read of the state performed a write to it: a
  caller asking "what do you think" silently consumed a reading, and the sampler's drift then
  reflected the *caller's* timing rather than the plugin's. No data is now reported as no data.

## 5. Tests

`tests/unit/plugin-hns-native.test.js` covers the single load path (including a source assertion
that the old loader is gone and that there is exactly one `adaptMany` call), the vocabulary and its
fallbacks, the scoring model including redistribution and escalation, maintenance windows, the action
ladder with hysteresis, the restart gates, the source scan for restart capability, independent
enable/disable, and the two restart-authority cases.
