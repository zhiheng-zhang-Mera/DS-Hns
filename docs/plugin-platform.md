# Plugin platform and acceleration

DS-Hns used to be a runtime whose features were reached by `require`. The plugin
platform makes each of them a *mountable* thing with a declared capability, so a
feature can be switched off and the runtime keeps working — and so the fallback
promised for its absence is a statement somebody checks rather than a hope.

Above that sits the acceleration set: the repository map, the dirty context, the
reasoning governor, tool batching, the caches, persistent tools and single-task
parallel execution. This document describes what the platform guarantees, what each
accelerator is allowed to do, and how the acceptance standards are met.

## 1. The pieces

```text
core/contracts/plugin.cjs         the contract: dshns.plugin/v1, the four states,
                                  the three fault levels, manifest validation
core/plugin-manager/index.cjs     install, enable, load, unload, reload, health
core/capability-registry/index.cjs who provides what, and a refusal when two
                                  plugins claim the same capability at one priority
core/event-bus/index.cjs          events, with listener isolation and bounded subs
core/config-manager/index.cjs     defaults < profile < plugin config < override
core/resource-manager/index.cjs   effectiveWorkers, from the machine and the queue
core/health-supervisor/index.cjs  what to do about a plugin that is not healthy
plugins/mounted/index.cjs         the features that already existed, wrapped
plugins/acceleration/index.cjs    the accelerators, as plugins
plugins/providers/deepseek/       the model knowledge no generic plugin may carry
```

## 2. The rules that make it a platform

**Depend on capabilities, never on plugin ids.** A plugin declares
`requires_capabilities` and `optional_capabilities`; the manager resolves them in
capability order. The long-term worker does not import a checkpoint store — it
requires `checkpoint` and takes whatever provides it. The parallel executor requires
`resource-management`, which is why it refuses to load without a resource manager
rather than inventing a worker count.

**A capability is a closed, documented vocabulary.** Every name in
`core/contracts/capability.cjs` says what it means, which plugin is expected to
provide it, and what happens when nobody does. `repo-map` falls back to text search;
`command-cache` falls back to running every command; `workspace-isolation` falls back
to refusing parallel writes. A capability nobody can describe cannot be depended on.

**Four states, not one.** A plugin is *installed*, *enabled*, *loaded* and *healthy*
independently. Installed-and-not-enabled is a normal state (that is what "switch
computer-use off" means), loaded-but-unhealthy is a normal state (that is what a
degraded accelerator reports), and conflating them is how "it's off" and "it's
broken" become the same support ticket.

**Three fault levels, and nothing else.** SOFT (telemetry, caches) never affects the
task. DEGRADED (the repo map, computer-use, the parallel executor, isolation) uses its
fallback and keeps going. FATAL (workspace corruption, an incompatible contract)
stops. No accelerator is FATAL: none of them is important enough to end an episode.

**Model knowledge is a provider, not a branch.** A generic plugin may never test a
model name. It asks a descriptor what the model can do — tool calling, reasoning
control, prompt caching, context window — and the profile decides the policy.
`contracts/model.cjs` narrows a reasoning request to the model's ceiling *and reports
the substitution*, because silently asking for less and saying nothing is how a
quality regression becomes invisible.

## 3. The accelerators

Each one makes the runtime faster, so each one has a way to be wrong that is worse
than being slow. The failure each guards against is the reason it exists.

```text
repo-map              the five questions a step has: where is this defined or
                      re-exported, who uses it, what does this file import, what
                      breaks if I change it, which tests run first. Scanned once,
                      bounded, and rebuilt rather than assumed: a stale map is worse
                      than no map, because it makes the runtime confident about the
                      wrong thing. Destructured and side-effect requires are edges
dirty-context         stable prefix first, then task, symbols, diff, failure, inside a
                      budget that declares what it dropped instead of dropping it
context-cache         the stable prefix reused across calls, with the reuse counted
reasoning-governor    the level follows the work and comes back down: two clean steps
                      after a failure return the session to its default
tool-batcher          read-side calls fold into one round trip; a write is never folded
                      in, because a partial write inside a batch has no owner
command-cache         a test/lint/typecheck/build result is reused only when the
                      command, the relevant file hashes and the environment fingerprint
                      are all identical. A failing run is never cached, and it drops
                      the previous entry
persistent-tools      the shell, LSP, browser and model session stay alive across
                      steps. A handle is never reused on faith (the probe is real),
                      never lives forever (bounded reuse and idle TTL), and at capacity
                      the runtime refuses rather than closing a session mid-step
incremental-validation tier 1/2/3 from the change itself; the stricter of "what the
                      change warrants" and "what the moment allows" wins; only the full
                      tier may approve completion
patch-first           AST edit > targeted patch > FIM > whole-file, and a *refusal*
                      naming the file and change size instead of a rewrite
parallel-executor     one task's dependency DAG in waves and lanes: readers together,
                      disjoint write sets together, overlapping writes serialized
workspace-isolation   the verified git worktree behind the one exception to that rule
```

## 4. Single-task parallelism

The plan's point is not several agents editing files at once; it is one task's
dependency graph running where the graph allows it. Four modes, from the UI:

```text
Off          everything alone — for debugging, benchmarks and reproductions
Safe         parallel reads, serial mutations
Adaptive     the default: parallel reads, independent write sets in parallel
Aggressive   parallel coding workers, each in its own worktree
```

Two rules are enforced rather than documented:

* **A write is never in a wave beside a node that touches its files.** Two writers of
  one file do not merge, they overwrite, and the loser's work disappears with no diff
  to prove it existed. The read-write pair is treated as a conflict too: a reader
  beside a writer of the same file returns a result that depends on scheduling, which
  is a flaky task rather than a parallel one.
* **Aggressive mode is the only exception, and it is not silent.** Overlapping writers
  run together only when each has its own verified worktree, and the run then reports
  `requiresIntegration` with the conflicting files — because two isolated writers that
  touched one file have two answers and somebody has to choose. When isolation is
  unavailable the executor serializes those writes, and when isolation refuses
  mid-wave the run stops instead of falling back to a shared tree.

Model calls funnel through **one** queue in every mode. Task parallelism is not model
parallelism: starting a model instance per worker is how VRAM is exhausted.

The worker count comes from the resource manager, never from the core count. At a hard
ceiling it allocates zero and says which bound applied. Acceptance B reports when the
machine was under pressure and the core-derived bound had to be substituted.

## 5. The workbench surfaces

**Plugins** (the plan's section 46). The panel reads the set, grouped the way the plan
draws it — Execution, Autonomy, Coding, Performance, Observability — and shows each
plugin's four states separately, because "off" and "broken" are different answers and a
single checkbox would blur them. Clicking one shows its version, API version, status,
health with the reason, latency, capabilities, required and optional dependencies (with
anything *missing* called out), the config block with the layer every value came from,
its recent faults, and the restart count. It offers Enable / Disable, Restart, a health
probe and "Write lock".

**Execution** (the plan's section 45). The mode selector, worker cap, parallel
read/tests/model-calls/writes, workspace isolation and the CPU/RAM/GPU limits. Each field
is labelled with the layer its value came from (`default`, `profile`, `plugin-config`,
`override`), and the panel shows what the chosen mode actually permits and what the
resource manager derived — including the bound that applied when it allocated fewer
workers than asked for.

The panel is a *control surface*, and that is enforced rather than promised: it never
receives a plugin object, never names a capability to provide and never touches a file.
It asks the shell to enable, restart or reconfigure a plugin **by id**. A settings panel
that could install code would be a remote-code-execution surface wearing a checkbox, so
the shipped gate asserts the panel reaches the platform only through `window.megaPlugins`
and that it contains no filesystem or process call at all.

Settings are written where the platform already reads them — `config/plugins/<id>.json`,
the config manager's "what the user decided for one plugin" layer — and the world is then
rebuilt, so the value the panel displays is the value the runtime uses. A refused value
(unknown key, out of range, wrong type) changes nothing and comes back with the reason.

## 6. The lockfile

`dshns-lock.yaml` (the plan's section 40) records the plugin set and its versions so a run
can be reproduced. The format is YAML because a human may read or edit it, but the only
shape it may contain is the one the parser understands:

```yaml
plugins:
  dshns.computer-use:
    version: 1.0.0
```

Anything else — a second top-level key, a duplicate id, a missing version, a list — is
refused with a reason and a line number rather than guessed at, because a lockfile parser
that silently ignores what it does not understand reports a stability that was never
checked. `verify` compares a lock against the plugins actually installed and reports
exactly which were added, removed or moved. Drift is a *refusal* when the deployment sets
`plugins.enforceLock`, never a warning with a shrug.

The shipped lockfile is asserted against the shipped set by the test suite, so it cannot
quietly go stale while the build stays green.

## 7. Acceptance

`node scripts/combined-acceptance.cjs` runs one report over:

```text
A  the plugin platform     turn each feature off; the runtime keeps working
B  single-task parallelism the same task under Off / Safe / Adaptive, compared on
                           wall time, model calls, rollbacks and correctness
C  acceleration            baseline against optimized on one commit and one task,
                           measured as Time To Accepted Patch
D  long hosting            nine injected faults: model timeout, shell crash, tool
                           timeout, test failure, UI miss, plugin failure, context
                           rebuild, git conflict, process restart
E  section 150             the engineering runtime's 26 completion conditions, each
                           bound to the named passing test that proves it
```

The work in B and C is real — a temporary repository with a genuinely failing test, a
real one-line fix, real `node --test` runs and the real accelerator modules. Where
something cannot be measured honestly on this machine, the report says so: no language
model is called, so Time To Accepted Patch uses a *declared* per-call latency and the
number that is genuinely measured is the round-trip count per configuration.

The run fails the build when any check fails, and CI runs it on every push. A green
build that never ran the acceptance is how an acceptance standard quietly stops being
true.

## 8. Turning it off

Every accelerator is a plugin with a machine-readable manifest, so the platform's
behaviour without it is testable rather than theoretical:

```text
repo-map off              text search over the workspace
command-cache off         every command runs
context-cache off         every call sends its own prefix
parallel-execution off    the task runs serially
workspace-isolation off   parallel writes are refused, and adaptive mode serializes
telemetry off             no performance claim can be made from the run
```

The `dshns.plugin/v1` contract, the capability vocabulary and these fallbacks are what
acceptance standard A actually tests.
