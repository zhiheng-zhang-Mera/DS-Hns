/**
 * dsh-plugin-mega-core — browser half (`updateplan/pluginize.md` §4).
 *
 * The bundle shape is not invented here: it is the one the *installed* `dsh-plugin-wallpaper-engine` ships,
 * which is the authoritative example of how a browser half arrives (its `package.json` declares
 * `dsh.client.platform: web`, the host turns that declaration into this file being served, and the shell's
 * module loader materialises the factory below). So: a `window.__ModuleLoader__.load({ id, factory })`
 * wrapper, a CommonJS factory that returns the Cordis plugin, and `exports.apply` / `exports.inject` — the
 * same two names every browser plugin exports.
 *
 * What it draws, and where:
 *
 *   * **the orb** into the official `shell.overlay` slot (§4.1-§4.3). That slot is *the* seat for a
 *     frame-wide floating surface: it is a list (an occupant is added beside the shipped entries, never over
 *     them), and the layer itself is click-through, so an occupant that keeps its own box small cannot block
 *     the app underneath. This is the whole reason the orb is not a `<body>` child: the official UI says
 *     where a floating thing goes, and the answer is a slot.
 *   * **the Mega page** into the official `settings.section` slot (§4.4) — a first-level settings page, which
 *     is what §28 means by "every other entry goes through the official Settings system".
 *
 * Each surface draws the half of the view model it is for, and they come from **one** composed object
 * (`lib/view.js`): the orb opens on the **dashboard** — the price window and its countdown, the account
 * balance, the queue and the parallelism, which is what the old expanded dock showed — and the page renders
 * the **governance** half: §4.4's eleven fields, the module roster, the plugin roster and their actions. A
 * ball that drew the rosters would be a settings page behind a 40 px dot; a settings page that drew the
 * countdown would be a dashboard nobody can find.
 *
 * Three rules from §4.3 are properties of this file rather than of a config:
 *
 *   1. **It never takes focus on its own.** Nothing autofocuses, and `pointerdown` calls `preventDefault()`
 *      so a *click* on the orb cannot pull focus out of the composer mid-sentence. It stays in the tab order
 *      (it is a real `button`), so keyboard users still reach it — the difference between "reachable" and
 *      "grabbed" is exactly this line.
 *   2. **It does not run for nothing.** One poller serves both surfaces, it is 15 s, it stops while the
 *      document is hidden and refreshes the moment it is shown again. A background tab that keeps asking
 *      DS-Hns for a snapshot is a background tab that costs the machine something for a picture nobody sees.
 *   3. **It forgets nothing the user told it.** The orb's position is read from, and written to, the host
 *      half (`/mega-core/orb`) — a file, not `localStorage`, because the official UI is served from a
 *      `--port 0` loopback origin that changes on every restart.
 *
 * Everything is drawn with inline styles and `all: initial` on each root. There is no stylesheet to inject
 * and no selector that could reach an official element: the plugin owns two elements' worth of rules and
 * nothing else in that document.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-mega-core',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// The loader seeds a frozen platform table (React among it). If a host ever lacks it, the plugin
		// draws nothing instead of breaking the page it was invited into — §29's failure-isolation rule,
		// applied to the one dependency this half cannot work without.
		let React = null;
		try {
			React = require('react');
		} catch {
			React = null;
		}

		/**
		 * The official component primitives, if this host has them.
		 *
		 * This is where they belong rather than beside the dialog that uses them: the orb's panel renders on the
		 * plugin's first frame, so a `let` further down the file would be in its temporal dead zone when the panel
		 * asks for it — a crash at boot rather than a missing button.
		 *
		 * The centred sub-page is the official `Modal` rather than a card of ours: it already brings the portal to
		 * `document.body`, the mask, `role="dialog"` with `aria-modal`, the Escape key and the centring — the
		 * things a hand-rolled overlay gets subtly wrong. When the platform table has no primitives (a host we were
		 * not written for), the entry point simply does not appear: a "新建任务" button that opened a broken box
		 * would be worse than no button.
		 */
		let primitives = null;
		let primitivesError = null;
		try {
			primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		} catch (error) {
			primitives = null;
			primitivesError = String(error?.message || error);
		}

		/** The width of a form row's label column — the thing the presets under the time field align to. */
		const LABEL_COLUMN = 96;

		/**
		 * The dialog's width, which the official `Modal` does not get to decide.
		 *
		 * `Modal`'s own box is a **form dialog**: `width: min(380px, 100%)`, sized for one field and two buttons.
		 * This one is a composer with a schedule under it, and 380px crushed it — the time field and the peak switch
		 * ended up in a column two thirds of the width the labels needed, which is what "the dialog is too narrow"
		 * was. A class of our own on the dialog (passed through `Modal`'s `className`, and specific enough with two
		 * classes to win over the component's own single-class rule) is how a *surface* overrides a *component*.
		 *
		 * The numbers: 720px for a comfortable line of a prompt and a schedule in one row, opened up to 92 vw on a
		 * narrow layer, and never below 320px so the modal stays a dialog rather than a full-screen sheet. The
		 * stylesheet it makes is injected once, and it deliberately does not reach for the official CSS variables —
		 * it is our content, so it carries its own palette.
		 */
		const DIALOG_CLASS = 'hns-mega-dialog';
		function ensureDialogStyles() {
			if (typeof document === 'undefined' || !document.head || typeof document.createElement !== 'function') return;
			if (document.querySelector(`style[data-hns-mega="${DIALOG_CLASS}"]`)) return;
			const style = document.createElement('style');
			style.dataset.hnsMega = DIALOG_CLASS;
			style.textContent = `
.${DIALOG_CLASS}.${DIALOG_CLASS} {
  width: min(720px, 92vw);
  min-width: min(320px, 92vw);
  padding: 0;
  border-radius: 14px;
  background: #0e1014;
  box-shadow: 0 18px 48px rgba(0, 0, 0, .55);
}
.${DIALOG_CLASS}.${DIALOG_CLASS} > * { width: 100%; min-width: 0; }
@media (max-width: 560px) {
  .${DIALOG_CLASS}.${DIALOG_CLASS} { width: 96vw; border-radius: 12px; }
}`.trim();
			document.head.appendChild(style);
		}

		const VIEW_URL = '/mega-core/view';
		const ACTION_URL = '/mega-core/action';
		const ORB_URL = '/mega-core/orb';

		/** §4.3: low resource use, in one number. */
		const POLL_MS = 15000;
		/** The orb's box, in px. Small on purpose: it is a status light, not a widget. */
		const ORB_SIZE = 40;
		/** How far from the layer's edge the orb stops. */
		const MARGIN = 14;
		/** Drag it within this distance of an edge and it snaps there and follows it on resize. */
		const EDGE_SNAP = 56;
		/** Keyboard nudge, so the orb is movable without a pointer. */
		const KEY_STEP = 12;
		/** The gap between the orb and the panel that is anchored to it. */
		const GAP = 10;
		/** The panel's width; it shrinks in a narrow layer rather than hanging off the edge. */
		const PANEL_WIDTH = 340;
		/** Below this much room the panel prefers the other side of the orb. */
		const PANEL_MIN_HEIGHT = 220;

		const TONES = {
			ok: '#2ea043',
			warn: '#d29922',
			bad: '#f85149',
			unknown: '#8b949e'
		};

		/** The one font stack every piece of this UI shares, and the shorthand that keeps it in one place. */
		const FAMILY = '-apple-system, "Segoe UI", system-ui, sans-serif';
		const font = (size = 12, weight = 600) => `${weight} ${size}px/1.45 ${FAMILY}`;
		/** Muted text, for the second half of a bilingual label or a timestamp. */
		const MUTED = 'rgba(255,255,255,.62)';
		/** Quieter still: a label's English half, a hint. */
		const FAINT = 'rgba(255,255,255,.5)';

		/**
		 * The card both surfaces are drawn on, and why it is opaque.
		 *
		 * The first UI review found the Mega page as **white text on the official frosted panel** — unreadable,
		 * and for a reason that is structural rather than cosmetic: our text has its own colours (the official
		 * theme's label colour is not ours to assume), while `all: initial` leaves our box with **no background
		 * at all**, so whatever the host happens to paint behind it comes through. A surface with its own
		 * palette needs its own ground: this is one near-opaque card, and every piece of text in it sits on it.
		 */
		const CARD = {
			background: 'rgba(14,16,20,.97)',
			border: '1px solid rgba(255,255,255,.18)',
			borderRadius: '12px',
			boxShadow: '0 12px 32px rgba(0,0,0,.45)',
			color: '#ededed'
		};

		function clamp(value, low, high) {
			if (high < low) return low;
			return Math.min(high, Math.max(low, value));
		}

		/**
		 * Where the orb sits, expressed the way the layer it lives in is: `right` and `bottom` are distances
		 * from **the layer's own** right and bottom edges.
		 *
		 * Not `left`/`top` computed from `window.innerWidth`, which is what the first version did and what the
		 * first UI review caught. The orb does not live in the window: it lives in a slot the shell renders,
		 * and that box can be smaller than the viewport — or sit inside a transformed ancestor, where
		 * `position: fixed` is relative to the ancestor and not to the window at all. Distances from the
		 * corner of the orb's own layer survive every one of those cases, and they need no recomputation when
		 * the window changes size: the edge moves, the orb comes with it.
		 */
		function resolvePosition(stored) {
			const distance = (value) => (Number.isFinite(value) ? Math.max(MARGIN, Math.round(value)) : MARGIN);
			if (stored && Number.isFinite(stored.right) && Number.isFinite(stored.bottom)) {
				const edge = stored.edge === 'left' || stored.edge === 'right' ? stored.edge : null;
				return { right: distance(stored.right), bottom: distance(stored.bottom), edge };
			}
			// §4.3: default bottom-right, which is the corner the composer does not use.
			return { right: MARGIN, bottom: MARGIN, edge: 'right' };
		}

		/**
		 * The CSS one position means.
		 *
		 * An orb snapped to an edge asks for *that edge* (`left: 14px`) rather than for a remembered pixel
		 * count from the other one, so a resize moves it with the edge it is on instead of leaving it behind —
		 * and a free-floating orb keeps its distance from the corner, which is the same promise in the absence
		 * of an edge to follow.
		 */
		function positionStyle(position) {
			const style = { bottom: `${position.bottom}px` };
			if (position.edge === 'left') return { ...style, left: `${MARGIN}px` };
			return { ...style, right: `${position.right}px` };
		}

		/**
		 * The orb's right edge, as a distance from the layer's right edge — the anchor a panel on the orb's
		 * left side aligns to. An edge-snapped orb's number has to be derived the same way `positionStyle`
		 * derives its rendering, or the panel would align to where the orb *would* be instead of where it is.
		 */
		function orbRightOffset(position, boxWidth) {
			if (position.edge === 'left' && boxWidth) return Math.max(MARGIN, boxWidth - MARGIN - ORB_SIZE);
			return position.right;
		}

		/** The offsets, kept inside the layer's box. An unmeasured box (0) clamps nothing but the minimum. */
		function clampOffsets(offsets, box) {
			const width = Number.isFinite(box?.width) && box.width > 0 ? box.width : Infinity;
			const height = Number.isFinite(box?.height) && box.height > 0 ? box.height : Infinity;
			return {
				right: clamp(offsets.right, MARGIN, Math.max(MARGIN, width - ORB_SIZE - MARGIN)),
				bottom: clamp(offsets.bottom, MARGIN, Math.max(MARGIN, height - ORB_SIZE - MARGIN)),
				edge: null
			};
		}

		/** Snap a dragged orb to the nearer edge when it is close enough, or leave it where it is. */
		function snapToEdge(offsets, box) {
			const free = clampOffsets(offsets, box);
			const width = Number.isFinite(box?.width) && box.width > 0 ? box.width : 0;
			if (width) {
				// Measured from the layer's left edge, so "near the left edge" means what it says in the box
				// the orb is actually in rather than in the window it might not fill.
				if (width - free.right - ORB_SIZE <= EDGE_SNAP) return { ...free, edge: 'left' };
				if (free.right <= EDGE_SNAP) return { ...free, edge: 'right' };
			}
			return free;
		}

		/**
		 * Which side of the orb the panel opens on: **the side that faces the middle of the screen**.
		 *
		 * This is the rule the third UI review asked for in as many words ("根据位置向屏幕中心扩大"), and it
		 * is deliberately decided by which half the orb is in rather than by how much room each side has —
		 * "where is there space" is what produced a panel that always preferred upward.
		 *
		 * It needs no room-based tie-break, and that is worth saying because it looks like it should: the side
		 * that faces the middle **is** the roomier side. An orb whose centre is in the lower half has more than
		 * half the layer above it by definition, and likewise on the left. So "toward the centre" and "into the
		 * room" are the same instruction, and the one the user gave is the one that is implemented.
		 *
		 * The height is still clamped to the room on the chosen side (`maxHeight` at the call site), which is
		 * what keeps a very short layer from drawing a panel taller than the screen.
		 *
		 * @param {object} input the layer's box, the orb's position in it, and the panel's width
		 */
		function choosePanelSide({ boxWidth = 0, boxHeight = 0, orbLeft = 0, orbTop = 0 } = {}) {
			// An unmeasured layer has no halves to speak of: the default corner's answer stands.
			if (!boxWidth || !boxHeight) return { above: true, toTheRight: false };
			// Lower half → up (toward the middle); upper half → down.
			// Left half → the panel extends to the orb's right (growing right, toward the middle); right half →
			// to its left.
			return {
				above: orbTop + ORB_SIZE / 2 > boxHeight / 2,
				toTheRight: orbLeft + ORB_SIZE / 2 < boxWidth / 2
			};
		}

		/** The orb's glyph: a dot, plus how many things want attention when any do. */
		function orbLabel(view) {
			if (!view) return '●';
			const attention = Number(view.status?.attention || 0);
			return attention > 0 ? `● ${attention}` : '●';
		}

		/**
		 * One poller and one position, shared by the orb and the page.
		 *
		 * A store rather than component state because the two surfaces are mounted in different parts of the
		 * official UI: the orb in the frame overlay, the page inside Settings. Two independent pollers would
		 * ask DS-Hns the same question twice and could show two different answers a second apart.
		 */
		function createStore({ fetchImpl, pollMs = POLL_MS, doc = typeof document !== 'undefined' ? document : null } = {}) {
			const send = fetchImpl || ((url, init) => window.fetch(url, init));
			let snapshot = { view: null, error: null, loading: true, position: null, action: null };
			const listeners = new Set();
			let timer = null;

			function emit() {
				for (const listener of [...listeners]) {
					try {
						listener(snapshot);
					} catch { /* a broken subscriber is not the store's problem */ }
				}
			}

			function subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			}

			/** The answer, fetched. Never throws: a failed poll is drawn as a reason, not as an empty orb. */
			async function refresh() {
				try {
					const response = await send(VIEW_URL, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
					const body = await response.json();
					snapshot = { ...snapshot, view: body && body.ok !== false ? body : null, error: body && body.ok === false ? (body.reason || 'the view could not be read') : null, loading: false };
				} catch (error) {
					snapshot = { ...snapshot, error: String(error?.message || error), loading: false };
				}
				emit();
			}

			/** Where the orb was left. A failure here is not worth a message: the default corner stands. */
			async function loadPosition() {
				try {
					const response = await send(ORB_URL, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
					const body = await response.json();
					if (body?.ok && body.position) {
						snapshot = { ...snapshot, position: body.position };
						emit();
					}
				} catch { /* the default corner is a complete answer */ }
			}

			/** Keep a position in memory without a write: a drag is a stream of moves and one disk write. */
			function setPosition(position) {
				snapshot = { ...snapshot, position };
				emit();
			}

			/** Persist a position, and report the answer so the panel can say "not saved" rather than lie. */
			async function savePosition(position) {
				setPosition(position);
				try {
					const response = await send(ORB_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({ position })
					});
					const body = await response.json();
					if (body?.ok === false) snapshot = { ...snapshot, action: { ok: false, reason: body.reason || 'the position was not saved' } };
				} catch (error) {
					snapshot = { ...snapshot, action: { ok: false, reason: `the position was not saved: ${error?.message || error}` } };
					emit();
				}
			}

			/** Ask governance for one of the actions it accepts, then re-read (the state may have moved). */
			async function act(action, id) {
				try {
					const response = await send(ACTION_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({ action, id })
					});
					const body = await response.json();
					snapshot = { ...snapshot, action: { ok: body?.ok !== false, id, action, reason: body?.reason || null } };
				} catch (error) {
					snapshot = { ...snapshot, action: { ok: false, id, action, reason: String(error?.message || error) } };
				}
				emit();
				await refresh();
			}

			/**
			 * Ask for a dashboard action — today `refresh-balance`.
			 *
			 * Governance answers as soon as the account read has *started* (a provider read has a 20-second
			 * timeout and the panel must not wait for it), so the immediate re-read is not enough on its own:
			 * the account will not have changed yet. The panel shows the service's own `refreshing` state and the
			 * 15-second poller picks the answer up — but a read that only takes a second should not take fifteen
			 * to appear, so one confirmation read follows it.
			 */
			async function actDashboard(action) {
				try {
					const response = await send(ACTION_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({ action, id: null })
					});
					const body = await response.json();
					snapshot = { ...snapshot, action: { ok: body?.ok !== false, id: null, action, reason: body?.reason || null } };
				} catch (error) {
					snapshot = { ...snapshot, action: { ok: false, id: null, action, reason: String(error?.message || error) } };
				}
				emit();
				await refresh();
				if (typeof setTimeout === 'function') setTimeout(() => { void refresh(); }, 1500);
			}

			/**
			 * Start polling. Returns the disposer Cordis calls when the plugin unloads (a disabled or
			 * hot-reloaded plugin that kept its interval would be a leak with a UI attached).
			 */
			function start() {
				refresh();
				loadPosition();
				if (typeof setInterval === 'function') {
					timer = setInterval(() => {
						// Rule 2: a hidden document is not looked at, so it is not asked about either.
						if (doc && doc.visibilityState === 'hidden') return;
						refresh();
					}, pollMs);
				}
				const onVisibility = () => {
					if (!doc || doc.visibilityState !== 'hidden') refresh();
				};
				if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);
				return () => {
					if (timer) clearInterval(timer);
					timer = null;
					if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
					listeners.clear();
				};
			}

			return { snapshot: () => snapshot, subscribe, start, refresh, loadPosition, setPosition, savePosition, act, actDashboard };
		}

		/** Subscribe a component to the store, with the two hooks every environment has. */
		function useStore(store) {
			const [snapshot, setSnapshot] = React.useState(store.snapshot());
			React.useEffect(() => store.subscribe(setSnapshot), [store]);
			return snapshot;
		}

		/**
		 * The layer's own box, re-read when it changes.
		 *
		 * Everything that needs to know "how much room is there" asks this: clamping a drag, snapping to an
		 * edge, and choosing which side of the orb the panel opens on. The box belongs to the element the orb
		 * is mounted in (the wrapper inside the overlay slot), never to `window`, for the reason
		 * `resolvePosition` gives.
		 */
		function useBox(ref) {
			const [box, setBox] = React.useState({ width: 0, height: 0 });
			React.useEffect(() => {
				const node = ref.current;
				if (!node || typeof node.getBoundingClientRect !== 'function') return undefined;
				const measure = () => {
					const rect = node.getBoundingClientRect();
					const width = Math.round(rect.width);
					const height = Math.round(rect.height);
					setBox((current) => (current.width === width && current.height === height ? current : { width, height }));
				};
				measure();
				const target = typeof window !== 'undefined' ? window : null;
				if (target && typeof target.addEventListener === 'function') target.addEventListener('resize', measure);
				let observer = null;
				if (typeof ResizeObserver === 'function') {
					try {
						observer = new ResizeObserver(measure);
						observer.observe(node);
					} catch {
						observer = null;
					}
				}
				return () => {
					if (target && typeof target.removeEventListener === 'function') target.removeEventListener('resize', measure);
					if (observer) observer.disconnect();
				};
			}, [ref]);
			return box;
		}

		/** One inline-styled element. `all: initial` is the isolation: no official rule reaches inside. */
		function box(tag, props, children) {
			return React.createElement(tag, props, children);
		}

		function text(value, style) {
			return box('span', { style }, value);
		}

		/** A field row: the plan's two labels, a value, and the tone dot that makes a fault visible. */
		function FieldRow(field) {
			return box('div', { key: field.id, style: { display: 'flex', gap: '8px', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,.08)' } }, [
				box('div', { key: 'label', style: { flex: '0 0 132px', color: 'rgba(255,255,255,.62)' } }, [
					text(field.cn, { display: 'block', font: font(12) }),
					text(field.en, { display: 'block', font: font(10, 400), color: FAINT })
				]),
				text(field.value, { flex: '1 1 auto', color: field.tone ? TONES[field.tone] : '#ededed', font: font(12), wordBreak: 'break-word' })
			]);
		}

		/**
		 * The countdown row's id, spelled the same way `view.js` spells it.
		 *
		 * It is repeated rather than imported because this half is a bundle with no imports; the two strings are
		 * checked against each other by the unit tests instead of by the loader.
		 */
		const COUNTDOWN_ROW = 'price:until-off-peak';

		/** `true`, false → `12m 30s`, the same shape the host uses when it derives this from the snapshot. */
		function countdownText(seconds) {
			const whole = Math.max(0, Math.floor(seconds));
			const hours = Math.floor(whole / 3600);
			const minutes = Math.floor((whole % 3600) / 60);
			const rest = whole % 60;
			if (hours) return `${hours}h ${minutes}m`;
			if (minutes) return `${minutes}m ${rest}s`;
			return `${rest}s`;
		}

		/**
		 * The countdown, ticking while the panel is open.
		 *
		 * The view arrives every 15 s and the countdown is the one number in it that is stale the moment it
		 * arrives, so it is *re-based* against the clock the snapshot was taken with (`view.at`) and then ticked
		 * once a second here. Re-basing rather than trusting this machine's clock matters: the instant comes from
		 * DS-Hns, and a UI whose countdown disagreed with the scheduler's own window would be worse than no
		 * countdown at all.
		 *
		 * @returns {number|null} seconds left, or `null` when the dashboard carries no countdown at all
		 */
		function useCountdown(dashboard, at) {
			const row = ((dashboard?.lines || []).find((entry) => entry.id === 'price')?.rows || []).find((entry) => entry.id === COUNTDOWN_ROW);
			const target = Date.parse(String(row?.nextChangeIso || ''));
			const baseAt = Date.parse(String(at || ''));
			const baseSeconds = Number.isFinite(target) && Number.isFinite(baseAt) ? (target - baseAt) / 1000 : null;
			const [seconds, setSeconds] = React.useState(() => baseSeconds);
			React.useEffect(() => {
				if (baseSeconds === null) {
					setSeconds(null);
					return undefined;
				}
				setSeconds(baseSeconds);
				if (typeof setInterval !== 'function') return undefined;
				const timer = setInterval(() => setSeconds((current) => (current === null ? null : Math.max(0, current - 1))), 1000);
				return () => clearInterval(timer);
			}, [ row?.nextChangeIso, at ]);
			return seconds;
		}

		/**
		 * The live dashboard: the price window and its countdown, the account, the queue and the parallelism.
		 *
		 * It is drawn from `view.dashboard`, which the host composed out of the *same* governance snapshot the
		 * fields below come from — the numbers cannot disagree with the Control Center's, because there is only
		 * one set of them. A snapshot with no dashboard block is a reason, not a wall of `—`.
		 *
		 * The groups are **folds, all shut to begin with and one open at a time** afterwards. Every category costs
		 * one line while it is shut — its heading and its headline — which is what lets the panel be read at a
		 * glance: the old panel listed fifteen numbers at once and the six that mattered were somewhere in the
		 * middle of them. What is open is drawn as a **card of its own** (`card` below): a raised, tinted panel
		 * whose colour separates it from the headings around it, so "this is the one I am looking at" needs no
		 * reading.
		 */
		function Dashboard({ dashboard, at, onDashboardAction }) {
			// Hooks first, unconditionally: the ticker below is what keeps the countdown a countdown, and the
			// open fold is component state, so a poll that redraws the panel does not shut what the user opened.
			const remaining = useCountdown(dashboard, at);
			/** Which fold is open, by id — and at most **one**. Shut is the first state the user sees. */
			const groups = (dashboard?.ok === false || !dashboard) ? [] : [
				...(dashboard.lines || []).map((entry) => ({ id: entry.id || `group:${entry.cn}`, cn: entry.cn, en: entry.en, rows: entry.rows || [] })),
				{ id: 'execution', cn: '任务', en: 'Tasks', rows: dashboard.execution || [] },
				{ id: 'parallelism', cn: '并行', en: 'Parallelism', rows: dashboard.parallelism || [] }
			].filter((entry) => entry.rows.length);
			const [openCategory, setOpenCategory] = React.useState(null);
			if (!dashboard) return null;
			if (dashboard.ok === false) {
				return box('div', { key: 'dash', style: { padding: '4px 0', color: MUTED, fontWeight: '400' } }, dashboard.reason || '仪表盘不可用 · dashboard unavailable');
			}
			// The countdown row is the one number that moves between two polls, so it is drawn from the ticker
			// rather than from the figure the snapshot carried (`view.js` explains the pairing).
			const row = (entry) => (entry.id === COUNTDOWN_ROW && remaining !== null
				? { ...entry, value: countdownText(remaining) }
				: entry);
			/**
			 * The dashboard's own buttons — today `refresh-balance`, the read that makes the account newer.
			 *
			 * They are drawn only when the snapshot offers them (`control-center.cjs` withholds one while the
			 * balance is already current), which is the rule the module actions follow too: a button that cannot
			 * change anything is a button that promises something the layer will not do.
			 */
			const actions = (dashboard.actions || []).map((action) => box('button', {
				key: `dash:${action.id}`,
				type: 'button',
				title: action.reason ? `余额状态：${action.reason} · balance state: ${action.reason}` : `${action.cn} · ${action.en}`,
				onClick: () => onDashboardAction(action.id),
				style: {
					all: 'initial',
					display: 'inline-flex',
					alignItems: 'center',
					padding: '3px 8px',
					margin: '6px 6px 0 0',
					borderRadius: '6px',
					border: `1px solid ${TONES.busy}`,
					color: TONES.busy,
					background: 'rgba(88,166,255,.08)',
					cursor: 'pointer',
					font: font(11)
				}
			}, `${action.cn} · ${action.en}`));
			/**
			 * One fold: a heading that opens and shuts, the group's headline while it is shut, and the rows under it
			 * when it is open.
			 *
			 * The heading is a real `button` (keyboard-reachable, `aria-expanded` set), and opening one closes the
			 * other — `setOpenCategory(id)` *is* the one-at-a-time rule, rather than a condition applied when the
			 * rows are drawn.
			 *
			 * A shut group keeps its **headline** on the heading line. Folding must not turn the panel into six
			 * labels: the numbers a glance is for (the window, the balance, the queue, the parallelism) stay
			 * readable with everything shut, and the fold is what hides the *detail* behind them.
			 */
			const headline = (group) => {
				const row = (group.rows || []).find((entry) => String(entry.id || '').endsWith(':state')) || (group.rows || [])[0] || null;
				if (!row || !row.value || row.value === '—') return null;
				const value = String(row.value);
				return value.length > 18 ? `${value.slice(0, 17)}…` : value;
			};
			const fold = (group) => {
				const isOpen = openCategory === group.id;
				const summary = headline(group);
				const heading = box('button', {
					key: `h:${group.id}`,
					type: 'button',
					'aria-expanded': isOpen,
					'data-hns-mega-category': group.id,
					'data-open': isOpen ? 'on' : 'off',
					title: isOpen ? `收起 ${group.cn} · collapse ${group.en}` : `展开 ${group.cn} · expand ${group.en}`,
					onClick: () => setOpenCategory(isOpen ? null : group.id),
					style: {
						all: 'initial',
						display: 'flex',
						alignItems: 'center',
						gap: '6px',
						width: '100%',
						boxSizing: 'border-box',
						padding: isOpen ? '6px 9px' : '4px 0',
						margin: 0,
						border: 'none',
						borderTop: isOpen ? 'none' : '1px solid rgba(255,255,255,.08)',
						background: 'transparent',
						color: MUTED,
						cursor: 'pointer',
						textAlign: 'left',
						font: font(11)
					}
				}, [
					// A caret rather than a colour change: the panel already spends colour on faults, and a state
					// that is only a hue is a state half the users cannot see.
					text(isOpen ? '▾' : '▸', { key: 'caret', flex: '0 0 auto', color: FAINT }),
					text(`${group.cn} · ${group.en}`, {
						key: 'label',
						flex: '1 1 auto',
						textTransform: 'uppercase',
						letterSpacing: '.04em',
						color: isOpen ? '#ffffff' : MUTED
					}),
					summary ? text(summary, { key: 'value', flex: '0 1 auto', color: isOpen ? '#ffffff' : '#ededed', font: font(11), textAlign: 'right' }) : null
				].filter(Boolean));
				if (!isOpen) return heading;
				/**
				 * The open category is a **card**, not a longer run of rows.
				 *
				 * Three properties do the work, and each one is about looking rather than about taste: it is
				 * *lighter* than the panel behind it (`.03` white on `rgba(14,16,20)`), so it reads as raised; the
				 * heading that opens it is *inside* the card, so the tint has an owner; and the card sits on its
				 * own line with a margin, so the category above and the one below are visibly not part of it. The
				 * caret already said which one is open — this is what makes it findable without reading.
				 */
				return box('div', {
					key: `g:${group.id}`,
					'data-hns-mega-card': group.id,
					style: {
						background: 'rgba(255,255,255,.055)',
						border: '1px solid rgba(255,255,255,.16)',
						borderRadius: '8px',
						margin: '4px 0',
						overflow: 'hidden'
					}
				}, [
					heading,
					box('div', {
						key: 'body',
						style: { padding: '0 9px 6px' }
					}, group.rows.map((entry) => React.createElement(FieldRow, { key: entry.id || `${group.id}:${entry.cn}`, ...row(entry) })))
				]);
			};
			return box('div', { key: 'dash', 'data-hns-mega-dashboard': openCategory ? 'open' : 'shut' }, [
				...groups.map(fold),
				actions.length ? box('div', { key: 'dash-actions' }, actions) : null
			].filter(Boolean));
		}

		/** A line of the panel's list: faults first, positives after (both matter — see `view.js`). */
		function StatusLine(entry, index) {
			return box('div', { key: `${index}:${entry.text}`, style: { display: 'flex', gap: '6px', padding: '3px 0' } }, [
				box('span', { key: 'dot', style: { flex: '0 0 auto', color: TONES[entry.tone] || TONES.unknown } }, '•'),
				text(entry.text, { flex: '1 1 auto', color: entry.tone === 'ok' ? 'rgba(255,255,255,.72)' : '#ededed', font: font(12), wordBreak: 'break-word' })
			]);
		}

		/** A button that matches the panel's own styling instead of the official one. */
		function ActionButton({ label, title, onClick, tone, key }) {
			return box('button', {
				key,
				type: 'button',
				title,
				onClick,
				// The panel is our surface: taking focus here is expected, and it keeps the keyboard usable.
				style: {
					all: 'initial',
					display: 'inline-flex',
					alignItems: 'center',
					gap: '4px',
					padding: '4px 8px',
					margin: '2px 4px 2px 0',
					borderRadius: '6px',
					border: `1px solid ${tone ? TONES[tone] : 'rgba(255,255,255,.22)'}`,
					color: tone ? TONES[tone] : '#ededed',
					background: 'rgba(255,255,255,.04)',
					cursor: 'pointer',
					font: font(12)
				}
			}, label);
		}

		/**
		 * One body for both surfaces, at the size each one is.
		 *
		 * The dashboard is the orb's (§4.2's expanded panel is where the live numbers live now); the §4.4 fields,
		 * the module roster and the plugin roster are the page's. That split is what `expanded` selects, and it is
		 * the reason the two surfaces cannot drift: both render the same `view`, and the numbers on the ball come
		 * from the same snapshot the page's fields do.
		 */
		function MegaBody({ snapshot, onAction, onRefresh, expanded, onToggleExpanded, onDashboardAction }) {
			const view = snapshot?.view;
			if (!view) {
				return box('div', { style: { padding: '8px 0', color: '#ededed', font: font(12) } }, [
					text(snapshot?.loading ? '正在连接 DS-Hns… · connecting' : 'DS-Hns 没有应答 · no answer from DS-Hns', { display: 'block' }),
					snapshot?.error ? text(snapshot.error, { display: 'block', marginTop: '4px', color: TONES.warn, fontWeight: '400' }) : null
				].filter(Boolean));
			}

			const attention = Number(view.status?.attention || 0);
			const header = box('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '8px', paddingBottom: '6px' } }, [
				box('span', { key: 'dot', style: { color: TONES[view.status?.tone] || TONES.unknown, fontSize: '14px' } }, '●'),
				text(view.status?.label || '—', { flex: '1 1 auto', color: '#ffffff', font: font(13) }),
				text(attention ? `${attention} 项需处理 · to look at` : '无异常 · nothing to look at', { color: attention ? TONES.warn : MUTED, font: font(10, 400) })
			]);

			// What the ball exists for: the price window and its countdown, the account, the queue, the parallelism.
			const dashboard = expanded ? null : React.createElement(Dashboard, {
				dashboard: view.dashboard,
				at: view.at,
				onDashboardAction: (action) => onDashboardAction(action)
			});
			const lines = (view.lines || []).map(StatusLine);
			const numbers = [
				['活动 / active', `${view.status?.active ?? 0}/${view.status?.total ?? 0}`],
				['待人工 / pending', String(view.status?.pending ?? 0)],
				['阻塞与重试 / failing', String(view.status?.failing ?? 0)],
				['更新于 / at', String(view.at || '—').slice(11, 19)]
			].map(([label, value]) => box('div', { key: label, style: { display: 'flex', gap: '6px', padding: '2px 0' } }, [
				text(label, { flex: '0 0 132px', color: MUTED }),
				text(value, { color: '#ededed', font: font(12) })
			]));

			const actions = (view.actions || []).map((action) => React.createElement(ActionButton, {
				key: `all:${action}`,
				label: action,
				title: `对全部有问题的模块执行 ${action}`,
				onClick: () => onAction(action, null)
			}));

			const detail = expanded ? box('div', { key: 'detail', style: { marginTop: '8px' } }, [
				box('div', { key: 'fields', style: { marginTop: '4px' } }, (view.fields || []).map(FieldRow)),
				box('div', { key: 'rosters', style: { marginTop: '8px' } }, [
					text('模块 · Modules', { display: 'block', color: 'rgba(255,255,255,.62)', marginBottom: '4px' }),
					...((view.modules || []).length
						? view.modules.map((entry) => box('div', { key: `m:${entry.id}`, style: { padding: '3px 0' } }, [
							text(`${entry.state === 'HEALTHY' ? '✓' : entry.state === 'FAILED' ? '✖' : '⚠'} ${entry.id} — ${entry.state}${entry.retries ? ` · ${entry.retries} retry` : ''}${entry.lastError ? ` · ${entry.lastError}` : ''}`, { display: 'block', color: TONES[entry.tone] || '#ededed', fontWeight: '400' }),
							...(entry.actions || []).map((action) => React.createElement(ActionButton, { key: `m:${entry.id}:${action}`, label: action, onClick: () => onAction(action, entry.id) }))
						]))
						: [text('—', { color: MUTED })]),
					text('社区插件 · Bundled plugins', { display: 'block', marginTop: '6px', color: 'rgba(255,255,255,.62)', marginBottom: '4px' }),
					...((view.plugins || []).length
						? view.plugins.map((entry) => box('div', { key: `p:${entry.id}`, style: { padding: '3px 0' } }, [
							text(`${entry.state === 'installed' ? '✓' : '⚠'} ${entry.id} — ${entry.state}${entry.installedVersion ? ` @${entry.installedVersion}` : ''}${entry.expected ? ` · pin ${entry.expected}` : ''}${entry.channel ? ` · ${entry.channel}` : ''}${entry.tested ? ' · tested' : ''}`, { display: 'block', color: TONES[entry.tone] || '#ededed', fontWeight: '400' }),
							...(entry.actions || []).map((action) => React.createElement(ActionButton, { key: `p:${entry.id}:${action}`, label: action, onClick: () => onAction(action, entry.id) }))
						]))
						: [text('—', { color: MUTED })])
				])
			]) : null;

			return box('div', { style: { color: '#ededed', font: font(12) } }, [
				header,
				dashboard,
				box('div', { key: 'lines', style: { marginTop: '2px' } }, lines),
				box('div', { key: 'numbers', style: { marginTop: '6px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,.08)' } }, numbers),
				box('div', { key: 'actions', style: { marginTop: '6px' } }, [
					...actions,
					React.createElement(ActionButton, { key: 'refresh', label: '刷新 · Refresh', onClick: () => onRefresh() }),
					onToggleExpanded ? React.createElement(ActionButton, { key: 'expand', label: expanded ? '收起 · Collapse' : '治理详情 · Governance', onClick: () => onToggleExpanded(!expanded) }) : null
				].filter(Boolean)),
				snapshot.action ? text(
					snapshot.action.ok ? `✓ ${snapshot.action.action}${snapshot.action.id ? ` ${snapshot.action.id}` : ''}` : `✖ ${snapshot.action.reason || '操作被拒绝 · refused'}`,
					{ display: 'block', marginTop: '4px', color: snapshot.action.ok ? TONES.ok : TONES.bad, fontWeight: '400' }
				) : null,
				/**
				 * §4.4's page is also reachable from the official Settings, and that is the route that does
				 * not depend on the orb: the settings modal's open state is component-local in the official
				 * UI (there is no public "open settings at section X"), so this says where the page lives
				 * instead of offering a button that could not work.
				 */
				expanded ? null : text('完整页面也在 官方 Settings › Mega · the full page is also in Settings › Mega', { display: 'block', marginTop: '6px', color: FAINT, font: font(10, 400) }),
				detail
			].filter(Boolean));
		}

		/** The orb, its drag and its panel (§4.1-§4.3). */
		function MegaOrb({ store }) {
			const snapshot = useStore(store);
			const [open, setOpen] = React.useState(false);
			// The panel opens on the dashboard, and that is a decision about what a ball is for: the old ball showed
			// the price and its valley timer, the account balance, the queue and the parallelism, and those are the
			// same `view.dashboard` the system ball draws. The §4.4 fields, the rosters and the recovery
			// actions are one click away behind the toggle, which is the page's own body at page size.
			const [expanded, setExpanded] = React.useState(false);
			const drag = React.useRef(null);
			// The wrapper is the layer's own box: `position: fixed; inset: 0` covers whatever box the shell
			// gave this slot, so everything below is placed relative to *that* and never to the window.
			const layerRef = React.useRef(null);
			/**
			 * A click anywhere that is not the ball or its panel closes the panel.
			 *
			 * It listens on `document` and tests the two boxes, which is the rule the system ball's own window
			 * follows (`orb.js`): a panel that only closes by its own × is a panel the user has to hunt for, and
			 * nothing is captured or prevented here — the click that dismisses the panel also does whatever the
			 * user meant by it, which is what keeps this from eating a click aimed at the composer.
			 */
			const orbRef = React.useRef(null);
			const panelRef = React.useRef(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const doc = typeof document !== 'undefined' ? document : null;
				if (!doc || typeof doc.addEventListener !== 'function') return undefined;
				const onDocumentPointerDown = (event) => {
					const target = event?.target;
					for (const node of [orbRef.current, panelRef.current]) {
						if (node && typeof node.contains === 'function' && node.contains(target)) return;
					}
					setOpen(false);
				};
				doc.addEventListener('pointerdown', onDocumentPointerDown);
				return () => doc.removeEventListener('pointerdown', onDocumentPointerDown);
			}, [ open ]);
			const layer = useBox(layerRef);
			const position = resolvePosition(snapshot.position);
			const tone = TONES[snapshot.view?.status?.tone] || TONES.unknown;
			const label = orbLabel(snapshot.view);
			const hover = snapshot.view?.hover || ['DS-Hns'];

			/** The box a drag is clamped to: the layer's, measured live when the pointer is down. */
			function layerBox(event) {
				const node = event?.currentTarget?.parentElement;
				if (node && typeof node.getBoundingClientRect === 'function') {
					const rect = node.getBoundingClientRect();
					return { width: Math.round(rect.width), height: Math.round(rect.height) };
				}
				return layer;
			}

			function onPointerDown(event) {
				// Rule 1: a click must not pull focus out of the composer. `preventDefault` on pointerdown is
				// what makes that true while keeping the button in the tab order.
				if (event && typeof event.preventDefault === 'function') event.preventDefault();
				if (event && event.button !== undefined && event.button !== 0) return;
				// The drag is measured from the orb's own rectangle, so it works the same whether that
				// rectangle is in window coordinates or inside a transformed ancestor — and the offsets it
				// produces are distances from the layer's corner, which is what gets stored.
				const rect = event?.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function'
					? event.currentTarget.getBoundingClientRect()
					: null;
				drag.current = {
					startX: rect ? rect.left : Number(event?.clientX || 0),
					startY: rect ? rect.top : Number(event?.clientY || 0),
					// The offsets the drag started from. They are what every move is measured against: using
					// the *running* offsets instead would apply each pointer event's whole delta again, and
					// the orb would accelerate away from the pointer.
					startRight: position.right,
					startBottom: position.bottom,
					right: position.right,
					bottom: position.bottom,
					edge: position.edge,
					box: layerBox(event),
					moved: false
				};
				if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
					try {
						event.currentTarget.setPointerCapture(event.pointerId);
					} catch { /* capture is an optimisation; pointermove still arrives */ }
				}
			}

			function onPointerMove(event) {
				const current = drag.current;
				if (!current) return;
				const dx = Number(event?.clientX || 0) - current.startX;
				const dy = Number(event?.clientY || 0) - current.startY;
				// Left and up both *increase* the distances from the corner: the orb follows the pointer.
				const next = clampOffsets({ right: current.startRight - dx, bottom: current.startBottom - dy }, current.box);
				current.moved = true;
				current.right = next.right;
				current.bottom = next.bottom;
				store.setPosition(next);
			}

			function onPointerUp() {
				const current = drag.current;
				drag.current = null;
				if (!current) return;
				const snapped = snapToEdge({ right: current.right, bottom: current.bottom }, current.box);
				store.savePosition(snapped);
				// A press that did not move is a click: that is what opens the panel.
				if (!current.moved) setOpen((value) => !value);
			}

			function onKeyDown(event) {
				const key = event?.key;
				if (key === 'Escape') return setOpen(false);
				if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
					if (typeof event.preventDefault === 'function') event.preventDefault();
					return setOpen((value) => !value);
				}
				const deltas = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] };
				const delta = deltas[key];
				if (!delta) return;
				if (typeof event.preventDefault === 'function') event.preventDefault();
				// Arrow left/right move the orb, so they *add to* the distance from the right edge; up/down
				// likewise add to the distance from the bottom.
				const moved = snapToEdge({ right: position.right - delta[0], bottom: position.bottom - delta[1] }, layer);
				store.savePosition(moved);
			}

			const orb = box('button', {
				type: 'button',
				ref: orbRef,
				// The name a screen reader reads, and the hover text §4.2 describes, are the same four lines.
				'aria-label': hover.join(' · '),
				'aria-expanded': open,
				title: hover.join('\n'),
				onPointerDown,
				onPointerMove,
				onPointerUp,
				onPointerCancel: onPointerUp,
				onKeyDown,
				'data-hns-mega-orb': 'on',
				'data-tone': snapshot.view?.status?.tone || 'unknown',
				style: {
					// `all: initial` first: nothing the official stylesheet says applies inside this subtree.
					all: 'initial',
					// `absolute` inside the wrapper, not `fixed` against the window: the wrapper *is* the box
					// the slot gave us, and `fixed` would silently become relative to a transformed ancestor.
					position: 'absolute',
					...positionStyle(position),
					width: `${ORB_SIZE}px`,
					height: `${ORB_SIZE}px`,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					borderRadius: '50%',
					border: `1px solid ${tone}`,
					background: 'rgba(20,22,26,.82)',
					boxShadow: '0 2px 10px rgba(0,0,0,.35)',
					color: tone,
					font: font(12),
					cursor: 'pointer',
					// The overlay layer is click-through; this is the opt-in that keeps the orb itself usable.
					pointerEvents: 'auto',
					touchAction: 'none',
					userSelect: 'none',
					zIndex: 2147483000
				}
			}, label);

			/**
			 * Where the panel goes, and the two reviews that changed it.
			 *
			 * The first version pinned a `top` and a `left`, gave the panel a fixed 70vh and let it scroll:
			 * opening "详情" made a longer document inside a box that was already the wrong shape. The second
			 * anchored it by `bottom`/`right`, which fixed the scrolling but overcorrected in the direction
			 * the next review named: it *preferred upward* whenever there was room above, so an orb parked in
			 * the top half still opened a panel up into the top edge.
			 *
			 * What it does now is what that review asked for: the panel opens **toward the middle of the
			 * screen**, decided by which half the orb is in. Lower half → above the orb, growing up; upper
			 * half → below, growing down; left half → to its right, growing right; right half → to its left.
			 * The room the panel takes is always the room between the orb and the middle, and its far edge is
			 * what moves as its content grows.
			 *
		 * One guard remains, and it is about the size of the layer rather than about taste: the panel caps its
		 * own height at the room on the side it chose, so a scrollbar appears only when the content is taller
		 * than the whole layer — a last resort, not the layout. (The horizontal side gets a stronger veto, in
		 * the rule below: a panel's *width* cannot be clamped the way its height can.)
			 */
			const boxWidth = layer.width || 0;
			const boxHeight = layer.height || 0;
			// The orb's real left edge, which for an edge-snapped orb is the margin rather than a number
			// derived from the other edge — the same rule `positionStyle` applies when it renders it.
			const orbLeft = !boxWidth
				? 0
				: (position.edge === 'left' ? MARGIN : Math.max(MARGIN, boxWidth - position.right - ORB_SIZE));
			const orbTop = boxHeight ? Math.max(0, boxHeight - position.bottom - ORB_SIZE) : 0;
			const spaceAbove = orbTop;
			const spaceBelow = boxHeight ? position.bottom : 0;
			const panelWidth = boxWidth ? Math.min(PANEL_WIDTH, Math.max(220, boxWidth - 2 * MARGIN)) : PANEL_WIDTH;
			const side = choosePanelSide({ boxWidth, boxHeight, orbLeft, orbTop });
			const above = side.above;
			const room = above ? spaceAbove : spaceBelow;
			const panelStyle = {
				all: 'initial',
				position: 'absolute',
				width: `${Math.round(panelWidth)}px`,
				// Anchored to the orb's own corner: the panel's near edges stay put and the far ones move.
				...(above
					? { bottom: `${position.bottom + ORB_SIZE + GAP}px` }
					: { top: `${orbTop + ORB_SIZE + GAP}px` }),
				// Horizontally it *aligns* with the orb rather than standing off it — the near edge is the
				// orb's near edge, and the far edge is the one that moves as the content grows.
				...(side.toTheRight
					? { left: `${orbLeft}px` }
					: { right: `${orbRightOffset(position, boxWidth)}px` }),
				// Only ever as tall as the room on the side it opened on; that is the scrollbar's last resort.
				...(room ? { maxHeight: `${Math.max(PANEL_MIN_HEIGHT, room - GAP - MARGIN)}px` } : {}),
				overflowY: 'auto',
				padding: '10px 12px',
				...CARD,
				pointerEvents: 'auto',
				zIndex: 2147483000,
				font: font(12)
			};
			// The panel is built only when it is open, but the *wrapper* is always rendered: it is the box the
			// orb measures, so a panel's very first frame already knows how much room it has.
			const panel = !open ? null : box('div', {
				ref: panelRef,
				'data-hns-mega-panel': 'on',
				'data-hns-mega-panel-side': above ? 'above' : 'below',
				'data-hns-mega-panel-across': side.toTheRight ? 'right' : 'left',
				role: 'dialog',
				'aria-label': 'Mega',
				style: panelStyle
			}, [
				box('div', { key: 'title', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } }, [
					text('Mega', { flex: '1 1 auto', color: '#ffffff', font: font(14) }),
					React.createElement(ActionButton, { key: 'close', label: '×', title: '收起 · Collapse', onClick: () => setOpen(false) })
				]),
				/**
				 * The ball's own new-task entry, **first** in the panel.
				 *
				 * First rather than last because it is the one thing on this panel that starts something instead of
				 * reporting something: below the dashboard's categories it would be a line the user has to scroll to,
				 * which is how it went unnoticed. The same component the official header registers (see
				 * `NewTaskAction`), in its compact shape.
				 */
				React.createElement(NewTaskAction, { key: 'new-task', compact: true }),
				React.createElement(MegaBody, {
					snapshot,
					expanded,
					onToggleExpanded: setExpanded,
					onRefresh: () => store.refresh(),
					onAction: (action, id) => store.act(action, id),
					onDashboardAction: (action) => store.actDashboard(action)
				})
			]);

			// The wrapper is the layer's box: `inset: 0` on it, and both the orb and the panel are absolute
			// inside it, so the panel can never be clipped by the orb's own box and neither is positioned
			// against the window.
			return box('div', {
				key: 'mega-orb-stack',
				ref: layerRef,
				'data-hns-mega-layer': 'on',
				style: { all: 'initial', position: 'fixed', inset: '0', pointerEvents: 'none' }
			}, [orb, panel].filter(Boolean));
		}

		/** The Mega settings page (§4.4). The official shell owns the modal; we own one section inside it. */
		function MegaPage({ store, close }) {
			const snapshot = useStore(store);
			return box('div', {
				'data-hns-mega-page': 'on',
				// The official settings column is frosted glass, and our text has its own palette: the page
				// therefore brings its own opaque card (see `CARD`) instead of assuming a background.
				style: { all: 'initial', display: 'block', padding: '14px 16px', maxWidth: '760px', ...CARD, font: font(12) }
			}, [
				box('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } }, [
					text('Mega · DS-Hns 监督层', { flex: '1 1 auto', color: '#ffffff', font: font(14) }),
					typeof close === 'function' ? React.createElement(ActionButton, { key: 'close', label: '关闭 · Close', onClick: close }) : null
				].filter(Boolean)),
				React.createElement(MegaBody, {
					snapshot,
					// §4.4 is the full page, so it opens expanded and never offers to collapse into itself.
					expanded: true,
					onRefresh: () => store.refresh(),
					onAction: (action, id) => store.act(action, id)
				})
			]);
		}

		/** The two routes the new-task dialog talks to. Same origin, and the same bridge everything else uses. */
		const TIMING_URL = '/mega-core/timing';
		const TASK_URL = '/mega-core/task';

		/**
		 * The page's own `fetch`.
		 *
		 * The bundle is loaded into a document, not a module with a global scope of its own, so the function that
		 * exists is the one on `window` — the same one `createStore` uses. Reaching for a bare `fetch` works in a
		 * browser by accident and fails anywhere else (a sandbox, an older embedder), which is exactly the kind of
		 * accident a "the dialog does nothing" bug report is made of.
		 */
		function pageFetch(url, init) {
			const target = typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch : (typeof fetch === 'function' ? fetch : null);
			if (!target) return Promise.reject(new Error('this page has no fetch'));
			return target(url, init);
		}

		/** `172` → `2m 52s`; the same shape the dashboard's countdown uses, for the same reason. */
		function offsetText(milliseconds) {
			const whole = Math.max(0, Math.round(milliseconds / 1000));
			const hours = Math.floor(whole / 3600);
			const minutes = Math.floor((whole % 3600) / 60);
			const seconds = whole % 60;
			if (hours) return `${hours}h ${minutes}m`;
			if (minutes) return `${minutes}m ${seconds}s`;
			return `${seconds}s`;
		}

		/**
		 * A local `datetime-local` value as an instant.
		 *
		 * The browser's own local time is the right reading here — the user typed a wall clock in the time zone
		 * they are sitting in — and `new Date('2026-09-15T14:30')` is *local* by specification (no `Z`, no offset).
		 * What DS-Hns stores is the instant, so this is where the two meet.
		 */
		function instantFromLocal(value) {
			const text = String(value || '').trim();
			if (!text) return null;
			const at = new Date(text);
			return Number.isFinite(at.getTime()) ? at : null;
		}

		/** The same instant back in the `datetime-local` shape, for the field's initial value. */
		function localFromInstant(iso) {
			const at = new Date(String(iso || ''));
			if (!Number.isFinite(at.getTime())) return '';
			const pad = (value) => String(value).padStart(2, '0');
			return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
		}

		/**
		 * The new-task dialog: **a conversation, sent at a time** (pluginize Phase 2).
		 *
		 * It is an official centred sub-page whose composer is the shape of a chat: a prompt box you type into,
		 * and under it — at the bottom of the dialog, where the schedule belongs — when it should be sent. The
		 * thing it makes is the same task the dock's own form makes (`scheduler.addTask` in DS-Hns), delivered as a
		 * new official session, which is also what pressing send in the composer does.
		 */
		function NewTaskDialog({ open, onClose }) {
			// The choices the dialog offers are DS-Hns' own answer, so nothing here is invented: the budget, the
			// schedule's time zone and the peak windows all come from `GET /mega-core/timing`.
			const [timing, setTiming] = React.useState(null);
			const [timingError, setTimingError] = React.useState(null);
			const [prompt, setPrompt] = React.useState('');
			const [startAt, setStartAt] = React.useState('');
			const [allowPeak, setAllowPeak] = React.useState(false);
			const [deliveryMode, setDeliveryMode] = React.useState('official-session');
			const [busy, setBusy] = React.useState(false);
			const [result, setResult] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [now, setNow] = React.useState(() => Date.now());

			/** Read the timing surface. Called on open and from the dialog's own retry. */
			const loadTiming = React.useCallback(() => {
				let live = true;
				Promise.resolve()
					.then(() => pageFetch(TIMING_URL, { headers: { accept: 'application/json' }, credentials: 'same-origin' }))
					.then((response) => response.json().then((body) => ({ response, body })))
					.then(({ response, body }) => {
						if (!live) return;
						if (!response.ok || !body || body.ok === false) {
							setTiming(null);
							setTimingError(body?.reason || `the timing surface answered ${response.status}`);
							return;
						}
						setTiming(body);
						setTimingError(null);
						setAllowPeak(body.defaults?.allowPeak === true);
						setDeliveryMode(body.defaults?.deliveryMode === 'headless' ? 'headless' : 'official-session');
						setStartAt((current) => current || localFromInstant(body.defaults?.startAt));
					})
					.catch((failure) => {
						if (!live) return;
						setTiming(null);
						setTimingError(String(failure?.message || failure));
					});
				return () => { live = false; };
			}, []);

			// One read per opening, and a fresh default time each time: "in three minutes" means three minutes
			// from now, not from the last time the dialog was opened.
			React.useEffect(() => {
				if (!open) return undefined;
				setResult(null);
				setError(null);
				setNow(Date.now());
				return loadTiming();
			}, [open, loadTiming]);

			/**
			 * Keep the "in 2h 12m" line honest while the dialog sits open.
			 *
			 * A minute is enough: this is a sentence about a time the user chose, not a countdown to a deadline,
			 * and a ticking clock in a form is noise.
			 */
			React.useEffect(() => {
				if (!open || typeof setInterval !== 'function') return undefined;
				const timer = setInterval(() => setNow(Date.now()), 30_000);
				return () => clearInterval(timer);
			}, [open]);

			if (!open || !primitives) return null;

			const instant = instantFromLocal(startAt);
			const future = instant !== null && instant.getTime() > now;
			const canSubmit = Boolean(prompt.trim()) && instant !== null && !busy;

			/** One preset: a wall-clock instant a given number of minutes from now, in the field's own shape. */
			const preset = (label, minutes) => React.createElement(primitives.Button, {
				key: `p:${label}`,
				variant: 'ghost',
				size: 'sm',
				onClick: () => setStartAt(localFromInstant(new Date(Date.now() + minutes * 60_000).toISOString()))
			}, label);

			const send = () => {
				if (!canSubmit) return;
				setBusy(true);
				setError(null);
				setResult(null);
				Promise.resolve()
					.then(() => pageFetch(TASK_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({
							prompt,
							startAt: instant.toISOString(),
							allowPeak,
							deliveryMode
						})
					}))
					.then((response) => response.json().then((body) => ({ response, body })))
					.then(({ response, body }) => {
						if (!response.ok || !body || body.ok === false) {
							setError(body?.reason || `the task was refused (${response.status})`);
							return;
						}
						setResult(body.task || { ok: true });
						setPrompt('');
					})
					.catch((failure) => setError(String(failure?.message || failure)))
					.finally(() => setBusy(false));
			};

			/**
			 * The composer's keyboard grammar, which is the one thing "behaves like the official input" means in
			 * practice: **Enter sends, Shift+Enter is a newline, and Enter during an IME composition commits the
			 * candidate instead of sending**. The last one is why `isComposing` is read off the native event: a
			 * Chinese or Japanese user pressing Enter to pick a candidate would otherwise fire an unfinished task.
			 */
			const onKeyDown = (event) => {
				if (event.key !== 'Enter' || event.shiftKey) return;
				if (event.nativeEvent && event.nativeEvent.isComposing) return;
				event.preventDefault();
				send();
			};

			const label = (cn, en) => box('span', { key: `l:${en}`, style: { display: 'block' } }, [
				text(cn, { key: 'cn', display: 'block', color: '#ededed', font: font(12) }),
				text(en, { key: 'en', display: 'block', color: FAINT, font: font(10, 400) })
			]);

			/**
			 * One row of the form: the two labels in a fixed column, the control in the rest.
			 *
			 * The label column is a **constant** (`LABEL_COLUMN`) because the presets row below the time field
			 * aligns to it as well: a form whose rows and whose shortcuts start at different x is a form that reads
			 * as two.
			 */
			const field = (id, cn, en, control, hint) => box('div', {
				key: id,
				style: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '6px 0' }
			}, [
				box('div', { key: 'label', style: { flex: `0 0 ${LABEL_COLUMN}px`, paddingTop: '3px' } }, [label(cn, en)]),
				box('div', { key: 'control', style: { flex: '1 1 auto', minWidth: 0 } }, [
					control,
					hint ? text(hint, { key: 'hint', display: 'block', marginTop: '3px', color: FAINT, font: font(10, 400), wordBreak: 'break-word' }) : null
				].filter(Boolean))
			]);

			const inputStyle = {
				all: 'initial',
				boxSizing: 'border-box',
				width: '100%',
				padding: '5px 8px',
				borderRadius: '6px',
				border: '1px solid rgba(255,255,255,.18)',
				background: 'rgba(255,255,255,.04)',
				color: '#ededed',
				font: font(12),
				colorScheme: 'dark'
			};

			/** The summary the user reads before committing: exactly when this will be sent, and how. */
			const summary = () => {
				if (instant === null) return '还没有选择时间 · no time chosen yet';
				const clock = `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`;
				const date = `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, '0')}-${String(instant.getDate()).padStart(2, '0')}`;
				if (!future) return `⚠ 这个时间已经过去 · that time is in the past (${date} ${clock})`;
				const offset = offsetText(instant.getTime() - now);
				const peakNote = timing?.peak?.peak && !allowPeak
					? ' · 现在处于峰价时段，未允许峰值时任务会挂起到谷价'
					: '';
				return `将在 ${date} ${clock} 作为${deliveryMode === 'headless' ? 'Headless 后台任务' : '官方新会话'}发出 · sends as ${deliveryMode === 'headless' ? 'a headless job' : 'a new official conversation'} in ${offset}${peakNote}`;
			};

			const body = box('div', {
				'data-hns-mega-new-task': 'on',
				// The dialog's width belongs to the surface, not to this block (see `ensureDialogStyles`): a
				// `max-width` here would only fight the box it is drawn in. What this owns is the padding and the
				// rule that its columns may shrink — a flex child without `minWidth: 0` refuses to, which is the
				// other half of a cramped form.
				style: { display: 'block', boxSizing: 'border-box', minWidth: 0, padding: '18px 20px 16px' }
			}, [
				// The title and the way out. The official modal's own chrome is skipped (`headless`) so the input
				// and its schedule are one block rather than two halves of a form.
				box('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '10px' } }, [
					text('新建定时任务', { flex: '1 1 auto', color: '#ffffff', font: font(15) }),
					text('New scheduled task', { color: FAINT, font: font(11, 400) })
				]),

				// --- the conversation input -------------------------------------------------------------
				box('div', {
					key: 'composer',
					style: {
						border: '1px solid rgba(255,255,255,.2)',
						borderRadius: '10px',
						background: 'rgba(255,255,255,.04)',
						padding: '8px 10px 6px'
					}
				}, [
					box('textarea', {
						key: 'prompt',
						'data-hns-mega-task-prompt': 'on',
						value: prompt,
						rows: 4,
						placeholder: '输入要执行的内容，和平时对话一样 · type what to run, just like a normal chat',
						onChange: (event) => setPrompt(event.target.value),
						onKeyDown,
						style: {
							all: 'initial',
							boxSizing: 'border-box',
							display: 'block',
							width: '100%',
							minHeight: '76px',
							maxHeight: '34vh',
							resize: 'vertical',
							border: 'none',
							background: 'transparent',
							color: '#ededed',
							font: font(13, 400),
							lineHeight: '1.5',
							outline: 'none'
						}
					}),
					box('div', { key: 'hint', style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } }, [
						text('Enter 发送 · Enter sends', { color: FAINT, font: font(10, 400) }),
						text('Shift+Enter 换行 · newline', { color: FAINT, font: font(10, 400) }),
						text(`${prompt.trim().length}`, { flex: '1 1 auto', textAlign: 'right', color: FAINT, font: font(10, 400) })
					])
				]),

				// --- the schedule, at the bottom of the input --------------------------------------------
				box('div', {
					key: 'schedule',
					'data-hns-mega-task-schedule': 'on',
					style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.12)' }
				}, [
					box('div', { key: 'title', style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '2px' } }, [
						text('定时设置', { color: MUTED, font: font(12) }),
						text('Schedule', { color: FAINT, font: font(10, 400) }),
						box('span', { key: 'tz', style: { flex: '1 1 auto', textAlign: 'right', color: FAINT, font: font(10, 400) } },
							timing?.schedule?.timeZone ? `时区 ${timing.schedule.timeZone}` : '')
					]),
					field('startAt', '发送时间', 'Send at', box('input', {
						key: 'input',
						'data-hns-mega-task-time': 'on',
						type: 'datetime-local',
						value: startAt,
						onChange: (event) => setStartAt(event.target.value),
						style: inputStyle
					})),
					// The shortcuts line up with the time field above them, which is what makes them read as shortcuts
					// *for that field* rather than as four more buttons.
					box('div', { key: 'presets', style: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: `4px 0 4px ${LABEL_COLUMN + 12}px` } }, [
						preset('3 分钟后 · in 3m', 3),
						preset('30 分钟后 · in 30m', 30),
						preset('1 小时后 · in 1h', 60),
						preset('明天 9:00 · tomorrow 9am', (() => {
							const at = new Date();
							at.setDate(at.getDate() + 1);
							at.setHours(9, 0, 0, 0);
							return Math.max(1, Math.round((at.getTime() - Date.now()) / 60_000));
						})())
					]),
					field('peak', '允许峰值', 'Allow peak hours',
						box('label', { key: 'wrap', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#ededed', font: font(12) } }, [
							box('input', {
								key: 'box',
								'data-hns-mega-task-peak': 'on',
								type: 'checkbox',
								checked: allowPeak,
								onChange: (event) => setAllowPeak(event.target.checked),
								// A native checkbox is a light-mode control; `appearance: none` plus the accent keeps it
								// from being the one bright rectangle in a dark dialog.
								style: {
									all: 'initial',
									appearance: 'none',
									width: '13px',
									height: '13px',
									borderRadius: '4px',
									border: '1px solid rgba(255,255,255,.35)',
									background: allowPeak ? TONES.busy : 'transparent',
									cursor: 'pointer'
								}
							}),
							text(allowPeak ? '峰价时段也执行' : '遇到峰价时段就挂起', { font: font(12, 400), color: MUTED })
						]),
						timing?.schedule?.peakPeriods?.length
							? `峰价时段 ${timing.schedule.peakPeriods.map((window) => `${window.start}-${window.end}`).join(', ')} · ${timing.schedule.timeZone || ''}`
							: null),
					deliveryMode === 'headless' ? field('delivery', '执行方式', 'Delivery',
						box('select', {
							key: 'select',
							value: deliveryMode,
							onChange: (event) => setDeliveryMode(event.target.value),
							style: inputStyle
						}, [
							box('option', { key: 'official', value: 'official-session' }, '官方新会话（和正常对话一样）'),
							box('option', { key: 'headless', value: 'headless' }, 'Headless 后台（无对话）')
						]),
						'这是 DS-Hns 默认的执行方式；「官方新会话」才会出现在左侧历史里。') : null,
					timingError ? box('div', { key: 'timing-error', style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' } }, [
						text(`读不到调度能力：${timingError}`, { flex: '1 1 auto', color: TONES.warn, font: font(11, 400), wordBreak: 'break-word' }),
						React.createElement(primitives.Button, { key: 'retry', variant: 'ghost', size: 'sm', onClick: loadTiming }, '重试 · Retry')
					]) : null
				]),

				// --- what will happen, and the two buttons ------------------------------------------------
				text(summary(), {
					key: 'summary',
					display: 'block',
					marginTop: '10px',
					color: instant !== null && !future ? TONES.warn : MUTED,
					font: font(11, 400),
					wordBreak: 'break-word'
				}),
				result ? text(
					`✓ 已加入队列 #${String(result.id || '').slice(0, 18)} · queued, status ${result.status || 'PENDING'}${result.startAtMs ? ` · ${new Date(result.startAtMs).toLocaleString()}` : ''}`,
					{ display: 'block', marginTop: '6px', color: TONES.ok, font: font(11, 400) }
				) : null,
				error ? text(`✖ ${error}`, { display: 'block', marginTop: '6px', color: TONES.bad, font: font(11, 400), wordBreak: 'break-word' }) : null,
				box('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' } }, [
					text('任务会进入左侧「手动队列」，到点后作为新会话发出 · the task waits in the manual queue and is sent as a new session when its time comes', {
						flex: '1 1 auto',
						color: FAINT,
						font: font(10, 400)
					}),
					React.createElement(primitives.Button, { key: 'cancel', variant: 'ghost', size: 'md', onClick: onClose }, '取消 · Cancel'),
					React.createElement(primitives.Button, {
						key: 'create',
						variant: 'primary',
						size: 'md',
						disabled: !canSubmit,
						loading: busy,
						onClick: send
					}, '创建定时任务 · Schedule')
				])
			].filter(Boolean));

			// The class goes on the official dialog box (see `ensureDialogStyles`): the component's own width is for
			// a one-field form, and this is a composer with a schedule under it.
			ensureDialogStyles();
			return React.createElement(primitives.Modal, {
				open: true,
				onClose,
				headless: true,
				className: DIALOG_CLASS,
				title: '新建定时任务',
				closeLabel: '关闭 · Close'
			}, body);
		}

		/**
		 * One entry point, two seats — the same dialog, opened from wherever the user already is.
		 *
		 * It is registered **both** in the official conversation header (beside the shipped schedule clock and jobs
		 * list) and inside this plugin's own floating ball. Two seats rather than two implementations: the form, the
		 * request it makes and the receipt it shows are the one component below, so the two cannot drift — and each
		 * is where a user would look for it, which is a conversation they have open or the ball that follows them
		 * around the desktop.
		 */
		function NewTaskAction({ compact }) {
			const [open, setOpen] = React.useState(false);
			if (!primitives) return null;
			const trigger = compact
				// Inside the ball's panel the label is the whole line, so it reads as the panel's primary action.
				? box('button', {
					key: 'trigger',
					type: 'button',
					'data-hns-mega-new-task': 'on',
					title: '新建定时任务 · New scheduled task',
					onClick: () => setOpen(true),
					style: {
						all: 'initial',
						display: 'block',
						width: '100%',
						boxSizing: 'border-box',
						padding: '6px 8px',
						marginBottom: '6px',
						borderRadius: '6px',
						border: `1px solid ${TONES.busy}`,
						background: 'rgba(88,166,255,.12)',
						color: '#ffffff',
						cursor: 'pointer',
						textAlign: 'center',
						font: font(12)
					}
				}, '＋ 新建定时任务 · New task')
				: React.createElement(primitives.Button, {
					key: 'trigger',
					variant: 'ghost',
					size: 'sm',
					icon: primitives.IconPlusOutline16 ? React.createElement(primitives.IconPlusOutline16, null) : undefined,
					title: '新建定时任务 · New scheduled task',
					onClick: () => setOpen(true)
				}, '新建任务 · New task');
			return box('span', { 'data-hns-mega-new-task-action': compact ? 'ball' : 'header', style: { display: 'block' } }, [
				trigger,
				React.createElement(NewTaskDialog, { key: 'dialog', open, onClose: () => setOpen(false) })
			]);
		}

		const inject = ['slots'];

		function apply(ctx) {
			// No React means no UI, and a plugin without its one dependency must still let the page boot.
			if (!React) return () => {};
			const store = createStore({});
			if (ctx && typeof ctx.effect === 'function') ctx.effect(() => store.start());
			if (ctx && ctx.slots) {
				/**
				 * The orb. `shell.overlay` is the official seat for a frame-wide floating surface, and the
				 * `order` only matters against other occupants, never against shipped UI (a list slot adds
				 * beside, it does not replace).
				 */
				ctx.slots.inject('shell.overlay', () => ctx.slots.register(
					{ name: 'shell.overlay', id: 'mega-orb', order: 100, label: 'Mega' },
					() => React.createElement(MegaOrb, { store })
				));
				/** The page. A fresh id, so this adds a section rather than taking one over. */
				ctx.slots.inject('settings.section', () => ctx.slots.register(
					{ name: 'settings.section', id: 'mega', order: 500, label: 'Mega' },
					(props) => React.createElement(MegaPage, { store, close: props && props.close })
				));
				/**
				 * The new-task entry, beside the official header actions. `order: 30` puts it after the jobs list and
				 * the schedule clock (both in the lower twenties) — the slot is a list, so the shipped entries are
				 * added beside and never displaced.
				 *
				 * It is here **and** in the ball's own panel (see `NewTaskAction`'s note): a conversation the user
				 * has open is one of the two places they look for "start something".
				 */
				ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
					{ name: 'conversation.session.header.actions', id: 'mega-new-task', order: 30, label: '新建任务 · New task' },
					() => React.createElement(NewTaskAction, null)
				));
			}
			return () => {};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
