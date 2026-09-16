# The Cordis / DSH community adapter

Phase 1 built the adapter framework: a place where an external plugin format can be turned into
DS-Hns's own plugin model without the manager learning about formats. This is the adapter that uses
it for the largest real ecosystem there is — community plugins written for DeepSeek Harness and
Cordis.

The claim it exists to make true is narrow and checkable:

> A community DSH plugin can be installed, enabled, disabled, reloaded, health-checked and
> uninstalled through the platform's ordinary plugin flow, **with no code written for that
> plugin** — and without the plugin's own source being touched.

## 1. What it reads

A community bundle declares itself in four places. None of them requires running the plugin, so
`cordis-structure.cjs` reads them all from disk:

| Declaration | What it means | What the adapter does |
| --- | --- | --- |
| `package.json` → `dsh.bundle.patch` | the profile patch layer this bundle contributes | records it, and marks the package a bundle |
| `package.json` → `dsh.client.inject` | the browser half's client modules and platform | records them, and reports honestly that this host cannot serve them |
| `cordis.patch.yml` | the rows the patch inserts | extracts each row's `id` and `name` |
| `peerDependencies` (+ `peerDependenciesMeta`) | services the **host** is expected to provide | splits required from optional, audits each against the host's roots |
| `export const inject` in the entry | the host services the host half needs | decides which capabilities the bridge must mediate |

Two of those need care, and both were found by pointing the reader at real plugins rather than at
fixtures:

* **A patch file is not general YAML.** The repository's own `parseYaml` is a resource-config
  reader and rejects the nested `- insert:` / `- id:` sequence a bundle patch is made of. Pulling
  in a YAML engine to read two fields would be a large dependency for a small question, so
  `patchRowsFor` handles the fixed shape it is and reports what it could not read.
* **A built plugin re-exports its `inject`.** Bundlers emit `const inject = [...]` near the bottom
  and then `export { apply, inject, ... }`, so reading only `export const inject = [...]` finds
  nothing on exactly the plugins that matter. Both spellings are read; the bare binding only counts
  when the name is actually exported, because a local variable called `inject` is not a declaration
  of anything.

## 2. The controlled bridge

The requirement is that a Cordis plugin never receives an HNS Core object and that every
interaction goes through a controlled bridge. `bridge/contract.cjs` is that rule written down, and
the four things that make it hold are structural rather than conventional:

1. **The capability vocabulary is closed.** `webServer` and `settings`. A plugin asking for anything
   else is refused **by name** at activation — not handed a proxy that fails later.
2. **The method vocabulary is closed per capability.** `webServer` has exactly `register` and
   `unregister`. `registerFallback`, `registerUpgrade`, the raw `server` field and `listen` are real
   members of the real service and are not reachable through the bridge at all. The contract names
   them in a `withholds` list, so "we did not hand over the server" is a statement a reader can
   check rather than an omission.
3. **Arguments are data.** Every call crosses as JSON. There is no handle, no reference and no
   prototype chain in either direction, so there is nothing to walk back to a host object.
4. **The host validates before it applies.** A route path is normalised and checked for ancestry
   against the host's own prefixes; a settings namespace is checked against the identifier pattern.
   The plugin's intention is data; the host's action is the host's.

What the plugin actually receives as `ctx` is a fixed set of local values and two proxies. The
bridge suite asserts that set exactly, and asserts the proxy member lists exactly — a new key there
is a new thing a community plugin can reach, which is a decision somebody should have to make on
purpose.

### The host half really runs

`ctx.webServer.register({ kind, path, handler })` keeps the **handler in the child** and mounts a
forwarding route on the host's own web server. A request arriving at the host is serialised to the
child, the plugin's handler runs there, and the response streams back in chunks and out through the
host's socket. That is why `res.write()` in a plugin produces a real streamed response rather than
a buffered one — the wallpaper plugin serves video this way, and buffering it would have broken the
plugin's actual purpose.

Route registration is asynchronous over the channel but the proxy returns a **synchronous** disposer,
because the real API does and community plugins depend on that shape (`disposers.push(webServer.
register({...}))`). Activation does not report ready until every call the plugin issued has been
answered, so a route is never registered after the host has been told the plugin is up.

## 3. The unified flow

An adapted community plugin is an ordinary plugin to everything above the adapter:

```
framework.adapt({ dir })  ->  manager.install  ->  manager.enable + load  ->  manager.checkHealth
                          ->  manager.disable   ->  manager.reload        ->  manager.remove
```

* It carries the same standard sections every plugin has: `adapter`, `adaptation`, `permissions`,
  `runtime`, `lifecycle`, `errorCount`.
* It **never auto-enables**. Enabling is always an explicit act.
* It **provides no capabilities**: the bridge does not forward `provide`, so a bridged plugin cannot
  satisfy another plugin's requirement, and its manifest says `provides: []`.
* `manager.remove` was added in this phase: unloading and uninstalling are different requests, and
  only the first existed. A removed plugin leaves the list, and its routes and process are gone.

## 4. Permissions and health

Permissions are derived from what the plugin declared, not granted wholesale:

| Evidence | Permission |
| --- | --- |
| always | `fs.read` (it reads its own package) |
| `dsh.bundle.patch` | `config.read` |
| `dsh.client` | `ui.render` |
| `inject` includes `webServer` | `network` |
| `inject` includes `settings` | `settings.write` |

Health is the bridge's, plus one honest adjustment: **a bundle with a browser half is `degraded`,
not `healthy`**, and the reason names the half that is not rendering. A plugin whose visible half
does nothing is not a plugin that works, and calling it healthy would hide exactly the part a user
would notice.

## 5. What it does not do

* **The browser half is detected, not served.** These bundles ship a client half for the web UI.
  Serving it needs the harness's client-module host, not a host-process bridge. The adapter reports
  the client half's inject list and platform, marks the plugin degraded, and prints the limitation
  in the acceptance report rather than quietly counting it as working.
* **`settings` is recorded, not editable.** With no real settings service behind it the host records
  the namespace and says `applied: false`; the capability report distinguishes "known" from
  "editable".
* **The shell has no `webServer`.** `plugin-host` registers the adapter with whatever
  `options.hostServices` it is given, and by default that is nothing, because the shell is a
  different process from the harness. The bridge then refuses route registration with
  `BRIDGE_SERVICE_UNAVAILABLE` and the plugin is degraded with that reason — which is the truth of
  that deployment, not a fake route. A deployment that wants community plugins to serve traffic
  passes the service in.
* **Peer resolution depends on the host's roots.** A peer dependency resolves out of the plugin's
  own `node_modules` first, then the roots the adapter was given. A plugin whose required peer is in
  neither fails to import, and the report names the package.

## 6. Acceptance

```
node scripts/cordis-adapter-acceptance.cjs [--samples <dir>] [--roots <dir,dir>] [--json]
```

Against the two real community plugins (`zhu1090093659/dsh-web#packages/dsh-market` and
`Weilv-D/wallpaper-engine-dsh`, read-only clones), plus a third plugin **written by the acceptance
script itself** in the same public convention — a different package name, a different service
combination (`webServer` and `settings`), a different route prefix, and no adapter change of any
kind. That third part is the actual acceptance criterion: the first two prove the adapter works,
the third proves it generalises.

Each plugin runs the whole flow, and the report is checked rather than asserted-by-eye: a bridged
route is exercised with a **real HTTP request** to the host's own server, disabling is checked by
confirming the route is unmounted *and* the plugin process is gone, and uninstalling is checked the
same way.

| Test file | What it pins |
| --- | --- |
| `plugin-cordis-structure.test.js` | the convention, its edges, and the two real plugins when they are on disk |
| `plugin-cordis-bridge.test.js` | the context and proxy allow-lists, host-side validation, reserved paths, streaming, teardown, failure isolation |
| `plugin-cordis-dsh.test.js` | the adapter through the manager: the whole unified flow, and a plugin it has never seen |

## 7. Bugs this phase found in itself

Recorded because each was a real defect the tests caught, and each is the kind that ships silently:

* **A blanket `/api/` reservation refused the market plugin's entire purpose.** It serves
  `/api/market/*`. The rule is about ancestry — a plugin may live under a host prefix, it may not
  sit in front of one — and the earlier rule conflated the two.
* **`res.statusCode = 500` was ignored.** It was a plain property while `writeHead` built the head
  from a different variable, so a handler that threw still answered 200. Setting the status
  directly is the ordinary Node idiom.
* **A failed activation reported itself as "stopped".** The cleanup path set the state after the
  failure was recorded and erased it, so a plugin that could not start said `unknown` instead of
  why.
* **A handler failure never reached the host.** It was recorded in the child after activation, and
  the child only reported faults at ready time, so a plugin failing on every request looked fine.
* **Refusals were counted twice.** The host recorded a refusal and the child echoed it back.
* **A YAML parser and a bundler re-export both defeated the first reader** (see section 1).
