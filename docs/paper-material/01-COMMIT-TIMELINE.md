# Commit timeline and logical lineage

## Method

History was inspected with `git log --all`, graph/merge-base queries, `git show`, branch ancestry, tags, and stable patch IDs. Merge commits preserve provenance but are not counted as separate contributions. The following patch-equivalent pairs are one logical change each:

| Original | Integrated copy | Stable patch-id |
|---|---|---|
| `22b3261` | `db5ebab` | `def35337e01da733c0cf71c27cfa7044e123902d` |
| `7969807` | `d44d835` | `159b5d64731e6283a7f134d5dc950dbaa4506c64` |
| `791773d` | `9417ca8` | `35c8c23d2948bc3fb0676a340d4839675337605a` |
| `96c571f` | `16d722c` | `0199c249a0c9575db6327b320f4a3e5923a49708` |
| `d76dc3d` | `1965f33` | `90187c443e10db04b03577f57917487d16b39ac2` |

## Timeline

| Date | Phase | Representative commits | Evidence-bearing change |
|---|---|---|---|
| 2026-09-07 | Alien rebuild | `4eeb491`, `026e613`, `2b26890` | Alien shell baseline, optional Mega layer, architecture contract. |
| 2026-09-08 | startup/runtime ownership | `2b4fc26`, `d657412`, `40c01e0` | authenticated handshake and owned-orphan recovery. |
| 2026-09-10–12 | supervised execution | `e783ba0`, `736762a`, `367baf3` | task lifecycle, optional worker, adaptive multi-process execution. |
| 2026-09-13–15 | pluginization and operator UI | `b1dee06`, `74c3961`, `400f3ed`, `e15385f` | plugin workbench, governed bridge, Mega host/client split, official-slot UI. |
| 2026-09-14 | official UI protection | `784db3f`, `8ad0dbb`, `66e371a` | official renderer becomes sole frontend; dock stays glass; wallpaper moves to click-through window. |
| 2026-09-14–16 | real community installation | `1b0a550`, `9bddc34`, `9035cf4`, `3490437` | registry/channel correction, real activation, profile materialization, installer choices. |
| 2026-09-16 | heterogeneous adapters | `db5ebab`, `d44d835`, `9417ca8`, `16d722c`, `1965f33` | format-neutral manager, controlled Cordis bridge, managed process, native HNS, one install pipeline. |
| 2026-09-17 | long-host governance | `572bf52`, `45a66d9`, `f009619`, `ec79430`, `432cf43` | health/restart authority split, fault isolation, continuity/admission, chaos and UI acceptance. |
| 2026-09-20 | runtime/UI separation | `532f805`, `d0b02e0`, `0d4ada9`, `5a34f30`, `923f529` | per-instance identity, desktop as Runtime Host client, single-host rule. |
| 2026-09-21–22 | Integration RC | `dba5f3d`, `137523b`, `974072e`, `2ae08a7` | selective integration, isolated launch repair, visual RC and C-drive fail-closed gate. |
| 2026-09-22 | Final Qualification | `277ef17` through `be743a7` | D-only roots, installer reconciliation, Phase C repair, P2 UI repairs, immutable evidence runner, clean-room fixture materialization. |

All dates are repository author dates. They describe engineering sequence, not independent experimental replications.
