# Compatibility mode

The store used to answer "not a plugin" to a repository that is twenty-two plugins. That was
honest and useless: `zhu1090093659/dsh-web` is an ecosystem of plugins for another DSH host, and
its packages carry no `dshns-plugin.json`, so a user who named one had nothing to install.

Compatibility mode is the alternative, and it is three levels deep:

| Level | What it accepts | What it costs |
| --- | --- | --- |
| **Manifest** | a `package.json` instead of `dshns-plugin.json`; a package inside a monorepo (`owner/repo#packages/x`) | the descriptor is *derived*, so the plugin's own metadata is the only thing that vouches for it |
| **Format** | an ES module entry, which `require` cannot read | loaded by `import()`; a native plugin may ship ESM too |
| **API** | a Cordis-style `apply(ctx, config)` plugin | activated with a small shim context, in **its own process** |

## What a user gets, and what they do not

An adopted plugin is a normal row in the plugin manager — staged, enabled, disabled, removed, and
part of the hot-reload path like any other — with three differences that are stated rather than
smoothed over:

* **Its capabilities stay in its own process.** The host does not register them, so an adopted
  plugin cannot satisfy another plugin's requirement. A compatibility plugin is a *leaf*.
* **There is no health contract.** `healthCheck` reports whether the isolated process is alive,
  nothing more.
* **It is not part of `dshns-lock.yaml`.** The lock describes the product's composition; a user's
  adoption is not drift.
* **It is never enabled automatically**, and it enters as `default_enabled: false` in the manifest
  the manager sees.

The four guarantees are also rendered in the panel, on the plugin that is subject to them.

## Nothing runs on its own

Two states are answered by real work on the user's machine: installing the dependencies a package
declares, and running the build script that produces an entry the repository does not commit. Both
are *described* — the exact executable, argv, directory and whether lifecycle scripts are enabled —
and **the shell** shows them in a confirmation dialog. The renderer can ask twice; it cannot install
anything. `deps.runDescribed` refuses without `confirm: true`, and a test proves it by checking that
a command which would create a file did not create one.

Lifecycle scripts are off (`--ignore-scripts`) for a dependency install, because a third-party
`postinstall` is the most dangerous thing in this flow. A *build* is the one action where they are
on, because a toolchain is reached through scripts — and the dialog says so.

## The real run

`runtime/tmp/real-compat-test.cjs`, against the live repository, two packages, real `git`:

```
## zhu1090093659/dsh-web#packages/dsh-market
inspect: installable=false verified=true code=STORE_NO_MANIFEST
pre-flight with compatibility mode OFF: ok=false code=STORE_BAD_MANIFEST
staged: id=compat.linxin666.dsh-client-ui-market compatibility=compat state=needs-dependencies
  dependencies=["schemastery","react"] build=build
  clone+derive took 3.9s; the package on disk is 0.48 MB in 42 files
enable: ok=true compatibility=compat state=needs-dependencies (2 runtime dependencies are not installed)

## zhu1090093659/dsh-web#packages/dsh-i18n
staged: id=compat.linxin666.dsh-i18n compatibility=compat state=needs-build
  reason: the declared entry lib/index.js is not in the repository; the package's `build` script
          (`tsc -p tsconfig.build.json && tsdown`) produces it
  clone+derive took 3.8s; the package on disk is 0.15 MB in 33 files

## Activation in the host (isolated processes)
- compat.linxin666.dsh-client-ui-market
    status=needs-dependencies
    reason: schemastery is not installed
    missing packages reported by the worker: ["schemastery"]
    commands it would need (none of them run):
      npm install --ignore-scripts --no-audit --no-fund schemastery
    node_modules created anywhere in the store: false
- compat.linxin666.dsh-i18n
    status=needs-build
    commands it would need (none of them run):
      npm install --no-audit --no-fund
      npm run build   (a build runs the package's own toolchain: `tsc -p tsconfig.build.json && tsdown`)
an unconfirmed setup run is refused: ok=false code=COMPAT_NOT_CONFIRMED
host compatibility summary: {"total":2,"running":0,"needsDependencies":1,"needsBuild":1,"failed":0,"unsupported":0}
```

Four things that run is worth keeping:

1. **A package inside a monorepo costs the package, not the repository.** 0.48 MB and 3.9 s, against
   933 MB and 36.5 s for the whole tree — because `#packages/dsh-market` is cloned with
   `--filter=blob:none --sparse` and sparse-checked out. When a git or a server cannot do a partial
   clone the installer falls back to a full shallow clone and keeps the package anyway.
2. **The worker's answer is specific.** One real missing package (`schemastery`), not "failed to
   load": that is what makes the confirmation dialog worth showing and what makes the install
   command correct.
3. **The build command is a script name.** The package's build script is the command line
   `tsc -p tsconfig.build.json && tsdown`; the command offered is `npm run build`, with the inner
   command shown beside it. The first live run offered `npm run tsc -p …`, which cannot work — the
   live run is what found that.
4. **Nothing was installed and nothing was built.** `node_modules` does not exist anywhere in the
   store after the run, and the two plugins report exactly which command would be needed.

## What this does not do

An adopted plugin's own **runtime dependencies are not installed for it**, and its foreign API is
not emulated beyond a small shim. A dsh-web plugin that expects the Cordis container, the
`@deepseek-ai/dsh-*` SDK and a browser half will not become functional because of this mode: what it
gets is an honest install, an honest state, and an honest reason. The mode exists so the store can
say *which* of those it is instead of "not a plugin".

Two boundaries worth stating plainly, because the words around isolation invite more than they mean:

* **The isolated process is containment, not a security sandbox.** The worker runs with the same
  user's privileges and can read and write what the application can. What the process boundary buys
  is that an import-time throw, a `process.exit`, a hang or a crash ten minutes later stay in the
  child instead of reaching DS-Hns.
* **A confirmed install or build inherits the environment**, which is what makes a private registry
  or a corporate proxy work — and which means anything in that environment is visible to the
  package's own scripts. That is why the command, its directory and whether lifecycle scripts are
  enabled are all shown before the user agrees.

## Reproduce

```
node runtime/tmp/real-compat-test.cjs      # writes runtime/tmp/real-compat-run.log
```

The script clones two packages of the live repository into a temporary root, mounts them in a real
host, activates them in real child processes, and removes the temporary root afterwards —
`data/` is never touched.
