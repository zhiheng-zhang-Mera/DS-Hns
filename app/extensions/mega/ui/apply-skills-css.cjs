'use strict'
/**
 * Append the Skills panel stylesheet to dock.css.
 *
 * Every colour is read from a theme token or from the slot bridge variables the
 * theme-bridge writes, so the Skills panel is themed by whichever theme is active —
 * including themes created before this panel existed. Nothing here hard-codes a
 * palette except the slot fallbacks, which are the Dark system values.
 *
 * Run from `app/`:
 *   node extensions/mega/ui/apply-skills-css.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, 'dock.css')
let css = fs.readFileSync(FILE, 'utf8')

const SKILLS_CSS = `
/* ==========================================================================
   Skills panel — search, install, and remove agent skills.

   Colours come from two places only:
     --hns-slot-hns-skill-*     slot styles written by the theme bridge
     --hns-color-*/--hns-state-* theme tokens
   so any theme, including one authored before this panel existed, restyles it.
   ========================================================================== */
.skills-panel{background:var(--hns-slot-panel-bg);border:var(--hns-slot-panel-border);border-radius:var(--hns-slot-panel-radius);box-shadow:var(--hns-slot-panel-shadow)}

.skills-installbar{display:grid;grid-template-columns:1fr auto;gap:7px;margin-bottom:8px}
.skills-installbar input{padding:8px;background:var(--hns-slot-hns-skill-search-background,var(--hns-slot-input-bg));border:var(--hns-slot-hns-skill-search-border,var(--hns-slot-input-border));border-radius:var(--hns-slot-hns-skill-search-radius,var(--hns-slot-input-radius));color:var(--hns-color-label-primary)}
.skills-installbar input::placeholder{color:var(--hns-slot-hns-skill-search-placeholder,var(--hns-color-label-tertiary))}
.skills-installbar button{padding:8px 14px;background:var(--hns-slot-button-bg);color:var(--hns-slot-button-label);border:0;border-radius:var(--hns-slot-button-radius)}

.skills-searchbar{display:grid;grid-template-columns:1fr auto;gap:7px;align-items:center;margin-bottom:7px}
.skills-searchbar input{padding:8px;background:var(--hns-slot-hns-skill-search-background,var(--hns-slot-input-bg));border:var(--hns-slot-hns-skill-search-border,var(--hns-slot-input-border));border-radius:var(--hns-slot-hns-skill-search-radius,var(--hns-slot-input-radius));color:var(--hns-color-label-primary)}
.skills-searchbar input::placeholder{color:var(--hns-slot-hns-skill-search-placeholder,var(--hns-color-label-tertiary))}
.skills-searchbar .check{white-space:nowrap}

.skills-tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.skill-tag{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;font-size:9px;cursor:pointer;
  background:var(--hns-slot-hns-skill-tag-background,var(--hns-color-bg-layer2));
  color:var(--hns-slot-hns-skill-tag-label,var(--hns-color-label-secondary));
  border:var(--hns-slot-hns-skill-tag-border,1px solid var(--hns-color-border-l1));
  border-radius:var(--hns-slot-hns-skill-tag-radius,999px)}
.skill-tag i{font-style:normal;opacity:.65}
.skill-tag.active{background:var(--hns-color-accent-subtle);color:var(--hns-color-label-primary);border-color:var(--hns-color-accent-primary)}
.skill-tag-static{padding:2px 7px;font-size:9px;border-radius:999px;
  background:var(--hns-slot-hns-skill-tag-background,var(--hns-color-bg-layer2));
  color:var(--hns-slot-hns-skill-tag-label,var(--hns-color-label-tertiary));
  border:1px solid var(--hns-color-border-l1)}

.skills-tabs{display:flex;align-items:center;gap:6px;margin-bottom:7px}
.skills-tab{padding:6px 12px;font-size:11px;background:var(--hns-color-bg-layer1);border:1px solid var(--hns-color-border-l1);border-radius:999px;color:var(--hns-color-label-secondary)}
.skills-tab.active{background:var(--hns-color-accent-subtle);color:var(--hns-color-label-primary);border-color:var(--hns-color-accent-primary)}
.skills-count{margin-left:auto;font-size:9px;color:var(--hns-color-label-tertiary)}

.skills-toolbar{display:flex;align-items:center;gap:10px;padding:6px 8px;margin-bottom:7px;border-radius:8px;
  background:var(--hns-color-bg-layer2);border:1px solid var(--hns-color-border-l1)}
.skills-toolbar-actions{margin-left:auto;display:flex;gap:6px}
.skills-toolbar .quiet{padding:5px 10px;font-size:10px}
.skills-toolbar .danger:not(:disabled){color:var(--hns-slot-hns-skill-danger-color,var(--hns-state-failed));border-color:color-mix(in srgb,var(--hns-state-failed) 34%,var(--hns-color-border-l1))}
.skills-toolbar .danger:disabled{opacity:.45;cursor:not-allowed}

.skills-list{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto}
.skills-section-title{display:flex;align-items:center;gap:6px;margin:4px 0 2px;font-size:9px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--hns-color-label-tertiary)}
.skills-section-title i{font-style:normal;opacity:.7}

.skill-card{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:start;padding:9px;
  background:var(--hns-slot-hns-skill-card-background,var(--hns-color-bg-layer1));
  border:var(--hns-slot-hns-skill-card-border,1px solid var(--hns-color-border-l1));
  border-radius:var(--hns-slot-hns-skill-card-radius,var(--hns-radius-md));
  box-shadow:var(--hns-slot-hns-skill-card-shadow,none)}
.skill-card.available{grid-template-columns:1fr auto}
.skill-card.selected{border-color:var(--hns-color-accent-primary);background:var(--hns-color-accent-subtle)}
.skill-card.invalid{border-color:var(--hns-state-failed)}
.skill-pick{display:flex;align-items:flex-start;padding-top:2px}
.skill-main{min-width:0}
.skill-title-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.skill-name{font-size:12px;color:var(--hns-slot-hns-skill-card-label,var(--hns-color-label-primary));word-break:break-all}
.skill-origin{font-size:9px;padding:1px 6px;border-radius:999px;background:var(--hns-color-bg-layer2);color:var(--hns-color-label-tertiary);border:1px solid var(--hns-color-border-l1)}
.skill-collection{font-size:9px;padding:1px 6px;border-radius:999px;background:var(--hns-color-accent-subtle);color:var(--hns-color-label-secondary)}
.skill-stars{font-size:9px;color:var(--hns-state-warning)}
.skill-desc{margin:4px 0 0;font-size:10px;line-height:1.45;color:var(--hns-color-label-secondary);word-break:break-word}
.skill-badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.skill-surface{font-size:9px;padding:1px 6px;border-radius:999px;color:var(--hns-state-completed);border:1px solid color-mix(in srgb,var(--hns-state-completed) 30%,transparent)}
.skill-surface.off{color:var(--hns-state-warning);border-color:color-mix(in srgb,var(--hns-state-warning) 30%,transparent)}
.skill-source-line{margin-top:5px;font-size:9px;color:var(--hns-color-label-tertiary);word-break:break-all}
.skill-actions{display:flex;gap:4px;align-items:center}
.skill-install{padding:6px 11px;font-size:10px;background:var(--hns-slot-button-bg);color:var(--hns-slot-button-label);border:0;border-radius:var(--hns-slot-button-radius)}
.skill-install:disabled{opacity:.55;cursor:progress}
.skill-icon{width:24px;height:24px;padding:0;font-size:10px;line-height:1;background:var(--hns-color-bg-layer1);
  border:1px solid var(--hns-color-border-l1);border-radius:6px;color:var(--hns-color-label-secondary);cursor:pointer}
.skill-icon:hover{color:var(--hns-color-label-primary);border-color:var(--hns-color-border-l2)}
.skill-icon.danger:hover{color:var(--hns-slot-hns-skill-danger-color,var(--hns-state-failed));border-color:var(--hns-state-failed)}

.skill-detail{margin-top:9px;padding:9px;border-radius:10px;background:var(--hns-color-bg-layer2);border:1px solid var(--hns-color-border-l1)}
.skill-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px}
.skill-detail-head b{font-size:12px;color:var(--hns-color-label-primary)}
.skill-detail-head .skills-count{margin-left:6px}
.skill-detail-body{margin:0;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;
  font-family:var(--hns-font-family-mono);font-size:10px;line-height:1.5;color:var(--hns-color-label-secondary)}

@media(max-width:620px){.skills-installbar{grid-template-columns:1fr}.skills-searchbar{grid-template-columns:1fr}}
`

if (!css.includes('.skills-panel')) css = `${css}\n${SKILLS_CSS}`
fs.writeFileSync(FILE, css, 'utf8')
console.log(`dock.css skills styles applied (${css.length} bytes)`)
