# The managed-process adapter

Some plugins should not run inside DS-Hns at all. A supervisor that must outlive the application, a
Python model server with its own interpreter, a compiled helper with its own lifetime. None of them
can be adapted by *loading* them. They have to be **run**.

`ProcessPluginAdapter` runs them. The rule it is built around is the one thing an adapter must never
do:

> The adapter understands *processes*. It does not understand what any process is for.

## 1. The declaration

A process plugin is a directory with a `dshns-process.json` beside its code:

```json
{
  "api_version": "dshns.process/v1",
  "id": "restart-companion",
  "name": "restart-companion",
  "version": "1.0.0",
  "command": ["node", "companion.mjs"],
  "transport": "stdio-jsonl",
  "heartbeat": { "intervalMs": 500, "timeoutMs": 4000, "handshakeTimeoutMs": 15000 },
  "restart": { "policy": "on-failure", "maxRestarts": 2, "windowMs": 60000, "backoffMs": 150, "backoffMaxMs": 500 },
  "provides": { "capabilities": [{ "name": "restart-control", "methods": ["status", "request", "cancel"] }] },
  "permissions": { "declares": ["fs.write", "process.spawn"] },
  "env": { "MY_SETTING": "yes" }
}
```

`command` is an **argv array**, never a string. A string would be run through a shell, and a shell
is a second language in which a plugin manifest can express "and then run this other thing".

`env` is the same idea applied to the environment. A managed process does **not** inherit the
host's: it gets `PATH`, `SystemRoot`, the two protocol variables and exactly what it declared.
Inheriting `process.env` would hand a third-party background program every token, key and proxy the
shell happens to be carrying.

## 2. The controlled protocol

Two transports, and they are the whole vocabulary:

| Transport | How it works |
| --- | --- |
| `stdio-jsonl` | newline-delimited JSON on the child's own stdin and stdout. **stdout is protocol, stderr is log** — never each other, so a plugin that prints a stack trace cannot be mistaken for one that sent a message. |
| `localhost-jsonl` | a loopback TCP socket, for a plugin that owns its standard streams. The child is given a per-start token and must present it as its first line; a non-loopback peer is refused. |

Both are text, and that is the point: **there is no way to put an object, a handle or a function
into one.** "Never hand the plugin an HNS object" is not a rule anybody has to remember here,
because no encoding could carry one.

The frame vocabulary is closed — `ready`, `heartbeat`, `log`, `provide`, `invoke`, `result`,
`shutdown`, `welcome`, `bye`, `fault`. A line that is not JSON, or JSON that is not an object, or an
object whose `kind` is outside that list, is a **coded fault that is counted and reported**. Nothing
is quietly dropped: a frame the host ignored but the plugin believes was delivered is worse than a
loud refusal.

## 3. What the adapter manages

`app/core/plugin-adapters/process/supervisor.cjs` owns exactly these, and nothing else:

* **start** — one attempt, one outcome. A process that does not say `ready` inside the handshake
  budget is a failed start, not an inline retry.
* **stop** — ask, wait, terminate, wait, and report which stage it took. All three bounded.
* **status** — process state, pid, transport, uptime, declared surface, exit history, restart budget.
* **heartbeat** — freshness computed when it is asked, not stored. A missed beat **degrades** the
  process rather than failing it: killing something merely quiet turns a slow machine into a restart
  loop.
* **exit codes** — classified as clean / failure / signal, because that classification is what the
  restart policy acts on.
* **bounded restart** — see below.
* **logs** — a bounded ring of stdout/stderr lines, truncated per line.
* **permission declaration** — through the platform's permission vocabulary, with `process.spawn`
  and `fs.read` proposed by the adapter and the rest from the plugin's own declaration.
* **fault isolation** — nothing in these modules throws.

### The two loops, and how they are bounded

A supervisor that restarts things *is* a loop, and a loop with no bound is an outage:

* **The restart loop.** `maxRestarts` inside `windowMs`, with a doubling backoff capped at
  `backoffMaxMs`. When the budget is spent the process enters **`safe-mode`**, which is terminal,
  and the reason names the exit codes. This holds under `policy: always` — the setting that would
  otherwise loop forever.
* **The handshake loop.** Every start is one attempt. Retrying is the restart policy's decision, and
  the policy is bounded.

Three real defects were found here by tests and fixed, and each is the kind that ships silently:

1. **The restart timer was `unref`'d.** An otherwise-idle host then simply *exits* instead of
   performing the restart: whether the restart happens at all depended on what else the event loop
   was doing. No timer in this module is unref'd now — each belongs to an operation a caller is
   awaiting.
2. **A crash before handshake cancelled its own restart.** The handshake-failure path called `stop`,
   which cleared the pending restart — so the restart policy applied only to processes that had
   *managed to start*, which is exactly backwards for a crash loop.
3. **`waitForReady` did not resolve when the child died.** A process that exited immediately left
   the start attempt waiting out the whole handshake budget.

A fourth came from the surface rule below: **a process could widen its own surface at handshake.**

## 4. Declared, not discovered

A process announces what it offers in its `ready` frame, and the manifest declares it too. The
**manifest is authoritative**, and the announcement is treated as a *confirmation* of it. If a
process could widen its surface at handshake, a plugin could ship a one-method manifest, offer ten
at runtime, and everything the platform showed about it before it started would have been decoration.
A claim beyond the manifest is refused and recorded as `PROCESS_UNDECLARED_CAPABILITY`.

This is also why a managed process's capabilities **do** register in HNS, unlike an adopted Cordis
plugin's. The difference is the transport rather than a policy: the capability is reached by sending
the process a declared method call and reading the reply, so the host is not handing over an object —
it is sending a message. The runtime block says exactly that: `kind: managed-process`,
`enforcement: protocol`.

## 5. Acceptance

```
node scripts/process-adapter-acceptance.cjs [--companion-repo <dir>] [--json]
```

The subject is the **real `dsh-restart-supervisor`**. The companion
(`tests/fixtures/process/restart-companion.mjs`) runs it and speaks the process protocol; DS-Hns
starts that companion as a plugin and keeps exactly one thing on its side: a `restart-control`
capability bridge.

Four claims, and how each is checked:

| Claim | How |
| --- | --- |
| DS-Hns holds no restart logic | the adapter and supervisor sources are scanned for the vocabulary of the business (`ticket`, `relaunch`, `supervisor.mjs`, …), and every answer about the restart comes from the companion's own reading of the supervisor's files |
| A companion crash leaves DS-Hns running | the companion is killed; the manager, its registry and its list are shown untouched, and the crash is *reported* rather than thrown |
| An application crash is handled per protocol | the watched process is killed; the supervisor notices, records an unclean start and relaunches it, and the new pid is shown live |
| No infinite restart loop | the companion is crashed until its budget is spent; the state is terminal, the exit count stops growing, and the reason is recorded |

**What it does not do, stated rather than implied:** the "application" whose crash is handled is a
**stand-in process**, not the real DS-Hns — a test cannot usefully kill the application it is running
inside. The companion, the supervisor, the protocol and the watched-pid handling are the real ones;
only the identity of the watched process differs. Nothing in the acceptance restarts DS-Hns.

## 6. Tests

`tests/unit/plugin-process-adapter.test.js` covers the contract (argv, transports, closed frames,
granted environment), both transports, the lifecycle, the heartbeat, the crash-loop bound, the
clean-exit rule, the manifest-authoritative surface, and the business-free claim — against real
child processes that really die.
