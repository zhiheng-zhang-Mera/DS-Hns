# The plugin store against a real repository

The store's install path had never been pointed at a real GitHub repository: every test used an
injected clone. This is the record of doing it for real, against the repository the user named as
the target — `zhu1090093659/dsh-web` (<https://github.com/zhu1090093659/dsh-web>) — on
2026-09-13, with the shipped store, the shipped installer, `node:https` and real `git`.

The outcome is a refusal, and the refusal is correct. What the exercise changed is *how fast* the
refusal arrives, and how much it costs.

## What the target actually is

| Fact | Value |
| --- | --- |
| Layout | pnpm monorepo: `packages/` (22 packages), `market/`, `desktop/`, `shared/`, 8875 files |
| Plugin convention | an npm package declaring `dsh.bundle.patch` → `cordis.patch.yml`, `dsh.engines.dsh`, `dsh.client{platform:"web"}` |
| Host runtime | Cordis (`@deepseek-ai/cordis`) plus the `@deepseek-ai/dsh-*` SDK; entries are ESM |
| Default branch | `dev` |
| Size (shallow, `--depth 1`) | 933 MB / 8143 files / ~34 s |
| `dshns-plugin.json` anywhere in the tree | none (0 of 8875 paths) |

None of that is a defect in the repository: it is a plugin ecosystem for a *different* host, and
"DSH" is the name both hosts share. Its packages cannot run here even in principle — every entry
is ESM (`require` cannot load it), every entry imports the Cordis runtime (absent without
`node_modules`), and none exports the `manifest` this platform's contract requires.

## What the store did, with real numbers

Reproduced with `runtime/tmp/real-install-test.cjs` (a scratch root under the OS temp directory;
nothing in `data/` was touched). The run's own log:

```
## 1. Discovery: what the store can find on GitHub
[store] store search "topic:dshns-plugin" returned 0 of 0 repositories
search ok=true total=0 results=0 ms=427

## 2. Inspect: is the target a DS-Hns plugin?
inspect ok=true installable=false verified=true branch=dev ms=507
url probed: https://raw.githubusercontent.com/zhu1090093659/dsh-web/dev/dshns-plugin.json
code: STORE_NO_MANIFEST
reason: this repository has no dshns-plugin.json at dev, so it is not installable yet

## 3. Pre-flight: the refusal before any download
preflight ok=false code=STORE_BAD_MANIFEST ms=4
reason: zhu1090093659/dsh-web has no dshns-plugin.json at dev: it is not a DS-Hns plugin
        (dshns.plugin/v1), so nothing was downloaded
store dir entries after refusal: 0
store dir bytes after refusal: 0

## 4. The real clone: the whole path, with real git
stage(no verdict) ok=false code=STORE_BAD_MANIFEST ms=36544
reason: the repository has no dshns-plugin.json
full clone seconds: 36.5
store dir bytes after the clone attempt: 0 (files: 0)
the target's store directory exists: false
```

Four facts worth keeping:

1. **GitHub has no repositories for this platform's topic yet.** `topic:dshns-plugin` returns
   `total_count: 0`, so the store's Explore tab cannot find anything on its own today. A repository
   has to be named — by URL or `owner/name` — for the store to have something to check.
2. **The default branch is resolved before the manifest is probed.** The target defaults to `dev`;
   probing `main` would have answered 404 for a repository that is fine and produced a *wrong*
   verdict about somebody else's work.
3. **A verified absence is refused in 4 ms and downloads nothing.** Without the pre-flight the same
   answer cost 36.5 s and 933 MB of disk.
4. **Nothing is left behind.** The failed clone's directory is removed, `installed.json` is not
   written, and the 933 MB did not survive the refusal.

## What this changed in the product

- `installer.preflight()` and the `verdict` parameter of `installer.stage()`: the manifest is
  checked *before* the download, in both the one-shot stage path and the one-by-one install queue.
- `github-store.defaultBranch()`: a bare `owner/name` is priced with one API call so the manifest
  probe uses the repository's real default branch, and an unresolvable branch produces **no
  verdict** rather than a negative one — the clone then decides. A probe that cannot be certain is
  never allowed to refuse a real plugin.
- `github-store.inspect()` returns `verified`, which is the difference between "we looked where the
  manifest has to be" and "we looked where it usually is".

Covered by `tests/unit/mega-store-installer.test.js` (refusal without a clone, unverified verdicts
falling through, a probe that throws, the queue refusing one candidate and installing the next) and
`tests/unit/mega-plugin-store.test.js` (the `dev` default branch, the unverified 404).

## What is still not proven, and how to close it

The clone path is now exercised against a live repository, and the manifest/enable path by tests
with an injected clone — but **no live third-party plugin carrying a `dshns-plugin.json` has ever
been installed end to end**, because none exists on GitHub to install (0 results for the topic, 0
for a code search for the manifest filename).

Closing that gap needs one real repository that is a plugin, not a code change here. The smallest
such repository is a manifest and an entry module:

```
dshns-plugin.json     { "api_version": "dshns.plugin/v1", "id": "…", "name": "…", "version": "1.0.0", "main": "index.cjs" }
index.cjs             module.exports = { manifest: { … }, async load(context) { … } }
```

with the `dshns-plugin` topic on the repository so the Explore tab can find it. Staging, enabling
and mounting it would then exercise the last untested link: a live clone that *passes* validation,
is mounted by the host without a restart, and appears in the plugin list.

## Reproduce

```
# from the repository root, with git on PATH and network access
node runtime/tmp/real-install-test.cjs        # writes runtime/tmp/real-install-run.log
```

The script uses a temporary scratch root and removes it; it never writes into `data/`.
