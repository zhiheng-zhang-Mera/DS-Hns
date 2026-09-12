# HNS Native Frontend — theme surface

Daily Mode is a fully themable surface (Update-Plan/Dual-UI.md 任务 14 / 任务 15).
It consumes the *same* Theme API as the Mega dock, so one theme package styles all
HNS surfaces without a second vocabulary:

| file | role |
| --- | --- |
| `base.css` | the default token set. Every value is a CSS custom property. |
| `../app.css` | layout and component rules, written only against those properties. |

## What a theme may write

* **tokens** — the engine installs the active theme's token block on `:root` at
  runtime (`--hns-color-*`, `--hns-font-*`, `--hns-space-*`, `--hns-radius-*`,
  `--hns-shadow-*`, `--hns-opacity-*`, `--hns-effect-*`). Anything it does not
  declare keeps the `base.css` default.
* **slots** — each slot lands as `--hns-slot-<slot-id with dots as dashes>-<property>`.
  The layout consumes, among others:

  ```
  --hns-slot-hns-window-shell-background
  --hns-slot-hns-process-panel-background / -border / -radius / -shadow
  --hns-slot-hns-process-queue-background / -border
  --hns-slot-common-navigation-sidebar-background / -border / -radius
  --hns-slot-common-input-default-background / -border / -radius / -label / -placeholder
  --hns-slot-common-button-primary-background / -label / -radius
  --hns-slot-hns-status-badge-background / -border / -radius
  ```

* **assets** — the theme layers are filled from the slot's `asset`:

  | layer | element | slot |
  | --- | --- | --- |
  | wallpaper | `#backgroundLayer` | `hns.window.background` |
  | character | `#characterLayer` | `hns.character.primary` |
  | decoration | `#decorationLayer` | `hns.persona.decoration` |

  They arrive as `--hns-native-background`, `--hns-native-character` and
  `--hns-native-decoration` (a `url("data:…")`, or `none`), with the matching
  `--hns-native-*-opacity`. The character and decoration layers are
  `pointer-events: none`, so a theme can never take a click away from the UI.

## What a theme may not write

The official renderer is a different surface with a PROTECTED permission
(`app/extensions/mega/theme/surface.js`). Nothing in this directory can reach it,
and Daily Mode never renders above the official UI: the two frontends are separate
`WebContentsView`s and only one is visible at a time.
