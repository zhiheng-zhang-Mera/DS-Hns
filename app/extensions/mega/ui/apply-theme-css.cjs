'use strict'
/**
 * One-shot CSS bridge update for the dock stylesheet.
 *
 * Rewrites the dock's palette variables into the HNS Theme API variable names so
 * the unified theme system can drive every surface, then appends the Appearance
 * panel styles.
 *
 * Run from `app/`:
 *   node extensions/mega/ui/apply-theme-css.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, 'dock.css')

/** Old dock palette variable -> HNS Theme API token variable. */
const BRIDGE = {
  '--bg': '--hns-color-bg-base',
  '--surface': '--hns-color-bg-layer1',
  '--surface-soft': '--hns-color-bg-layer2',
  '--surface-hover': '--hns-color-bg-raised',
  '--border': '--hns-color-border-l1',
  '--border-strong': '--hns-color-border-l2',
  '--text': '--hns-color-label-primary',
  '--muted': '--hns-color-label-secondary',
  '--subtle': '--hns-color-label-tertiary',
  '--accent': '--hns-color-accent-primary',
  '--accent-soft': '--hns-color-bg-raised',
  '--peak': '--hns-state-failed',
  '--peak-bg': '--hns-color-bg-layer2',
  '--off': '--hns-state-completed',
  '--off-bg': '--hns-color-bg-layer2',
  '--shadow': '--hns-shadow-l1'
}

let css = fs.readFileSync(FILE, 'utf8')

// Only the `var(--x)` usages are rewritten; the :root declarations themselves are
// replaced wholesale below.
for (const [from, to] of Object.entries(BRIDGE)) {
  css = css.split(`var(${from})`).join(`var(${to})`)
}

const ROOT_BLOCK = `:root{
  /* ---- Dock palette, driven by the HNS Theme API (data/extensions/mega/theme) ----
     Every value is a var() reference to a theme token, so the dock follows the
     active theme. The literal fallbacks are the Dark system theme values: if the
     theme engine is unavailable the dock still renders correctly (spec §18). */
  font-family:var(--hns-font-family,Inter,"Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,sans-serif);
  color-scheme:dark;
  --hns-font-family:Inter,"Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
  --hns-font-family-mono:Consolas,"SF Mono",monospace;
  --hns-font-size-body:13px;
  --hns-font-size-caption:11px;
  --hns-font-size-title:16px;
  --hns-font-weight-body:400;
  --hns-font-weight-title:600;
  --hns-color-bg-base:#0f1115;
  --hns-color-bg-layer1:#151922;
  --hns-color-bg-layer2:#1b2130;
  --hns-color-bg-overlay:#0b0d12;
  --hns-color-bg-raised:#232c3d;
  --hns-color-label-primary:#e8ecf3;
  --hns-color-label-secondary:#a7b1c2;
  --hns-color-label-tertiary:#7b8698;
  --hns-color-label-inverse:#0d1016;
  --hns-color-border-l1:#252d3d;
  --hns-color-border-l2:#33405a;
  --hns-color-accent-primary:#4d93f8;
  --hns-color-accent-secondary:#7aa7ff;
  --hns-color-accent-contrast:#0d1016;
  --hns-state-idle:#8b93a1;
  --hns-state-running:#4d93f8;
  --hns-state-waiting:#c9a227;
  --hns-state-blocked:#b06bd6;
  --hns-state-warning:#f0a63a;
  --hns-state-failed:#ef5d5d;
  --hns-state-completed:#3fbf7f;
  --hns-state-resource-limit:#d9553f;
  --hns-state-primary-worker:#4ea8de;
  --hns-state-sub-worker:#6fa8a0;
  --hns-space-unit:4px;
  --hns-space-gap:8px;
  --hns-space-panel:12px;
  --hns-radius-sm:4px;
  --hns-radius-md:8px;
  --hns-radius-lg:14px;
  --hns-shadow-l1:0 1px 3px rgba(0,0,0,.42);
  --hns-shadow-l2:0 6px 18px rgba(0,0,0,.5);
  --hns-opacity-panel:.97;
  --hns-effect-blur:0px;
  --hns-effect-glow:0;

  /* Slot-bound bridges, written by the Appearance panel from the active theme. */
  --hns-slot-shell-bg:var(--hns-color-bg-layer1);
  --hns-slot-shell-border:1px solid var(--hns-color-border-l1);
  --hns-slot-shell-radius:var(--hns-radius-md);
  --hns-slot-panel-bg:var(--hns-color-bg-layer1);
  --hns-slot-panel-border:1px solid var(--hns-color-border-l1);
  --hns-slot-panel-radius:var(--hns-radius-md);
  --hns-slot-panel-shadow:var(--hns-shadow-l1);
  --hns-slot-card-bg:var(--hns-color-bg-layer1);
  --hns-slot-card-border:1px solid var(--hns-color-border-l1);
  --hns-slot-card-radius:var(--hns-radius-md);
  --hns-slot-queue-bg:var(--hns-color-bg-layer2);
  --hns-slot-queue-border:1px solid var(--hns-color-border-l1);
  --hns-slot-badge-bg:var(--hns-color-bg-layer2);
  --hns-slot-badge-border:1px solid var(--hns-color-border-l1);
  --hns-slot-badge-radius:var(--hns-radius-sm);
  --hns-slot-button-bg:var(--hns-color-accent-primary);
  --hns-slot-button-label:var(--hns-color-accent-contrast);
  --hns-slot-button-radius:var(--hns-radius-md);
  --hns-slot-input-bg:var(--hns-color-bg-layer2);
  --hns-slot-input-border:1px solid var(--hns-color-border-l1);
  --hns-slot-input-radius:var(--hns-radius-sm);
  --hns-slot-header-bg:var(--hns-color-bg-layer1);
  --hns-decoration-asset:none;
  --hns-persona-decoration-opacity:0;
  --hns-persona-banner-opacity:0;
  --hns-persona-avatar:none;
  --hns-persona-banner-asset:none;

  color:var(--hns-color-label-primary);
  background:var(--hns-color-bg-base);
}`

css = css.replace(/^:root\{[\s\S]*?\n\}/, ROOT_BLOCK)

const THEME_CSS = `
/* ==========================================================================
   Appearance panel — the only user-facing surface of the HNS theme system.
   Internal concepts (slots, tokens, manifests, capabilities) are never shown;
   the user sees a prompt box, a preview verdict and a theme list.
   ========================================================================== */
.appearance-panel{background:var(--hns-slot-panel-bg);border:var(--hns-slot-panel-border);border-radius:var(--hns-slot-panel-radius);box-shadow:var(--hns-slot-panel-shadow)}

.theme-current{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;margin-bottom:8px;border:1px solid var(--hns-color-border-l1);border-radius:9px;background:var(--hns-slot-queue-bg)}
.theme-current span{font-size:10px;color:var(--hns-color-label-secondary)}
.theme-current b{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.theme-capability{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:9px}
.theme-capability span{font-size:9px;padding:2px 7px;border-radius:999px;border:1px solid var(--hns-color-border-l1);background:var(--hns-color-bg-layer2);color:var(--hns-color-label-secondary)}

.theme-create{display:flex;flex-direction:column;gap:6px;padding:9px;border:1px solid var(--hns-color-border-l1);border-radius:10px;background:var(--hns-color-bg-layer2)}
.theme-create>label{font-size:10px;color:var(--hns-color-label-secondary);letter-spacing:.02em}
.theme-create textarea{width:100%;padding:8px;resize:vertical;background:var(--hns-slot-input-bg);border:var(--hns-slot-input-border);border-radius:var(--hns-slot-input-radius);color:var(--hns-color-label-primary)}
.theme-create-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.theme-create-actions button{padding:7px 14px;background:var(--hns-slot-button-bg);color:var(--hns-slot-button-label);border:0;border-radius:var(--hns-slot-button-radius)}
.theme-create-actions button:hover{filter:brightness(1.06)}
.theme-busy{font-size:10px;color:var(--hns-color-label-secondary)}
.theme-quick-row{display:flex;flex-wrap:wrap;gap:5px}
.theme-quick{font-size:9px;padding:3px 8px;border-radius:999px;background:var(--hns-color-bg-layer1);border:1px solid var(--hns-color-border-l1);color:var(--hns-color-label-secondary);cursor:pointer;text-align:left}
.theme-quick:hover{color:var(--hns-color-label-primary);border-color:var(--hns-color-border-l2)}

.theme-preview{margin-top:9px;padding:9px;border:1px solid var(--hns-color-accent-primary);border-radius:10px;background:var(--hns-color-bg-layer2)}
.preview-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px}
.preview-name{font-size:13px;font-weight:var(--hns-font-weight-title)}
.preview-intent{margin-top:2px;font-size:9px;color:var(--hns-color-label-secondary);word-break:break-word}
.preview-badge{font-size:9px;padding:2px 7px;border-radius:999px;border:1px solid var(--hns-color-border-l1);color:var(--hns-color-label-secondary)}
.preview-verdict{font-size:11px;font-weight:700;margin:4px 0}
.preview-verdict.ok{color:var(--hns-state-completed)}
.preview-verdict.fail{color:var(--hns-state-failed)}
.preview-warnings{font-size:9px;color:var(--hns-state-warning);margin-bottom:4px}
.preview-checks{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:3px}
.preview-checks li{display:grid;grid-template-columns:12px 1fr;gap:5px;font-size:9px;line-height:1.35;align-items:start}
.preview-checks li b{font-size:9px}
.preview-checks li em{grid-column:2;color:var(--hns-color-label-tertiary);font-style:normal}
.preview-checks li.ok b{color:var(--hns-state-completed)}
.preview-checks li.warn b{color:var(--hns-state-warning)}
.preview-checks li.fail b{color:var(--hns-state-failed)}
.preview-note{margin-top:6px;font-size:9px;color:var(--hns-color-label-secondary)}
.preview-history{margin-top:4px;font-size:9px;color:var(--hns-color-label-tertiary);word-break:break-word}
.theme-preview-actions{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}
.theme-preview-actions button{padding:7px 12px;background:var(--hns-slot-button-bg);color:var(--hns-slot-button-label);border:0;border-radius:var(--hns-slot-button-radius)}
.theme-preview-actions button.quiet{background:var(--hns-color-bg-layer1);color:var(--hns-color-label-primary);border:1px solid var(--hns-color-border-l1)}
.theme-preview-actions button:disabled{opacity:.5;cursor:not-allowed}
.theme-modify{margin-top:8px;display:flex;flex-direction:column;gap:5px}
.theme-modify label{font-size:10px;color:var(--hns-color-label-secondary)}
.theme-modify-row{display:flex;gap:6px}
.theme-modify-row input{flex:1;padding:7px;background:var(--hns-slot-input-bg);border:var(--hns-slot-input-border);border-radius:var(--hns-slot-input-radius);color:var(--hns-color-label-primary)}
.theme-modify-row button{padding:7px 12px;background:var(--hns-slot-button-bg);color:var(--hns-slot-button-label);border:0;border-radius:var(--hns-slot-button-radius)}

.theme-message{min-height:14px;margin:8px 0;font-size:10px;line-height:1.4;color:var(--hns-color-label-secondary);word-break:break-word}
.theme-message.ok{color:var(--hns-state-completed)}
.theme-message.warn{color:var(--hns-state-warning)}
.theme-message.error{color:var(--hns-state-failed)}

.theme-list-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:6px 0 5px}
.theme-list-head h3{margin:0;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--hns-color-label-tertiary)}
.theme-list-head span{font-size:9px;color:var(--hns-color-label-tertiary)}
.theme-list{display:flex;flex-direction:column;gap:5px}
.theme-item{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;padding:6px 8px;border:1px solid var(--hns-color-border-l1);border-radius:9px;background:var(--hns-slot-queue-bg)}
.theme-item.active{border-color:var(--hns-color-accent-primary);background:var(--hns-color-bg-raised)}
.theme-item.broken{border-color:var(--hns-state-failed)}
.theme-apply{display:flex;flex-direction:column;gap:1px;align-items:flex-start;background:transparent;border:0;padding:0;cursor:pointer;text-align:left;min-width:0}
.theme-name{font-size:11px;color:var(--hns-color-label-primary);display:flex;align-items:center;gap:4px}
.theme-lock{font-size:9px;opacity:.75}
.theme-meta{font-size:9px;color:var(--hns-color-label-tertiary)}
.theme-actions{display:flex;gap:3px}
.theme-icon{width:22px;height:22px;padding:0;font-size:10px;line-height:1;background:var(--hns-color-bg-layer1);border:1px solid var(--hns-color-border-l1);border-radius:6px;color:var(--hns-color-label-secondary);cursor:pointer}
.theme-icon:hover:not(:disabled){color:var(--hns-color-label-primary);border-color:var(--hns-color-border-l2)}
.theme-icon:disabled{opacity:.35;cursor:not-allowed}
.theme-icon.danger:hover:not(:disabled){color:var(--hns-state-failed);border-color:var(--hns-state-failed)}

.theme-detail{margin-top:9px;padding:9px;border:1px solid var(--hns-color-border-l1);border-radius:10px;background:var(--hns-color-bg-layer2)}
.theme-detail-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.theme-detail-head h3{margin:0;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--hns-color-label-tertiary)}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.detail-grid>div{min-width:0}
.detail-grid span{display:block;font-size:9px;color:var(--hns-color-label-tertiary)}
.detail-grid b{display:block;font-size:10px;color:var(--hns-color-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.detail-prompt,.detail-history{margin-top:6px;font-size:9px;color:var(--hns-color-label-secondary);word-break:break-word}

/* ---- Theme-decorated dock surfaces -------------------------------------------------
   These rules are the *only* place the dock reads slot values. Every one of them
   resolves to a theme token, so a theme restyles the dock without touching markup. */
body{background:var(--hns-color-bg-base);border-left:var(--hns-slot-shell-border,1px solid var(--hns-color-border-l1))}
#rail{background:var(--hns-color-bg-layer2);border-right:1px solid var(--hns-color-border-l1)}
#detail{background:var(--hns-color-bg-base);position:relative}
.dock-header{background:color-mix(in srgb,var(--hns-slot-header-bg) 94%,transparent);border-bottom:1px solid var(--hns-color-border-l1)}
.panel{background:var(--hns-slot-panel-bg);border:var(--hns-slot-panel-border);border-radius:var(--hns-slot-panel-radius);box-shadow:var(--hns-slot-panel-shadow)}
.summary-card{background:var(--hns-slot-card-bg);border:var(--hns-slot-card-border);border-radius:var(--hns-slot-card-radius)}
.queue-item,.queue-list{background:var(--hns-slot-queue-bg)}
.queue-item{border:1px solid var(--hns-color-border-l1)}
.hardware-item{background:var(--hns-color-bg-layer2);border:1px solid var(--hns-color-border-l1)}
.status-chip{background:var(--hns-slot-badge-bg);border:var(--hns-slot-badge-border);border-radius:var(--hns-slot-badge-radius);color:var(--hns-color-label-secondary)}
.status-chip.ok{background:var(--hns-color-bg-layer2);color:var(--hns-state-completed);border-color:color-mix(in srgb,var(--hns-state-completed) 30%,var(--hns-color-border-l1))}
.status-chip.warn{background:var(--hns-color-bg-layer2);color:var(--hns-state-warning);border-color:color-mix(in srgb,var(--hns-state-warning) 30%,var(--hns-color-border-l1))}
.status-chip.busy{background:var(--hns-color-bg-layer2);color:var(--hns-color-accent-primary);border-color:color-mix(in srgb,var(--hns-color-accent-primary) 30%,var(--hns-color-border-l1))}
.rail-stat{background:var(--hns-color-bg-layer1);border:1px solid var(--hns-color-border-l1)}
.rail-mode.peak{background:var(--hns-color-bg-layer1);color:var(--hns-state-failed);border-color:color-mix(in srgb,var(--hns-state-failed) 30%,transparent)}
.rail-mode.offpeak{background:var(--hns-color-bg-layer1);color:var(--hns-state-completed);border-color:color-mix(in srgb,var(--hns-state-completed) 28%,transparent)}
.summary-card.period-card.peak{background:var(--hns-color-bg-layer2);border-color:color-mix(in srgb,var(--hns-state-failed) 26%,var(--hns-color-border-l1))}
.summary-card.period-card.peak b{color:var(--hns-state-failed)}
.summary-card.period-card.offpeak{background:var(--hns-color-bg-layer2);border-color:color-mix(in srgb,var(--hns-state-completed) 24%,var(--hns-color-border-l1))}
.summary-card.period-card.offpeak b{color:var(--hns-state-completed)}
.task-form textarea,.settings-form input,.settings-form select{background:var(--hns-slot-input-bg);border:var(--hns-slot-input-border);border-radius:var(--hns-slot-input-radius)}
button{background:var(--hns-color-bg-layer1);border-color:var(--hns-color-border-l1);border-radius:var(--hns-slot-button-radius)}
button:hover{background:var(--hns-color-bg-layer2)}
.form-row button[type="submit"]{background:var(--hns-slot-button-bg);color:var(--hns-slot-button-label);border:0}
.settings-sheet{background:var(--hns-slot-panel-bg);border:1px solid var(--hns-color-border-l2);box-shadow:var(--hns-slot-panel-shadow)}
.settings-head{background:var(--hns-color-bg-layer2);border-bottom:1px solid var(--hns-color-border-l1)}
.settings-overlay{background:color-mix(in srgb,var(--hns-color-bg-overlay) 62%,transparent)}

/* ---- Persona / decoration layer (HNS: lightweight only) ----------------------------
   Rendered into a single non-interactive overlay that is always behind the content
   and never covers the queue, hardware grid or status strip (HNS specialization §4). */
#hnsDecoration{position:absolute;inset:0;pointer-events:none;z-index:0;background-image:var(--hns-decoration-asset);background-repeat:no-repeat;background-position:top right,bottom left;background-size:38% auto;opacity:var(--hns-persona-decoration-opacity)}
#hnsPersona{position:absolute;right:10px;bottom:10px;width:56px;height:56px;pointer-events:none;z-index:0;border-radius:50%;background-image:var(--hns-persona-avatar);background-size:contain;background-repeat:no-repeat;background-position:center;opacity:calc(var(--hns-persona-decoration-opacity) * 5)}
#detail>.dock-header,#detail>section,#detail>p,#detail>div{position:relative;z-index:1}
body[data-effect-level="2"] #hnsDecoration,body[data-effect-level="2"] #hnsPersona{display:none}
body[data-effect-level="1"] #hnsDecoration{opacity:0}
`

if (!css.includes('#hnsDecoration')) css = `${css}\n${THEME_CSS}`
fs.writeFileSync(FILE, css, 'utf8')
console.log(`dock.css bridged to the HNS Theme API (${css.length} bytes)`)
