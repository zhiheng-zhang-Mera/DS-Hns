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

		const VIEW_URL = '/mega-core/view';
		const ACTION_URL = '/mega-core/action';
		const ORB_URL = '/mega-core/orb';

		/** §4.3: low resource use, in one number. */
		const POLL_MS = 15000;
		/** The orb's box, in px. Small on purpose: it is a status light, not a widget. */
		const ORB_SIZE = 40;
		/** How far from the window's edge the orb stops. */
		const MARGIN = 14;
		/** Drag it within this distance of an edge and it snaps there and follows it on resize. */
		const EDGE_SNAP = 56;
		/** Keyboard nudge, so the orb is movable without a pointer. */
		const KEY_STEP = 12;

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
		const MUTED = 'rgba(255,255,255,.5)';
		/** Quieter still: a label's English half, a hint. */
		const FAINT = 'rgba(255,255,255,.42)';

		function clamp(value, low, high) {
			if (high < low) return low;
			return Math.min(high, Math.max(low, value));
		}

		function viewportSize() {
			const width = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
			const height = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
			return { width, height };
		}

		/**
		 * Where the orb goes, from the stored position and the window — one function, because three callers
		 * (first paint, a resize, a drag) must not each have their own idea of "the default corner".
		 */
		function resolvePosition(stored, viewport) {
			const maxX = Math.max(MARGIN, viewport.width - ORB_SIZE - MARGIN);
			const maxY = Math.max(MARGIN, viewport.height - ORB_SIZE - MARGIN);
			if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
				// A position snapped to an edge follows that edge: the window gets narrower, the orb moves
				// with it, instead of ending up half off-screen where the user left it on a wider window.
				const x = stored.edge === 'right' ? maxX : clamp(stored.x, MARGIN, maxX);
				return { x, y: clamp(stored.y, MARGIN, maxY), edge: stored.edge || null };
			}
			// §4.3: default bottom-right, which is the corner the composer does not use.
			return { x: maxX, y: maxY, edge: 'right' };
		}

		/** Snap a dragged orb to the nearer edge when it is close enough, or leave it where it is. */
		function snapToEdge(position, viewport) {
			const maxX = Math.max(MARGIN, viewport.width - ORB_SIZE - MARGIN);
			const y = clamp(position.y, MARGIN, Math.max(MARGIN, viewport.height - ORB_SIZE - MARGIN));
			if (position.x <= EDGE_SNAP) return { x: MARGIN, y, edge: 'left' };
			if (position.x >= maxX - EDGE_SNAP) return { x: maxX, y, edge: 'right' };
			return { x: clamp(position.x, MARGIN, maxX), y, edge: null };
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

			return { snapshot: () => snapshot, subscribe, start, refresh, loadPosition, setPosition, savePosition, act };
		}

		/** Subscribe a component to the store, with the two hooks every environment has. */
		function useStore(store) {
			const [snapshot, setSnapshot] = React.useState(store.snapshot());
			React.useEffect(() => store.subscribe(setSnapshot), [store]);
			return snapshot;
		}

		/** The window's size, re-read when it changes, so an edge-snapped orb follows a resize. */
		function useViewport() {
			const [size, setSize] = React.useState(viewportSize());
			React.useEffect(() => {
				if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
				const onResize = () => setSize(viewportSize());
				window.addEventListener('resize', onResize);
				return () => window.removeEventListener('resize', onResize);
			}, []);
			return size;
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
				text(field.value, { flex: '1 1 auto', color: field.tone ? TONES[field.tone] : '#e6e6e6', font: font(12), wordBreak: 'break-word' })
			]);
		}

		/** A line of the panel's list: faults first, positives after (both matter — see `view.js`). */
		function StatusLine(entry, index) {
			return box('div', { key: `${index}:${entry.text}`, style: { display: 'flex', gap: '6px', padding: '3px 0' } }, [
				box('span', { key: 'dot', style: { flex: '0 0 auto', color: TONES[entry.tone] || TONES.unknown } }, '•'),
				text(entry.text, { flex: '1 1 auto', color: entry.tone === 'ok' ? 'rgba(255,255,255,.72)' : '#e6e6e6', font: font(12), wordBreak: 'break-word' })
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
					color: tone ? TONES[tone] : '#e6e6e6',
					background: 'rgba(255,255,255,.04)',
					cursor: 'pointer',
					font: font(12)
				}
			}, label);
		}

		/**
		 * The governance body: the lines, the fields, the rosters and the actions — §4.2's expanded panel and
		 * §4.4's page are the same body at two sizes, which is why they are one component.
		 */
		function MegaBody({ snapshot, onAction, onRefresh, expanded, onToggleExpanded }) {
			const view = snapshot?.view;
			if (!view) {
				return box('div', { style: { padding: '8px 0', color: '#e6e6e6', font: font(12) } }, [
					text(snapshot?.loading ? '正在连接 DS-Hns… · connecting' : 'DS-Hns 没有应答 · no answer from DS-Hns', { display: 'block' }),
					snapshot?.error ? text(snapshot.error, { display: 'block', marginTop: '4px', color: TONES.warn, fontWeight: '400' }) : null
				].filter(Boolean));
			}

			const attention = Number(view.status?.attention || 0);
			const header = box('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '8px', paddingBottom: '6px' } }, [
				box('span', { key: 'dot', style: { color: TONES[view.status?.tone] || TONES.unknown, fontSize: '14px' } }, '●'),
				text(view.status?.label || '—', { flex: '1 1 auto', color: '#f5f5f5', font: font(13) }),
				text(attention ? `${attention} 项需处理 · to look at` : '无异常 · nothing to look at', { color: attention ? TONES.warn : MUTED, font: font(10, 400) })
			]);

			const lines = (view.lines || []).map(StatusLine);
			const numbers = [
				['活动 / active', `${view.status?.active ?? 0}/${view.status?.total ?? 0}`],
				['待人工 / pending', String(view.status?.pending ?? 0)],
				['阻塞与重试 / failing', String(view.status?.failing ?? 0)],
				['更新于 / at', String(view.at || '—').slice(11, 19)]
			].map(([label, value]) => box('div', { key: label, style: { display: 'flex', gap: '6px', padding: '2px 0' } }, [
				text(label, { flex: '0 0 132px', color: MUTED }),
				text(value, { color: '#e6e6e6', font: font(12) })
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
							text(`${entry.state === 'HEALTHY' ? '✓' : entry.state === 'FAILED' ? '✖' : '⚠'} ${entry.id} — ${entry.state}${entry.retries ? ` · ${entry.retries} retry` : ''}${entry.lastError ? ` · ${entry.lastError}` : ''}`, { display: 'block', color: TONES[entry.tone] || '#e6e6e6', fontWeight: '400' }),
							...(entry.actions || []).map((action) => React.createElement(ActionButton, { key: `m:${entry.id}:${action}`, label: action, onClick: () => onAction(action, entry.id) }))
						]))
						: [text('—', { color: MUTED })]),
					text('社区插件 · Bundled plugins', { display: 'block', marginTop: '6px', color: 'rgba(255,255,255,.62)', marginBottom: '4px' }),
					...((view.plugins || []).length
						? view.plugins.map((entry) => box('div', { key: `p:${entry.id}`, style: { padding: '3px 0' } }, [
							text(`${entry.state === 'installed' ? '✓' : '⚠'} ${entry.id} — ${entry.state}${entry.installedVersion ? ` @${entry.installedVersion}` : ''}${entry.expected ? ` · pin ${entry.expected}` : ''}${entry.channel ? ` · ${entry.channel}` : ''}${entry.tested ? ' · tested' : ''}`, { display: 'block', color: TONES[entry.tone] || '#e6e6e6', fontWeight: '400' }),
							...(entry.actions || []).map((action) => React.createElement(ActionButton, { key: `p:${entry.id}:${action}`, label: action, onClick: () => onAction(action, entry.id) }))
						]))
						: [text('—', { color: MUTED })])
				])
			]) : null;

			return box('div', { style: { color: '#e6e6e6', font: font(12) } }, [
				header,
				box('div', { key: 'lines', style: { marginTop: '2px' } }, lines),
				box('div', { key: 'numbers', style: { marginTop: '6px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,.08)' } }, numbers),
				box('div', { key: 'actions', style: { marginTop: '6px' } }, [
					...actions,
					React.createElement(ActionButton, { key: 'refresh', label: '刷新 · Refresh', onClick: () => onRefresh() }),
					onToggleExpanded ? React.createElement(ActionButton, { key: 'expand', label: expanded ? '收起 · Collapse' : '详情 · Full page', onClick: () => onToggleExpanded(!expanded) }) : null
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
				text('完整页面也在 官方 Settings › Mega · the full page is also in Settings › Mega', { display: 'block', marginTop: '6px', color: FAINT, font: font(10, 400) }),
				detail
			].filter(Boolean));
		}

		/** The orb, its drag and its panel (§4.1-§4.3). */
		function MegaOrb({ store }) {
			const snapshot = useStore(store);
			const viewport = useViewport();
			const [open, setOpen] = React.useState(false);
			const [expanded, setExpanded] = React.useState(false);
			const drag = React.useRef(null);
			const position = resolvePosition(snapshot.position, viewport);
			const tone = TONES[snapshot.view?.status?.tone] || TONES.unknown;
			const label = orbLabel(snapshot.view);
			const hover = snapshot.view?.hover || ['DS-Hns'];

			function onPointerDown(event) {
				// Rule 1: a click must not pull focus out of the composer. `preventDefault` on pointerdown is
				// what makes that true while keeping the button in the tab order.
				if (event && typeof event.preventDefault === 'function') event.preventDefault();
				if (event && event.button !== undefined && event.button !== 0) return;
				drag.current = { dx: event.clientX - position.x, dy: event.clientY - position.y, moved: false, x: position.x, y: position.y };
				if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
					try {
						event.currentTarget.setPointerCapture(event.pointerId);
					} catch { /* capture is an optimisation; pointermove still arrives */ }
				}
			}

			function onPointerMove(event) {
				const current = drag.current;
				if (!current) return;
				const next = {
					x: clamp(event.clientX - current.dx, MARGIN, Math.max(MARGIN, viewport.width - ORB_SIZE - MARGIN)),
					y: clamp(event.clientY - current.dy, MARGIN, Math.max(MARGIN, viewport.height - ORB_SIZE - MARGIN)),
					edge: null
				};
				current.moved = true;
				current.x = next.x;
				current.y = next.y;
				store.setPosition(next);
			}

			function onPointerUp() {
				const current = drag.current;
				drag.current = null;
				if (!current) return;
				const snapped = snapToEdge({ x: current.x, y: current.y }, viewport);
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
				const moved = snapToEdge({ x: position.x + delta[0], y: position.y + delta[1] }, viewport);
				store.savePosition(moved);
			}

			const orb = box('button', {
				type: 'button',
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
					position: 'fixed',
					left: `${position.x}px`,
					top: `${position.y}px`,
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

			if (!open) return orb;

			const panelWidth = 320;
			const onRight = position.x + ORB_SIZE / 2 > viewport.width / 2;
			const left = onRight ? Math.max(8, position.x - panelWidth - 10) : Math.min(viewport.width - panelWidth - 8, position.x + ORB_SIZE + 10);
			const top = clamp(position.y + ORB_SIZE - 260, 8, Math.max(8, viewport.height - 120));
			const panel = box('div', {
				'data-hns-mega-panel': 'on',
				role: 'dialog',
				'aria-label': 'Mega',
				style: {
					all: 'initial',
					position: 'fixed',
					left: `${Math.round(left)}px`,
					top: `${Math.round(top)}px`,
					width: `${panelWidth}px`,
					maxHeight: '70vh',
					overflow: 'auto',
					padding: '10px 12px',
					borderRadius: '10px',
					border: '1px solid rgba(255,255,255,.16)',
					background: 'rgba(16,18,22,.96)',
					boxShadow: '0 10px 30px rgba(0,0,0,.45)',
					pointerEvents: 'auto',
					zIndex: 2147483000,
					color: '#e6e6e6',
					font: font(12)
				}
			}, [
				box('div', { key: 'title', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } }, [
					text('Mega', { flex: '1 1 auto', color: '#f5f5f5', font: font(14) }),
					React.createElement(ActionButton, { key: 'close', label: '×', title: '收起 · Collapse', onClick: () => setOpen(false) })
				]),
				React.createElement(MegaBody, {
					snapshot,
					expanded,
					onToggleExpanded: setExpanded,
					onRefresh: () => store.refresh(),
					onAction: (action, id) => store.act(action, id)
				})
			]);

			// The orb and its panel are siblings, so the panel can never be clipped by the orb's own box.
			return box('div', { key: 'mega-orb-stack', style: { pointerEvents: 'none' } }, [orb, panel]);
		}

		/** The Mega settings page (§4.4). The official shell owns the modal; we own one section inside it. */
		function MegaPage({ store, close }) {
			const snapshot = useStore(store);
			return box('div', {
				'data-hns-mega-page': 'on',
				style: { all: 'initial', display: 'block', padding: '4px 0', maxWidth: '720px', color: '#e6e6e6', font: font(12) }
			}, [
				box('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } }, [
					text('Mega · DS-Hns 监督层', { flex: '1 1 auto', color: '#f5f5f5', font: font(14) }),
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
			}
			return () => {};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
