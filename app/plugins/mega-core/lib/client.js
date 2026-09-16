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
 * What it draws now: **the Mega page**, as a first-level section of the official Settings (§4.4 — plugin
 * health, dependencies, version, capabilities, retries, fallback, last error, pending human dependency,
 * recovery actions, compatibility, update pin). §28's rule is that every entry that is not the ball goes
 * through the official Settings system, and that is where this one lives.
 *
 * **It does not draw a floating ball, and that is a decision rather than an omission.** The first version
 * registered one into the official `shell.overlay` slot; the second registered a system-level ball as well
 * (`app/extensions/mega/system-orb.cjs`), and the user's review of both was "现在有两个球，只要系统最外层那个".
 * Two balls showing one snapshot is two places to look and two things to keep in step; the one that survives
 * is the one that can be seen without the product window being in front — so the in-UI orb is gone and the
 * system ball keeps the job.
 *
 * What is left here is one surface and two habits:
 *
 *   1. **It renders what the shell says.** Every number, tone and label comes from `GET /mega-core/view`,
 *      which the host half composes from the governance snapshot DS-Hns answers with — the same view model
 *      the system ball renders. There is no second computation of governance in this file.
 *   2. **It does not run for nothing.** One poller at 15 s, stopped while the document is hidden and
 *      refreshed the moment it is shown again: a background tab that keeps asking DS-Hns for a snapshot is a
 *      background tab costing the machine something for a picture nobody is looking at.
 *
 * Everything is drawn with inline styles and `all: initial` on the card it sits on, because the official
 * settings column is frosted glass and our text has its own palette: the page brings its own opaque ground
 * rather than assuming one.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-mega-core',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// The loader seeds a frozen platform table (React among it). If a host ever lacks it, the plugin draws
		// nothing instead of breaking the page it was invited into — §29's failure-isolation rule, applied to
		// the one dependency this half cannot work without.
		let React = null;
		try {
			React = require('react');
		} catch {
			React = null;
		}

		const VIEW_URL = '/mega-core/view';
		const ACTION_URL = '/mega-core/action';

		/** §4.3's "low resource use", in one number. */
		const POLL_MS = 15000;

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
		 * The card the page is drawn on, and why it is opaque.
		 *
		 * A UI review found this page as **white text on the official frosted panel** — unreadable, and for a
		 * reason that is structural rather than cosmetic: our text has its own colours (the official theme's
		 * label colour is not ours to assume), while `all: initial` leaves our box with **no background at
		 * all**, so whatever the host paints behind it comes through. A surface with its own palette needs its
		 * own ground: one near-opaque card, and every piece of text sits on it.
		 */
		const CARD = {
			background: 'rgba(14,16,20,.97)',
			border: '1px solid rgba(255,255,255,.18)',
			borderRadius: '12px',
			boxShadow: '0 12px 32px rgba(0,0,0,.45)',
			color: '#ededed'
		};

		/**
		 * One poller, shared by every render of the page.
		 *
		 * A store rather than component state because the official UI may mount, unmount and re-mount the
		 * section as the user navigates: the answer is about the product, not about the panel showing it.
		 */
		function createStore({ fetchImpl, pollMs = POLL_MS, doc = typeof document !== 'undefined' ? document : null } = {}) {
			const send = fetchImpl || ((url, init) => window.fetch(url, init));
			let snapshot = { view: null, error: null, loading: true, action: null };
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

			/** The answer, fetched. Never throws: a failed poll is drawn as a reason, not as an empty page. */
			async function refresh() {
				try {
					const response = await send(VIEW_URL, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
					const body = await response.json();
					snapshot = {
						...snapshot,
						view: body && body.ok !== false ? body : null,
						error: body && body.ok === false ? (body.reason || 'the view could not be read') : null,
						loading: false
					};
				} catch (error) {
					snapshot = { ...snapshot, error: String(error?.message || error), loading: false };
				}
				emit();
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
				if (typeof setInterval === 'function') {
					timer = setInterval(() => {
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

			return { snapshot: () => snapshot, subscribe, start, refresh, act };
		}

		/** Subscribe a component to the store, with the two hooks every environment has. */
		function useStore(store) {
			const [snapshot, setSnapshot] = React.useState(store.snapshot());
			React.useEffect(() => store.subscribe(setSnapshot), [store]);
			return snapshot;
		}

		/** One inline-styled element. `all: initial` is the isolation: no official rule reaches inside. */
		function box(tag, props, children) {
			return React.createElement(tag, props, children);
		}

		function text(value, style) {
			return box('span', { style }, value);
		}

		/** A field row: the plan's two labels, a value, and the tone colour that makes a fault visible. */
		function FieldRow(field) {
			return box('div', { key: field.id, style: { display: 'flex', gap: '8px', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,.08)' } }, [
				box('div', { key: 'label', style: { flex: '0 0 150px', color: MUTED } }, [
					text(field.cn, { display: 'block', font: font(12) }),
					text(field.en, { display: 'block', font: font(10, 400), color: FAINT })
				]),
				text(field.value, { flex: '1 1 auto', color: field.tone ? TONES[field.tone] : '#ededed', font: font(12), wordBreak: 'break-word' })
			]);
		}

		/** A line of the page: faults first, positives after (both matter — see `view.js`). */
		function StatusLine(entry, index) {
			return box('div', { key: `${index}:${entry.text}`, style: { display: 'flex', gap: '6px', padding: '3px 0' } }, [
				box('span', { key: 'dot', style: { flex: '0 0 auto', color: TONES[entry.tone] || TONES.unknown } }, '•'),
				text(entry.text, { flex: '1 1 auto', color: entry.tone === 'ok' ? 'rgba(255,255,255,.72)' : '#ededed', font: font(12), wordBreak: 'break-word' })
			]);
		}

		/** A button that matches the page's own styling instead of the official one. */
		function ActionButton({ label, title, onClick, tone, key }) {
			return box('button', {
				key,
				type: 'button',
				title,
				onClick,
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

		/** A module or plugin row, with the actions its own state allows. */
		function Roster({ title, entries, mark, onAction }) {
			return box('div', { key: `roster:${title}`, style: { marginTop: '8px' } }, [
				text(title, { display: 'block', color: MUTED, marginBottom: '4px' }),
				...((entries || []).length
					? entries.map((entry) => box('div', { key: entry.id, style: { padding: '3px 0' } }, [
						text(mark(entry), { display: 'block', color: TONES[entry.tone] || '#ededed', fontWeight: '400', font: font(12) }),
						...(entry.actions || []).map((action) => React.createElement(ActionButton, {
							key: `${entry.id}:${action}`,
							label: action,
							onClick: () => onAction(action, entry.id)
						}))
					]))
					: [text('—', { color: MUTED })])
			]);
		}

		/**
		 * The governance body: the §4.2 lines, the numbers, the actions, and §4.4's fields.
		 *
		 * One component because it is one page: the whole of what Mega has to say, in the official Settings,
		 * from one snapshot.
		 */
		function MegaBody({ snapshot, onAction, onRefresh }) {
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

			const lines = (view.lines || []).map(StatusLine);
			const numbers = [
				['活动 · active', `${view.status?.active ?? 0}/${view.status?.total ?? 0}`],
				['待人工 · pending', String(view.status?.pending ?? 0)],
				['阻塞与重试 · failing', String(view.status?.failing ?? 0)],
				['更新于 · at', String(view.at || '—').slice(11, 19)]
			].map(([label, value]) => box('div', { key: label, style: { display: 'flex', gap: '6px', padding: '2px 0' } }, [
				text(label, { flex: '0 0 150px', color: MUTED }),
				text(value, { color: '#ededed', font: font(12) })
			]));

			const actions = (view.actions || []).map((action) => React.createElement(ActionButton, {
				key: `all:${action}`,
				label: action,
				title: `对全部有问题的模块执行 ${action}`,
				onClick: () => onAction(action, null)
			}));

			return box('div', { style: { color: '#ededed', font: font(12) } }, [
				header,
				box('div', { key: 'lines', style: { marginTop: '2px' } }, lines),
				box('div', { key: 'numbers', style: { marginTop: '6px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,.08)' } }, numbers),
				box('div', { key: 'actions', style: { marginTop: '6px' } }, [
					...actions,
					React.createElement(ActionButton, { key: 'refresh', label: '刷新 · Refresh', onClick: () => onRefresh() })
				]),
				snapshot.action ? text(
					snapshot.action.ok ? `✓ ${snapshot.action.action}${snapshot.action.id ? ` ${snapshot.action.id}` : ''}` : `✖ ${snapshot.action.reason || '操作被拒绝 · refused'}`,
					{ display: 'block', marginTop: '4px', color: snapshot.action.ok ? TONES.ok : TONES.bad, fontWeight: '400' }
				) : null,
				// §4.4's eleven fields — the governance vocabulary, in the order the plan lists it.
				box('div', { key: 'fields', style: { marginTop: '8px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,.08)' } }, (view.fields || []).map(FieldRow)),
				React.createElement(Roster, {
					key: 'modules',
					title: '模块 · Modules',
					entries: view.modules,
					mark: (entry) => `${entry.state === 'HEALTHY' ? '✓' : entry.state === 'FAILED' ? '✖' : '⚠'} ${entry.id} — ${entry.state}${entry.retries ? ` · ${entry.retries} retry` : ''}${entry.lastError ? ` · ${entry.lastError}` : ''}`,
					onAction
				}),
				React.createElement(Roster, {
					key: 'plugins',
					title: '社区插件 · Bundled plugins',
					entries: view.plugins,
					mark: (entry) => `${entry.state === 'installed' ? '✓' : '⚠'} ${entry.id} — ${entry.state}${entry.installedVersion ? ` @${entry.installedVersion}` : ''}${entry.expected ? ` · pin ${entry.expected}` : ''}${entry.channel ? ` · ${entry.channel}` : ''}${entry.tested ? ' · tested' : ''}`,
					onAction
				})
			].filter(Boolean));
		}

		/** The Mega settings page (§4.4). The official shell owns the modal; we own one section inside it. */
		function MegaPage({ store, close }) {
			const snapshot = useStore(store);
			return box('div', {
				'data-hns-mega-page': 'on',
				style: { all: 'initial', display: 'block', padding: '14px 16px', maxWidth: '760px', ...CARD, font: font(12) }
			}, [
				box('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } }, [
					text('Mega · DS-Hns 监督层', { flex: '1 1 auto', color: '#ffffff', font: font(14) }),
					typeof close === 'function' ? React.createElement(ActionButton, { key: 'close', label: '关闭 · Close', onClick: close }) : null
				].filter(Boolean)),
				React.createElement(MegaBody, {
					snapshot,
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
				 * The page, and nothing else. A fresh id, so this adds a section rather than taking one over —
				 * and the ball is *not* registered here: the one ball is the system one
				 * (`app/extensions/mega/system-orb.cjs`), which the user can see without this window being in
				 * front. Two balls showing one snapshot was the review's finding, not the goal.
				 */
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
