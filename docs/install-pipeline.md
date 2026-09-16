# The unified install pipeline

After the adapter framework stabilised, three halves of one story were still separate: the store
fetched things, compatibility mode adopted some of them, and the adapter framework adapted whatever
was already on disk. No single place could answer *what is about to be installed, and what will it
be allowed to do*.

`app/core/plugin-install/` is that place.

```
  source ──► materialise ──► inspect ──► plan ──► adapt ──► manager.install
                 │              │          │         │            │
             fetch it,      detect the   the five   the only    Installed /
             do not run it   type, read  things a   way to get  Enabled /
                             deps+perms  person     a plugin    Loaded /
                                         decides    object      Healthy
```

## 1. The rule

> Nothing executes because it was downloaded. It executes because an **adapter** turned it into a
> plugin, and the adapter is the only thing that can.

This is structural rather than remembered. `manager.install()` takes a plugin object; the only
function that produces one is `framework.adapt()`; and `adapt()` refuses when no detector recognised
the artifact or every willing adapter declined it. So "an unknown format must not be executed
directly" is not a check the pipeline performs — there is no other route to the manager, and the
test asserts that a refusal produces `adapterOutput: null`.

What the pipeline adds is what happens *instead*, and the two refusals are different on purpose:

| Verdict | Meaning | What a person does |
| --- | --- | --- |
| `install` | an adapter took it | confirm, and it installs |
| `manual` | a detector recognised the format and the adapter declined this artifact | the attempt list names what each adapter said — usually "the declared entry is not in the repository", which is a build step |
| `refuse` | nothing recognised it | nothing; it is not a plugin this build knows |

## 2. The plan

Everything the requirement names, derived from **the same analysis the install uses** — the plan
object the dialog shows is the object `install()` consumes, because a confirmation that computed
its own answer could disagree with what happens.

| Field | Where it comes from |
| --- | --- |
| `adapter` | which adapter ran, what it detected, the confidence and the evidence |
| `runtime` | the runtime kind, and the `enforcement`/`isolation` that kind actually buys |
| `permissions` | declared, granted, refused (with reasons), unknown |
| `risk` | a level and a score, with the factors that produced it |
| `degradation` | what happens if this plugin is absent or partial — from the capability vocabulary's own fallbacks, plus the structural facts |

**Risk is about reach, not guesswork.** The score is built from facts the platform already decided:
the runtime's enforcement, the permissions actually granted, whether the plugin ships code that runs
in the host's process. A plugin with no code scores 0; `process.spawn` in-process scores high. A
*refused* permission appears as a factor with weight 0 — it is worth showing and is not risk.

## 3. Lifecycle

| Operation | What it does, and when it refuses |
| --- | --- |
| `update` | re-plans from the recorded source; **refuses before fetching** when the plugin is pinned or quarantined |
| `pin` | holds the installed version. Pinning a version that is not installed is refused — that is a move, not a pin |
| `rollback` | re-installs the newest recorded version that is not the current one. A rollback **re-fetches**: the previous files are not kept, and saying so matters |
| `quarantine` | unloads and flags the record so nothing mounts it again. The files, the version history and the reason are all kept — a fault worth quarantining is worth being able to look at |
| `uninstall` | unloads, forgets the record, **keeps the files**, so a reinstall is not a re-download and "why did it fail" stays answerable |

Every mutation is appended to a bounded per-plugin history, which is where a rollback target comes
from. A re-install continues the existing record rather than starting a fresh one, because "this has
been installed three times and failed twice" is the fact somebody needs.

## 4. What the acceptance establishes

```
node scripts/install-pipeline-acceptance.cjs [--samples <dir>] [--json]
```

One real project of each kind, through the whole pipeline — 46 checks:

| Sample | Kind | Proven |
| --- | --- | --- |
| `zhu1090093659/dsh-web#packages/dsh-market` | Cordis | **fetched from GitHub**, planned as `dshns.cordis-dsh` / `isolated-process` / high risk, installed, recorded with provenance |
| this repository's `app/plugins/health-scheduler` | Native HNS | planned as `dshns.native` / `in-process` / medium risk, installed, enabled and loaded through the manager |
| the restart companion over `dsh-restart-supervisor` | Process | planned as `dshns.process` / `managed-process` / high risk, installed, loaded (starting the program), its `restart-control` capability resolvable |

Plus the refusal path (an unrecognised directory → `refuse`, `INSTALL_UNDETECTED`, nothing reaches
the manager) and every lifecycle operation refusing when it should.

**Honest about the network:** the Cordis sample is fetched when the machine can reach GitHub and
falls back to the existing local clone when it cannot — and the report says which happened, because
a skipped fetch is not a successful one. When the fetch did happen the report says `fetched from
GitHub`.

## 5. Why the next plugin needs no Core change

The pipeline names no plugin. The acceptance asserts it: `pipeline.cjs` and `plan.cjs` are scanned
for `dsh-market`, `wallpaper`, `health-scheduler`, `dsh-restart` and `cordis-dsh`, and contain none
of them. Everything plugin-specific lives in an **adapter**, which is registered rather than
compiled in; a new format is a detector and an adapter, and this pipeline is unchanged.

## 6. Defects this phase found in itself

* **`spawnSync` for a long-running process.** The acceptance used it for the stand-in application
  and hung: a synchronous spawn waits for the child to exit, and the child was a `setInterval`. Not
  a slow test — a hung one. It is `spawn` now.
* **The plan's refusal code was only on the plan**, so a caller branching on it had to know where to
  look. It is returned at the top level too.
* **`list()` dropped the provenance**, which is the one field that makes an update possible from the
  record alone.
* **A declared native plugin's `main` was ignored.** A `dshns-plugin.json` naming an entry produced
  a *declarative* plugin — a manifest and no code — even when the entry was sitting beside it. That
  made the format distributable but not runnable, which is a descriptor format, not a plugin
  format. `NativeHnsAdapter` now loads the declared entry (CommonJS first, then ESM) and merges its
  hooks, and refuses an entry that escapes the plugin directory.
