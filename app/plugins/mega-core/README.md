# dsh-plugin-mega-core

The DS-Hns **Mega Core** plugin for the official DeepSeek Harness UI (`updateplan/pluginize.md` Phase 1).

It is the plugin half of the plan's architecture change: Mega stops being a window beside the official UI and
becomes a plugin **inside** it — a floating orb, a mini panel on hover, and a full page for governance.

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
| `GET /mega-core/view` | the same snapshot composed into what the orb and the page draw (§4.2-§4.4) |
| `POST /mega-core/action` | one of the named actions: `check`, `retry`, `reset-fallback`, `repair`, `disable`, `enable` |
| `GET`/`POST /mega-core/orb` | where the orb was left, and where a drag ended |

The host half holds no state. DS-Hns owns governance behind its loopback bridge
(`app/core/governance-bridge.cjs`, discovered through `$DSH_HOME/state/governance-bridge.json`), and this plugin
is a same-origin mirror of it — with its per-run token, its refusals carried through unchanged, and
`available: false` with a reason whenever DS-Hns is not running.

## The two surfaces

The browser half registers into two **official** slots, because the official UI is where a floating surface is
supposed to be declared:

* `shell.overlay` — the orb (§4.2-§4.3). A list slot: the occupant is added beside the shipped entries, never
  over them, and the layer is click-through until an occupant opts into pointer events, which the orb does
  only for its own 40 px box. Draggable, edge-snapping, keyboard-nudgeable, and its position is stored by the
  *host* (a file under `$DSH_HOME/state`) rather than in `localStorage` — the official UI is served from a
  `--port 0` loopback origin that changes on every restart.
* `settings.section` — the Mega page (§4.4): plugin health, dependencies, version, capabilities, retries,
  fallback, last error, pending human dependency, recovery actions, compatibility and the update pin. Nothing
  in it duplicates a plugin's own settings; those live where they already live.

The settings modal's open state is component-local in the official UI (there is no public "open settings at
section X"), so the orb's panel says where the page lives instead of offering a button that could not work.

## Known state

The orb and the page are written and covered by Node tests, and neither has been through a **manual UI
review** yet: that is what the checkpoint in `docs/pluginize.md` is for, and the old Mega dock stays until it
passes (§30: acceptance first, removal second).

## Verify

```text
node --test tests/unit/mega-core-plugin.test.js
node --test tests/unit/mega-core-view.test.js
node --test tests/unit/mega-core-client.test.js
node --test tests/unit/governance-bridge.test.js
```
