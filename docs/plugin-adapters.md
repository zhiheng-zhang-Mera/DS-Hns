# The plugin adapter framework

DS-Hns has one plugin model: `dshns.plugin/v1`, a manifest plus four optional lifecycle hooks,
mounted through the plugin manager and governed by the capability registry, the event bus, the
fault levels and the health supervisor. None of that changed.

What changed is how something that is *not* already in that model becomes part of it.

## 1. The problem this exists for

Compatibility mode was the first answer, and it worked by teaching the host about one foreign
ecosystem. `plugin-host.cjs` grew a branch that read `dshns-plugin.compat.json`, built a compat
plugin and mounted it. That is a fine shape for exactly one format and a bad shape for two:

* every new format is another branch in the host, in the file that also owns the shell's whole
  plugin picture;
* the branch decides *how to load*, which is where an isolation boundary lives — so a new format
  means re-deriving the containment argument;
* "which format is this" and "how do I run it" end up in the same `if`, so neither can be tested
  on its own.

The framework splits those apart. The host now knows that plugins arrive in *some* external
format; the adapters know which ones.

## 2. The pipeline

```
artifact ──► detect ──► select ──► adapt ──► validate ──► standardise ──► unify ──► plugin
              │          │          │           │             │            │
           evidence   one of N   third-party  the output   the platform's  the standard
           on disk    adapters   code runs    is the right own manifest    interfaces
                                              shape        contract
```

* **`app/core/plugin-adapters/detect.cjs`** — names the type, with evidence. Reads files; never
  imports, runs or writes anything.
* **`app/core/plugin-adapters/registry.cjs`** — registration and selection. Ordering is total:
  higher priority first, then adapter id, so which adapter ran never depends on registration order.
* **`app/core/plugin-adapters/contract.cjs`** — the adapter contract, the permission vocabulary,
  the runtime kinds, and `standardizeManifest()`, which puts an adapter's output through the
  platform's own `validateManifest`.
* **`app/core/plugin-adapters/lifecycle.cjs`** — the unified lifecycle, runtime information and
  error reporting.
* **`app/core/plugin-adapters/index.cjs`** — `createAdapterFramework()`: the seam the host uses.

## 3. The standard descriptor

Whatever the source format, a plugin reaches the manager as a `dshns.plugin/v1` manifest plus four
optional hooks. Three sections are filled in by the framework, not by the adapter:

| Section | What it says |
| --- | --- |
| `permissions` | `declared` (everything it asked for), `granted`, `refused` (each with a reason), `unknown`, `complete` |
| `runtime` | `kind`, and the `enforcement` / `isolation` that kind actually buys |
| `adapter` | which adapter produced it, at what version, out of which detected type |
| `health` | the health contract the plugin is subject to |

The manager stores and reports them and never interprets them. Every plugin therefore has the same
fields — `apiVersion`, `permissions`, `runtime`, `adapter`, `adaptation`, `lifecycle`,
`errorCount` — and one panel can render all of them.

## 4. Permissions

The vocabulary is closed and documented (`PERMISSIONS` in `contract.cjs`): `fs.read`, `fs.write`,
`process.spawn`, `network`, `bus.emit`, `bus.subscribe`, `capability.provide`,
`capability.consume`, `config.read`, `settings.write`, `worker.control`, `ui.render`.

Three rules make a declaration worth reading:

1. **The platform decides, not the adapter and not the plugin.** An adapter proposes; the plugin's
   own `permissions.declares` is unioned with that proposal; the vocabulary and the deployment
   policy are then applied. A policy (`{ allow, deny }`) can only narrow.
2. **Everything asked for is kept in `declared`,** including names the platform cannot honour. An
   unenforceable request that vanished from the request display would be the exact dishonesty a
   permission surface exists to prevent.
3. **A refusal is a fact, not a failure.** A plugin with refused permissions still loads; the panel
   shows what it does not have. Refusing to load it would be the platform taking a decision the
   user was never offered.

## 5. Runtime kinds, and the enforcement each one has

A single "isolated: true/false" flag blurs an advisory declaration and a real process boundary into
one word. The vocabulary states the boundary instead:

| Kind | Enforcement | What it means |
| --- | --- | --- |
| `in-process` | `advisory` | runs in the shell; the declaration is recorded and shown, and nothing enforces it |
| `isolated-process` | `process-boundary` | its own child process: a throw, an `exit`, a hang or a later crash stay there |
| `declarative` | `declared-only` | contributes configuration and no code |
| `remote` | `protocol` | runs elsewhere; the boundary is the protocol |

`isolated-process` is **containment, not a sandbox**: the child runs with this user's rights. That
is why the Cordis adapter declares `fs.read`, `fs.write`, `network` and `process.spawn` for an
adopted plugin rather than the comfortable subset.

## 6. Failure isolation

The requirement is one sentence: *an adapter failure affects its plugin and nothing else, and never
stops DS-Hns from starting.* It is implemented in four places, because one would not be enough:

* **`adapt()` never throws.** A detector that throws, an adapter that throws, an adapter that
  returns `null`, a descriptor with no manifest, a manifest the platform refuses — all six are
  coded values.
* **A refusal is preserved, not masked.** An adapter returning `{ ok: false, code, reason }` gets
  its own code reported. Treating every return value as a descriptor is how
  `"the entry is not in the repository"` becomes `"invalid output"`.
* **Every willing adapter is tried.** A specific adapter that recognises a format but cannot handle
  *this* artifact does not stop a broader one from having its turn; every attempt is kept in
  `plugin.adaptation.attempts`.
* **The host adapts a batch.** `adaptMany()` returns a failure per artifact and never one for the
  batch, and the failures are merged into `status().errors` with a `source: 'adapter'` marker, the
  code and the phase — because an entry that never became a plugin has no row in the manager's
  fault map, and it is exactly the failure a user needs to see.

`tests/unit/plugin-adapters-fault-injection.test.js` is the proof: a host whose installed set is
nothing but broken plugins still boots, still mounts the shipped set, and reports every one of them.

## 7. What the two shipped adapters promise

**`dshns.native`** (priority 100, `in-process`) — the platform's own format: `dshns-plugin.json`,
or an imported module exporting a manifest. The manifest is the author's own declaration, the
plugin's own hooks run unchanged, and the permissions proposed are exactly what the author wrote.
A declaration with no entry becomes a `declarative` plugin rather than an invented runtime.

**`dshns.cordis`** (priority 10, `isolated-process`) — somebody else's package. Classification is
still `extensions/mega/store/compat.cjs`; activation is still a child process through
`core/plugin-compat`. **The isolation boundary is unchanged by this work**, which is why the
adapter delegates to those modules rather than reimplementing them. The guarantees are the ones
compatibility mode already stated: capabilities stay in the child, there is no health contract
beyond process liveness, it is never in the lockfile and never auto-enabled.

## 8. Adding a format

`app/core/plugin-adapters/adapters/mock.cjs` is a worked example, and it is deliberately a format
the platform has never seen. Registering it is two calls:

```js
framework.detector.register(createMockDetector())
framework.register(createMockAdapter())
```

or `registerMockFormat(framework)`, which is those two. Nothing else changes: not the framework,
not the registry, not the contract, not the plugin manager, not the host. The test suite asserts
that the platform's type vocabulary is unchanged by the extension, and drives a plugin in that
format through detection, adaptation, load, health and unload.

A real adapter is the same shape with a real format behind it:

1. a **detector** that reports a type and the evidence for it;
2. an **adapter** declaring `supports`, an optional `accepts`, and `adapt()` returning
   `{ manifest, load?, unload?, healthCheck?, runtimeInfo?, permissions?, runtime?, health? }`.

## 9. What is not done

* **The panel does not render the new sections yet.** `host.adapters()` and the per-plugin
  `permissions` / `runtime` / `adaptation` / `runtimeInfo` / `errorReport` fields are all exposed,
  and `describe()` returns the whole vocabulary, but no UI consumes them. The data is there; the
  view is not.
* **Permissions are declared, not enforced at the syscall level.** `enforcement: 'advisory'` for an
  in-process plugin is the honest description: the declaration is recorded and shown, and nothing
  stops in-process code from doing otherwise. Making it real needs a boundary that does not exist
  yet — which is what `isolated-process` is for.
* **The policy is a host option with no UI.** `createPluginHost({ permissionPolicy })` exists and
  is tested; nothing writes it from settings.
* **`remote` is a declared vocabulary entry with no adapter.** No plugin runs that way today; the
  kind exists so that one can, and so the honesty table has a row for it.
* **The migration is not exhaustive.** The store's staging path still does its own classification
  through `classifyCompatible`, which is correct — that is a *pre-install* question about a
  repository, not a *mount* question about a plugin — but it means the classifier and the detector
  both read `package.json` and could drift.

## 10. Tests

| File | What it pins |
| --- | --- |
| `plugin-adapters-contract.test.js` | the adapter contract, the permission vocabulary and resolution, manifest standardisation |
| `plugin-adapters-detection.test.js` | detection with evidence, detector isolation, registration and total selection order |
| `plugin-adapters-lifecycle.test.js` | the unified lifecycle, idempotency, health normalisation, runtime info, bounded error reporting |
| `plugin-adapters-framework.test.js` | the pipeline end to end, the mock format as the extensibility proof, policy, fallback, budgets |
| `plugin-adapters-fault-injection.test.js` | adapter and detector failures, host boot with a wholly defective installed set |
| `plugin-adapters-compatibility.test.js` | the old contract and the compat guarantees still hold; the manager and host name no external format |
