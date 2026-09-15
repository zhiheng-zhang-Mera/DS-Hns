# dsh-plugin-mega-core

The DS-Hns **Mega Core** plugin for the official DeepSeek Harness UI (`updateplan/pluginize.md` Phase 1).

It is the plugin half of the plan's architecture change: Mega stops being a window beside the official UI and
becomes a plugin **inside** it — a full page for governance, opening from the official Settings.

## What is here

The **host half** (`lib/index.js`), the **view model** (`lib/view.js`), the **browser half** (`lib/client.js`),
and the packaging that makes all of it a Harness plugin:

* `dsh.bundle.patch` → `cordis.patch.yml`, which inserts one host row (`mega-core`);
* `dsh.client` → the browser half is declared (`platform: web`, `immediately: true`, injected with
  `@deepseek-ai/dsh-client-runtime`);
* five same-origin routes for the browser half to fetch:

| route | what it answers |
| --- | --- |
| `GET /mega-core/health` | whether the plugin is up, and whether DS-Hns' governance bridge is reachable |
| `GET /mega-core/governance` | the snapshot the Control Center shows (plugins, protection, boot, pending work) |
| `GET /mega-core/view` | the same snapshot composed into what the page (and the system ball) draw (§4.2-§4.4) |
| `POST /mega-core/action` | one of the named actions: `check`, `retry`, `reset-fallback`, `repair`, `disable`, `enable` |

The host half holds no state. DS-Hns owns governance behind its loopback bridge
(`app/core/governance-bridge.cjs`, discovered through `$DSH_HOME/state/governance-bridge.json`), and this plugin
is a same-origin mirror of it — with its per-run token, its refusals carried through unchanged, and
`available: false` with a reason whenever DS-Hns is not running.

## The surface

The browser half registers **one** official slot: `settings.section` — the Mega page (§4.4): plugin health,
dependencies, version, capabilities, retries, fallback, last error, pending human dependency, recovery actions,
compatibility and the update pin. Nothing in it duplicates a plugin's own settings; those live where they
already live.

**The ball is not here.** It used to be: the first version registered a floating orb into the official
`shell.overlay` slot, and the second added a system-level ball beside it. The review of that arrangement was
"现在有两个球，只要系统最外层那个", so the in-UI orb is gone and the survivor is
`app/extensions/mega/system-orb.cjs` — our own always-on-top window, visible without this window being in
front, which is the property an orb is for.

## Known state

The page has been through the manual UI review (its readability fix came out of it) and is covered by Node
tests. The ball moved to the system layer (`app/extensions/mega/system-orb.cjs`), and the old Mega dock no
longer starts on screen; deleting its code is §30's next step, done separately so the interface is never
swapped without a way back.

## Verify

```text
node --test tests/unit/mega-core-plugin.test.js
node --test tests/unit/mega-core-view.test.js
node --test tests/unit/mega-core-client.test.js
node --test tests/unit/governance-bridge.test.js
```
