# The one-click installation, step by step

`Install-DS-Harness.cmd` runs `scripts\install.ps1`. This document is the flow that script
performs, what each step may do to the machine, and where the two **optional community plugins**
fit. It is written from the script itself, and every claim below is asserted somewhere in the
suite (`tests\unit\installer-contract.test.js`, `tests\unit\installer-optional-plugins.test.js`,
`tests\unit\installer-timing-gate.test.js`, `scripts\verify.ps1`).

## The steps

| Step | What it does | May it fail the installation? |
| --- | --- | --- |
| 0/9 | PowerShell parser preflight over every child script | **yes** — a child that does not parse is a defect, not a warning |
| 1/9 | `cleanup-runtime.ps1`, then the bootstrap directory tree | **yes** |
| 2/9 | `install-deps.ps1 -Full`: Node, the harness package, Electron, the binary repair | **yes** |
| 3/9 | Resolve the DeepSeek API key (process/user/machine environment, then the project `.env`, then prompt) | no — it continues unconfigured |
| 4/9 | **Sign the shipped plugins into the Harness profile** — Mega Core, the Health Scheduler and the Restart Supervisor (`install-bundled-plugins.ps1` driving `install-profile-plugin.ps1`, once per plugin) | no — a warning, and the install carries on |
| 5/9 | **The optional community plugins** (this document's second half) | no — every outcome is a report |
| 6/9 | `test-all.ps1`: the unit and architecture gate | **yes** |
| 7/9 | `verify.ps1 -SkipTests`: the invariant checks | **yes** |
| 8/9 | Launcher icon and shortcuts (`-NoShortcuts` skips) | no — degraded icon, or none |
| 9/9 | The completion summary | — |

The order matters in two places, and both are asserted:

* **4/9 before 5/9.** The three built-in plugins — Mega Core, the Health Scheduler and the Restart
  Supervisor — are DS-Hns' *own*, and they are signed into the profile unconditionally, in their own
  step, before any optional plugin is mentioned. Nothing about the community plugins can turn them into
  a choice.
* **5/9 before 6/9.** The optional plugins are settled before the gates run, so a gate failure is a
  real failure rather than something an optional plugin's warning was masking.

## Built-in, versus optional and community

The two are different in kind, and the installer and the summary keep them apart.

| | Mega Core | Health Scheduler / Restart Supervisor | `@dsh-market/plugin` | `dsh-plugin-wallpaper-engine` |
| --- | --- | --- | --- | --- |
| Where it comes from | `app\plugins\mega-core`, shipped in the checkout | `app\plugins\<name>`, shipped in the checkout | published npm package | published npm package |
| Channel | the Harness' own CLI, `file:` spec | the same, driven by `scripts\install-bundled-plugins.ps1` from `scripts\bundled-plugins.json` | the Harness' own CLI, pinned version | the Harness' own CLI, pinned tag |
| Asked about? | never — it is a step of the installation | never — the same step, and `required: true` in the release manifest | yes, unless a parameter answers | yes, unless a parameter answers |
| If it fails | no orb in the official UI; everything else works | the official UI does not list it; the product runs either way | warning, reported `FAILED`, install continues | warning, reported `FAILED`, install continues |
| Recorded in | the profile's `dependencies` | the profile's `dependencies` **and** `data\state\optional-plugins.json` is untouched: they are not optional | `data\state\optional-plugins.json` **and** the profile | same |
| Repair / uninstall | `scripts\install-profile-plugin.ps1 -Plugin mega-core` | `scripts\install-bundled-plugins.ps1 -Repair` / `-Uninstall`, or `scripts\uninstall-ds-harness.ps1` | the plugin CLI, or the store's repair | same |

The two built-in plugins also run inside this product's own plugin host — they are `dshns.plugin/v1`
plugins mounted by `NativeHnsAdapter`, not merely entries in another application's profile. The profile
install is what makes the *official* Harness UI list them and compose their rows; the host mount is what
makes them work. `docs/restart-supervisor.md` and `docs/health-scheduler.md` are their own documents.

## The optional community plugins

Two plugins DS-Hns offers and does not depend on. Both are DeepSeek Harness **client** plugins:
they declare `dsh.bundle.patch` and `dsh.client` in their `package.json`, and the Harness composes
them out of the profile the product boots. Neither is part of DS-Hns' Core, and neither is ever a
hard dependency of starting the product.

### How each one is asked about

Each plugin gets its own question, its own default, and its own answer:

```
  Install the optional community plugin Wallpaper Engine / 壁纸引擎 ?
    [1] 安装 Wallpaper Engine / Install Wallpaper Engine
    [2] 跳过 / Skip
  The default is 2 (Skip). Nothing optional is installed unless you choose it.

  Install the optional community plugin Plugin Market / 插件商店 ?
    [1] 安装插件商店 / Install Plugin Market
    [2] 跳过 / Skip
```

They are **never** bound into one switch, so "the store but not the wallpaper" is something a
person can say. The default is *skip*, and pressing Enter installs nothing.

The questions are asked by the Node command line
(`app\extensions\mega\plugins\community-install-cli.cjs --ask`), not by PowerShell, and the
bilingual text lives in `app\extensions\mega\plugins\community-labels.json`. That is not a style
choice: the installer's PowerShell files are **ASCII-only by contract** (Windows PowerShell 5.1
reads a BOM-less `.ps1` as ANSI, so a Chinese character written into one of them corrupts the
prompt or the parse), and `tests\unit\installer-optional-plugins.test.js` keeps both facts tied
together.

**Who decides whether to ask.** The installer passes `--ask` whenever no parameter answered the
question, and the command line asks only when it really has a console to ask on: with a terminal it
prints the numbered choice and reads the answer; with a redirected or closed stdin `readline`
answers end-of-input, which the command line treats as *skip*. PowerShell cannot tell a terminal
from a pipe reliably, and a guess there would either silence a real prompt or hang an unattended
install — so the check lives where the answer is knowable, and an unattended install installs
nothing rather than blocking or guessing.

### The parameters

Parameters answer the questions, so nothing is asked:

| Parameter | Effect |
| --- | --- |
| `-InstallMarket` | install `@dsh-market/plugin` at the pinned reference |
| `-InstallWallpaper` | install `dsh-plugin-wallpaper-engine` at the pinned reference |
| `-SkipOptionalPlugins` | install neither; record both as declined |
| `-NonInteractive` | ask nothing: same as `-SkipOptionalPlugins`, and a contradiction with a plugin parameter |
| `-Profile <name>` | the Harness profile to install into (default `web`, or `$env:DSH_PROFILE`) |
| `-SkipRuntimeCleanup` | skip step 1/9's sweep, for installing beside another running DS-Harness |
| `-SkipTests`, `-NoLaunch`, `-NoShortcuts` | the pre-existing switches |

```
Install-DS-Harness.cmd -InstallWallpaper          :: just the desktop plugin
Install-DS-Harness.cmd -InstallMarket -SkipTests  :: just the store, no test gate
Install-DS-Harness.cmd -SkipOptionalPlugins       :: neither, and don't ask
```

**A parameter always outranks the prompt**, and the prompt is only reached when no parameter
answered the question.

**A contradiction is an error, never a silent override.** `-InstallMarket -SkipOptionalPlugins`
says two different things, so the installer stops with:

```
-InstallMarket cannot be combined with -SkipOptionalPlugins : one says install an optional community
plugin and the other says do not.
```

and exit code 1 — before any step runs. `-NonInteractive` counts on the same side as
`-SkipOptionalPlugins`. The same rule is enforced a second time inside the Node command line (exit
code 2), because the standalone script is a surface of its own.

**Unattended installs install neither.** With no parameter and no console the question cannot be
answered, so both are skipped — and skipped, not deferred: the choice is recorded so a later boot
cannot install them behind the user's back.

### Which pipeline installs them

There is exactly one path, and it is the one the running product already uses:

```
  installer (5/9)
      │
      ├─ app/extensions/mega/plugins/index.cjs        the release manifest: the pin, the channel
      │
      └─ installBundled(entry, { harnessAdd, verify })
             │
             ├─ channel: harness-profile  ──►  dsh plugin --profile <p> add <pkg>@<ref>
             │                                 (the Harness' own CLI; the same invocation
             │                                  `installPinnedPlugin` makes at runtime)
             │
             └─ verify ──► the adapter framework
                            └─ dshns.harness-profile   reads the installed package
                                                       (detect → select → adapt → standardise)
```

* **Fetching and installing** is `installBundled` in `app\extensions\mega\plugins\index.cjs` — the
  same function the product's own bundled-plugin manager calls. A `dshns-store` entry would go
  through the store's two steps; a `harness-profile` entry goes through the Harness CLI. Which one
  is used is the manifest's `channel`, not a decision the installer makes. There is **no** `git
  clone` into a directory anywhere in the installer, and the CI gate asserts that.
* **The compatibility check** is the adapter framework's. `dshns.harness-profile`
  (`app\core\plugin-adapters\adapters\harness-profile.cjs`) is registered on the same framework the
  runtime builds (`app\plugin-host.cjs`) and reads the installed package the way
  `cordis-structure.cjs` reads any community bundle: the declared patch, the client half, the
  inject list, the peer dependencies — reading only, never importing, never running.
* **The channel is a contract.** If the adapter layer adapts the installed directory as anything
  other than `dshns.harness-profile`, the install is a **failure** with the adapter's own reason.
  `dshns.cordis` will adopt *any* node package into an isolated process, so accepting its answer
  would let the installer print `INSTALLED` for a plugin the Harness will never compose.
* **The verdict is the adapter layer's**, not a directory check. `INSTALLED` in the summary means
  the CLI exited 0 **and** the framework recognised what landed.
* **The state is recorded** in `data\state\optional-plugins.json` (installed / already-installed /
  skipped / failed, with the reason and the reference). A plugin the user declined is a decision,
  not an absence: the boot-time pass reads that file and will not install it behind their back.

### What "optional" means for failure

* Either plugin failing is a **warning** with its reason printed, and the installation continues.
* Both failing still leaves an installed, working DS-Hns with an intact Mega Core.
* A failure is never silent: the summary line reads `FAILED`, the reason is printed, and the state
  file records it. A subsequent run reports it rather than pretending it was skipped.
* If the community command line cannot run at all (no Node, no Harness CLI, no pnpm), that is said
  once and the plugins are skipped.

## The completion summary

```
Installation summary
Official Harness UI ........... OK
DS-Hns runtime ................ OK
Mega Core ..................... LOADED
Plugin Market ................. INSTALLED
Wallpaper Engine .............. SKIPPED
Adapter registry .............. OK
Governance bridge ............. STARTS WITH THE PRODUCT
```

Every line is read back rather than remembered:

| Line | What it means |
| --- | --- |
| `Official Harness UI` | the `@deepseek-ai/dsh` install the launcher boots is present, with the `.cmd` that starts it |
| `DS-Hns runtime` | the shell entry points are present |
| `Mega Core` | `LOADED` (signed in now) / `ALREADY INSTALLED` (was there) / `FAILED` (a warning was printed) |
| `Plugin Market`, `Wallpaper Engine` | `INSTALLED` / `ALREADY INSTALLED` / `SKIPPED` / `NOT SELECTED` / `FAILED` |
| `Adapter registry` | `OK` when every installed optional plugin was verified through the adapter layer; `FAILED` when one was not; `NO OPTIONAL PLUGIN TO CHECK` when nothing was installed — a claim about work never done is not an `OK` |
| `Governance bridge` | a runtime connection: `CONNECTED (last run)` when a discovery file is on disk, `STARTS WITH THE PRODUCT` before the first launch |

## Seeing it for yourself

* The interaction, the parameters, the failure isolation and the summary, without a network:
  `node --test tests\unit\installer-optional-plugins.test.js` — this suite runs the **real**
  `scripts\install.ps1` in a throwaway root, with a stand-in Harness CLI.
* The two plugins' real timings, from the real registry into a real profile:
  `node scripts\installer-community-acceptance.cjs --keep` (opt-in: it needs npm).
* The channel's own adapter, on its own: `node --test tests\unit\plugin-cordis-structure.test.js`
  and the adapter suites beside it.

## Honest limits

* Whether a community plugin's **browser half renders** is the Harness' answer, not this product's.
  The adapter detects the client half, reports its inject list and platform, and marks it
  `servable: false`; the manual UI review in `docs\pluginize.md` is where "it renders" is recorded.
* For `dsh-plugin-wallpaper-engine`, the peers `@deepseek-ai/dsh-client-ui-slots` and `react` are
  **not** resolvable from the module roots on a stock install. `@deepseek-ai/dsh-client-runtime` is
  a platform word the Harness' client-module table supplies at load time, and the adapter reports it
  as `providedAtRuntime` rather than missing. The other two are reported as missing, and the
  acceptance script prints them; whether the Harness supplies them when it composes the bundle is a
  question this product cannot answer from the filesystem. No adapter or state file is bent to make
  that look like a pass.
