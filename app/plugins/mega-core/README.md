# dsh-plugin-mega-core

The DS-Hns **Mega Core** plugin for the official DeepSeek Harness UI (`updateplan/pluginize.md` Phase 1).

It is the plugin half of the plan's architecture change: Mega stops being a window beside the official UI and
becomes a plugin **inside** it — a floating orb, a mini panel on hover, and a full page for governance.

## What is here now

The **host half** (`lib/index.js`) and the packaging that makes it a Harness plugin:

* `dsh.bundle.patch` → `cordis.patch.yml`, which inserts one host row (`mega-core`);
* `dsh.client` → the browser half is declared (`platform: web`, `immediately: true`, injected with
  `@deepseek-ai/dsh-client-runtime`);
* three same-origin routes for the browser half to fetch:

| route | what it answers |
| --- | --- |
| `GET /mega-core/health` | whether the plugin is up, and whether DS-Hns' governance bridge is reachable |
| `GET /mega-core/governance` | the snapshot the Control Center shows (plugins, protection, boot, pending work) |
| `POST /mega-core/action` | one of the named actions: `check`, `retry`, `reset-fallback`, `repair`, `disable`, `enable` |

The host half holds no state. DS-Hns owns governance behind its loopback bridge
(`app/core/governance-bridge.cjs`, discovered through `$DSH_HOME/state/governance-bridge.json`), and this plugin
is a same-origin mirror of it — with its per-run token, its refusals carried through unchanged, and
`available: false` with a reason whenever DS-Hns is not running.

## Known state

The **client half** (`lib/client.js`) is not written yet: `window.__ModuleLoader__.load({ id, factory })` with
`apply`/`inject`, drawing the orb, the mini panel and the full page. Until it exists this plugin's only surface
is its routes, and the old Mega dock is still the interface — `updateplan/pluginize.md` §30 requires the orb to
be accepted before the old shell is removed.

## Verify

```text
node --test tests/unit/mega-core-plugin.test.js
node --test tests/unit/governance-bridge.test.js
```
