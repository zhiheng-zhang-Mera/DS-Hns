# Changelog

All notable changes to DS-Hns. Newest first. Each entry names the user-visible
behaviour that changed, not the files that were touched.

## computer-use — 完整 Computer Use 执行器（Update-Plan/computer-use.md）

**DS-Hns 现在能接收执行契约并在真实计算机上把任务做完，而且做完之后能证明。** 新增
`app/computer-use/` 运行时：统一 Action Executor、World State、Browser / Desktop /
Vision / Shell / File 控制器、瞬态稳定、动作验证、miss 检测、恢复阶梯、stall 检测、
能力路由、危险操作门控、执行日志，以及自主续跑（autonomyEnabled）。原则是
**Structure first, Events second, Vision only when necessary**：结构化状态优先，
视觉只在结构化信息无法定位目标时兜底。

* **统一动作层**：CLICK / TYPE / HOTKEY / SCROLL / DRAG / DOM_* / ACCESSIBILITY_* /
  BROWSER_* / SHELL_EXEC / FILE_* / SCREENSHOT_* 全部走同一个 Executor，上层无法绕过
  它直接生成 pyautogui 脚本；动作契约自带 precondition、stabilization、
  expected_effect、timeout_ms 与 retry，缺参动作在构建期就被拒绝。
* **目标解析阶梯**：DOM selector → accessibility node → semantic element → window →
  bbox → visual target → 坐标；点击前必须重新解析并比较位移（<3px 直接点、3–10px 用
  刷新后的坐标、>10px 重新观察），过期坐标永不使用。
* **瞬态稳定**：动作前 50–300ms settling（UI 仍在变化时按 +80ms 递进，上限
  400–500ms）、动作后 80–250ms grace、条件等待代替 sleep；超过冷却上限就转入
  WAIT_STATE 或重新观察，不会退化成 `sleep(2)`。动态冷却只看当前这一步的观测，
  不学习任何 App 延迟画像。
* **三态验证**：每个动作返回 success / failure / unknown；"脚本跑完了"不是完成，
  完成由执行契约的 success_criteria 判定，无法判定的条件永远不会被当成满足。
* **失败恢复**：retry（先重新验证目标）→ alternative interaction（鼠标点击失败转
  accessibility invoke / DOM click）→ replan → 有界失败；连续 3 次无实质变化判定
  stall，走结构化重观察 → 窗口检查 → 目标重解析 → 区域截图 → 换交互 → replan →
  全屏截图 → FAIL_WITH_CONTEXT，绝不无限重试。
* **感知与视觉**：浏览器经 CDP 读取 DOM / 可访问性树 / URL / 加载态 / 弹窗；桌面经
  user32 + UI Automation 读取窗口、前台与控件（UIA 跨进程且昂贵，因此按步按需读取，
  弹窗另外从窗口列表廉价识别）；截图分级 region → window → full，每级只在恢复时上升
  一格，全屏还需要契约许可。
* **画布场景真的靠视觉**：页内视觉目标用页面自身视口截图做颜色/模板匹配，再把设备像素
  → CSS 像素 → 屏幕像素换算后用真实 SendInput 点击（canvas 验收用例证明这条链路）。
* **安全门控**：意外弹窗暂停原动作、用它自己的控件关闭后再恢复；输入前验证焦点；
  键盘/点击前验证前台窗口，前台不明就拒绝点击；密码/token 永不进入日志；危险操作
  （删除/安装/发布/格式化等）由契约 allowed / confirm / forbidden 决定，`confirm`
  没有确认通道时是拒绝而不是默认同意。
* **故障隔离**：每个控制器独立异常边界，视觉控制器坏掉不影响浏览器与 Shell 任务，
  页面关闭不影响桌面任务；单个感知源超时只让世界状态降级，并在日志里说明原因。
* **执行日志**：逐步记录 action / target / channel / pre_state / stabilization_ms /
  grace / wait / result / verification / retry_count；截图只在 debug、audit、失败或
  显式请求时落盘，普通运行用完即弃。
* **真实驱动**：koffi FFI 直调 user32/kernel32（鼠标、Unicode 键盘、窗口、剪贴板），
  PowerShell 5.1 + UIAutomationClient 提供可重解析 `w:<hwnd>/0.3.2` 的自动化树，
  GDI（BitBlt/PrintWindow）截图，PNG 复用仓库自带编解码器；三者在 koffi 或
  PowerShell 缺失时都能优雅降级。
* **接线**：主进程持有运行时并注册 `computer-use:*` IPC（懒创建、退出时释放），
  Mega Dock 新增 **Computer Use** 面板（编辑契约、单步/执行、取消、控制器健康、实时
  状态机与步骤日志），preload 暴露 `megaComputerUse`，`config/app.json` 增加
  `computerUse` 配置块（默认关闭自主续跑，危险操作默认 confirm）。
* **验收**：`tests/unit/computer-use-*.test.js` 用真实状态机的进程内设备覆盖 §53 全部
  十个用例（可确定性复现）；`scripts/computer-use-acceptance.cjs` 在真机上跑同样十个
  用例（真实 Chromium + 真实桌面 + 真实输入），结果与限制记在
  `docs/computer-use-acceptance.md`；CI 增加 Computer Use surface gate，并把
  `computer-use` 加入 verify 工作流的分支触发列表。

## Theme-Cover — 双前端模式：Daily（HNS 原生界面）与 Work（官方界面）

### 真机验收后的修正（同一分支）

**Daily 重新做成 chat-first 工作台（Update-Plan/Daily-UX.md）。** 上一轮的固定三栏
「工作台」被判定为方向错误（三个常驻列 + 状态 chip 顶栏像监控面板），本轮以 `2479bf5` 为
逻辑基线撤回该 UX 层，保留 Dual UI runtime、主题图片修复、Work 全宽、Mega 模块折叠等正确
部分，并把 Daily 重做成 chat-first：

* Daily 恢复为默认启动前端（`DSH_FRONTEND_MODE=work` 可覆盖单次运行）；
* 布局为 会话侧栏（220–280px，可收起）+ 对话区（flex）+ 固定底部 Composer，对话区占绝对主体；
* 顶栏收缩到 Workspace / Model / 模式切换 / Settings，权限、任务数、后端状态等次要状态移入
  工具抽屉的 Context 标签，不再堆成 dashboard；
* Context Panel 改为**默认关闭的 Utility Drawer**：右侧按钮打开，`open` 以浮层覆盖对话
  （不压缩对话宽度），`pinned` 才参与布局，320–460px；
* 会话侧栏产品化：新建、搜索、运行中/最近/已归档分组、重命名（走 Harness `session/rename`）、
  删除（需确认）、当前会话高亮；
* Composer 支持多行、发送、停止与权限预设（与 Mega 共用同一个设置写入者）；
* 主题语义 Surface：`root / sidebar / conversation / composer / utility`（Mega 为 `mega`），
  主题针对稳定 surface 而不是 CSS class；
* 角色成为 Daily 原生图层（右下/右侧/悬浮/侧栏/背景五种锚点，可隐藏、可移动、可缩放，
  `pointer-events: none`，并置于对话区内所以永远不会压住 Composer）；主题没带角色图时用
  同一主题的人设头像顶上，而不是留一个空图层。

**Work Mode 的官方界面现在真的能用了。** 真机逐像素排查发现：切到 Work 时窗口内容与 Daily
几乎完全一致（官方界面根本没显示），把 Daily 视图移出窗口后又只剩一片空白。根因是官方 UI
原来是与 Daily 同尺寸的兄弟 `WebContentsView`，靠 `setVisible` 切换——这个构建里被隐藏的兄弟
视图仍会被绘制，而重新显示的视图会丢掉合成面。现在官方 Harness UI 改为**窗口自身的页面**
（`mainWindow.loadURL`），Daily 是覆盖其上的子视图，切到 Work 就是移除这个子视图、露出下面的
官方界面；官方页面从不重新加载，所以模式切换不丢会话。真机验证：Work 下窗口为浅色官方界面、
`official.inWindow=true` 且宽度为窗口内容宽度 1474px、子视图只有 1 个（Mega 轨道条）、页面
`visibilityState=visible` 且存在可编辑元素；20 次往返后官方文档身份与地址不变。

**Mega 默认收起全部模块。** Dock 的每个模块（Interface Mode / Appearance / Skills / 队列 /
硬件 / Sub-worker / 余额 / 拓展状态）默认折叠，选择按模块保存；收起栏的 `H`/`D` 模式切换
始终可用，所以收起模块不影响模式入口。

**主题的图片现在真的会出现。** 之前主题能完整应用却「只有配色变化」：主题包用
`assets/persona/banner.png` 这类包内相对路径声明图片，渲染器把它当 URL 去自己的文档里
找；生成器写出的 `var(--hns-asset-wallpaper)` 又落在期望 URL 的 slot 属性上；asset token
还以裸 data URI 写进 CSS，导致 `background-image: var(...)` 无效。新增
`theme/assets/resolver.js` 在绘制时统一解析（越界引用被拒绝、缺失文件回退到同角色 token
再回退到 `none`），`preview.toCssVariables()` 以 `url("…")` 输出 asset token，Native
Frontend 的壁纸 / 角色 / 装饰 / 人设图层再以主题变量兜底。真机验证：当前主题在 Daily 面
上有 4 个图层是真实图片（wallpaper、decoration、persona banner、persona avatar）。

**Work Mode 的官方 Web 界面恢复正常布局。** 官方 UI 在宽度不足时会隐藏自己的会话侧边栏，
而展开的 Mega 会占用 560px（窗口 1489px → 官方只剩 914px）。现在进入 Work Mode 时 Mega
自动收到轨道条，官方视图拿到 1426×884 的完整宽度；这是运行策略而不是偏好改写，Work 内
仍可手动展开，切回 Daily 会恢复用户原本的状态。

**每个大模块都可以折叠。** Dock 的 Interface Mode / Appearance / Skills / 手动队列 /
硬件自适应并行 / Sub-worker / 余额 / 拓展状态，以及 Native Frontend 的 Sessions 与
Activity，都有折叠按钮，状态按模块保存在本地。

**可配置的启动模式。** `DSH_FRONTEND_MODE=daily|work` 强制本次运行的启动前端，且不会改写
用户已保存的偏好（验收脚本与快捷方式使用）。

DS-Hns 现在有两个共享同一个 Harness backend 的前端，默认进入 Daily。切换只改变哪个
渲染器可见，两个渲染器从启动到退出一直存在，因此不会重启 Harness、不会取消任务、
不会丢失会话。

**Daily Mode 是 DS-Hns 自己的界面。** 新增 `app/native-ui/`（独立的 HTML/CSS/JS +
沙箱 preload）与 `app/frontend-mode/`（模式状态、状态机、HNS Model、兼容适配器、
同步、兼容性探针）。会话列表、创建/选择会话、对话时间线、用户与助手消息、工具与任务
结果、Composer、发送、停止、运行中状态、设置入口、错误显示都可用；它只读 HNS Model，
拿不到官方 DOM、官方 class 或官方选择器。

**Work Mode 是未经修改的官方界面。** 官方 Overlay 已退出主架构
（`DSH_OFFICIAL_OVERLAY=1` 才创建，默认不创建），官方渲染器之上不再有任何透明层，
点击、输入、滚动、菜单全部原样可用。官方渲染器依旧只被 resize 与导航，从不被注入
脚本或样式。

**主题、角色、皮肤迁移到 Daily。** 同一份主题 payload 现在同时下发给 Mega dock 和
Native Renderer：token 变成 CSS 变量，背景/角色/装饰进入各自的图层，且这些图层都是
`pointer-events: none`。Work Mode 只保留外围 shell，不做深度换肤。

**Mega 成为两种模式的控制中心。** 收起栏有一个按钮（`H` = Daily，`D` = Work），
展开面板有 `Interface Mode [Daily] [Work]` 选择器与模式说明；两者读同一份 shell
持有的状态，切换请求在飞行中会被禁用，不可能出现状态不一致。

**故障回退。** Native 渲染器崩溃、组件渲染失败或快照失败会保留 backend 并自动切回
Work Mode（`DAILY_DEGRADED`），不会重启 Harness、不会取消任务、不会删除会话。

**新版本兼容性探针。** 八项契约（routes / session / messages / tasks / events /
tool_events / settings / error_behavior）各自给出 `compatible` / `changed` /
`blocked`，产出 Compatibility Report；`nativeFrontend = blocked` 时不自动升级、保持
当前稳定版本、Work Mode 继续工作，并生成兼容修复任务。

已知限制：官方 Web UI 不提供 session 深链接，因此 Daily → Work 无法改写官方界面当前
显示的会话（并且禁止注入脚本去实现它）。切换本身仍保证会话、任务与 Harness 连续，
该限制会在切换告警与 `sync.officialNavigation()` 中如实报告。详见
`docs/dual-ui.md`。

## Theme-Cover — the theme system becomes a full visual theme generator

The theme engine could already restyle the HNS dock from a prompt, but it could
only change colours and parameters: the "official UI" was a read-only palette
hint, characters were abstract procedural avatars, and there was nowhere to put a
real figure or a skin. It now generates and places real visual assets on four
surfaces, and the official renderer is still never touched.

**Four surfaces instead of one dock.** `hns_native`, `official_shell`,
`official_overlay` and `official_renderer` are now a single model
(`app/extensions/mega/theme/surface.js`) with per-surface permissions: `full`,
`full`, `visual-only`, `protected`. Every writer goes through one gate
(`assertWritable`), and the protected renderer is refused for every write kind and
every asset kind — including from a hand-written or imported package whose own
surface plan claims a write into it.

**The official area is now themable without being modified.** The shell draws a
frame *behind* the official view (only its outer band is visible) and a
transparent overlay *above* it. Both are separate `WebContentsView`s owned by the
shell: no preload, no script, no CSS injected into the official renderer and no
access to its DOM. The overlay is created with `setIgnoreMouseEvents(true)` and
`focusable: false`, and its document has `pointer-events: none` and no focusable
element, so clicks, keys and scrolling keep going to the official UI. The overlay
tracks the official view's bounds exactly, and the acceptance run proves it by
dispatching real input through the overlay's own area and asking the official
renderer whether it arrived.

**Real assets, not just colours.** A split asset pipeline — planner, generator,
processor, validator, fallback — produces characters in five framings (avatar,
bust, half body, full body, silhouette), an official skin, an overlay texture,
HUD and frame decorations, and a wallpaper, all with genuine transparency where
it is required. The generator calls an image capability when one is configured,
retries, then falls back to the procedural renderer, then disables that one asset;
a theme whose image generation fails completely still installs. Every produced
artifact is decoded and measured — real dimensions, real alpha, real visible
content — so an empty or flat buffer cannot pass as an asset.

**Design is observation-driven.** A prompt no longer goes straight to a theme: the
engine observes the HNS/Dock/Official bounds, the window size, the live slot
geometry, the available character regions and the critical interaction regions,
and only then produces a surface plan, an overlay plan and an asset plan. Each
plan is compiled into the package, so an approved theme documents what it writes,
where every asset came from and what the validator measured.

**The overlay cannot make the official UI unusable.** An Overlay Layout Engine
places the character and decorations against the safe region (viewport minus the
critical regions: input, send, core body, primary controls), and an Overlay Safety
validator enforces the engineering ceilings numerically — overlay opacity 0.22,
vignette 0.15, scanline 0.05, character coverage 22%, critical overlap 8% — plus
brightness, contrast loss, asset size and layout overflow. Over-strength designs
are downgraded and the character is shrunk; if no allowed strength can clear a
critical region, the overlay is disabled and the theme still installs.

**Preview and revision.** Approving still installs, and nothing installs before
it: the package now carries an HNS preview, an official shell preview, an official
overlay preview and a composite preview, and the panel shows all four. A
revision is scoped rather than a re-roll — "人物小一点" keeps the wallpaper, the
official skin and the texture byte-for-byte and only regenerates the character,
which the acceptance run verifies by comparing hashes. Deleting a theme leaves no
overlay, no character and no cache reference behind.

Also fixed while building this:

- `inspector.buildSnapshotPackage()` wrote `pages[].screenshot` from the raw
  screenshot **buffer** map, so the snapshot JSON contained a mojibake "path"
  built from binary instead of `snapshot/<page>.png`. The per-page field now uses
  the same file map the package publishes.
- `color.flatten()` returned `null` channels for an already-parsed
  `{r,g,b,a}` colour, so `shade()`/`toHex()` produced `#NaNNaNNaN` for every
  parsed palette colour and the panel, decoration and official-skin renderers
  silently fell back to a flat grey. `flatten`/`toHex` now normalise both a CSS
  string and a parsed colour.
- The asset renderers called `color.toHex(color.shade(...))`, double-converting an
  already-hex value into `#NaNNaNNaN`; they now use one correct helper.
- A character asset's planned height came from the HNS character's aspect ratio
  for every surface, so an official bust was planned at the wrong height.

## merging — GitHub CI gate repaired

The repository's `verify` workflow (Windows, Node 22) failed on every push. Two
independent causes, both real product bugs rather than CI configuration:

- **The balance module could strand a refresh on a hanging provider.** The
  per-provider deadline timer was created with `unref()`, so it did nothing to
  keep the event loop alive. When a provider never answered and the wait for it
  was the only pending work, the process could exit with the timeout still
  unsettled — Node reports that as *"Promise resolution is still pending but the
  event loop has already resolved"*. The timer is now referenced, so the race
  always settles within the provider deadline; the shell's explicit exit paths
  still decide when DS-Harness goes away.
- **A sub-worker teardown could wait out its whole timeout.** `stop()` polled the
  pool for a drain with `unref()`-ed timers while the supervisor tick could still
  respawn a worker (or while the worker's own `exit` event had simply not been
  observed yet), so it either polled for the full 5 s or never settled at all.
  The pool now notifies waiters when a worker exits, `stop()` latches the pool as
  stopping before it waits, and `tick()` refuses to act during a teardown — the
  drain completes in milliseconds, and the timeout remains only as a safety net.

The tests are also repaired, so the gate measures the product rather than the
machine:

- `tests/unit/multi-supervisor.test.js` had a missing `})`: everything from the
  integration test down was parsed as a nested subtest of the pressure test,
  which is why Node 22 reported them cancelled. The file now parses as 13 tests.
- The same file pins a synthetic hardware profile in its rig, so the pool ceiling
  is no longer 1 on a 2-vCPU CI runner; the ceiling *derivation* against real and
  synthetic facts stays covered by `multi-profiler.test.js`.
- The workflow documentation now states why the Node version is pinned instead of
  floating (the suite is verified on 22 and 24).

## merging — Sub-worker execution layer merged in

`merging` now carries every line of development that is not `main`:
the Sub-worker / adaptive multi-worker layer (`Sub-worker`), on top of the theme,
skills, updater and acceptance work that `UI-theme`, `auto-update` and `skills`
had already contributed. Nothing was dropped: the whole merge was resolved by
keeping both features where they collided, and the merged tree passes the syntax
gate, the unit/architecture suite, the real Electron acceptance and the
Sub-worker's own end-to-end acceptance.

Fixed while integrating (both features were individually correct, only the
combination was not):

- The Sub-worker **Live View** push read `dockWindow.webContents` directly, so the
  integrated dock never received it and the "no direct dockWindow reads"
  architecture check failed. It now goes through the dock target adapter.
- `scripts/sub-worker-acceptance.cjs` copied `app/` recursively and hit `EPERM` on
  the `node_modules` link; it now skips `node_modules` and `data` (it links the
  dependency tree and starts from a fresh data directory anyway), and it copies the
  repository-level `assets/` too — without the tray icon its scratch shell ran in a
  degraded state that has nothing to do with what those scenarios verify.
- Its integration-merge check waited for the integration worktree *directory*
  while the merged files land a moment later, which made it flaky. It now waits
  for the files themselves.
- `scripts/verify.ps1` and the Sub-worker regression test asserted the old
  `HARNESS_PORT` expression; both now assert the shipped
  `normalizeHarnessPort()` / `DSH_LAUNCH_ARGS` behaviour.

## merging — stabilization pass

Fixes the confirmed design and implementation gaps on `merging` before it can be
merged to `main`. No new user-facing features; the theme, dock, updater, skills
and acceptance surfaces are made to actually close their loops.

### Self-update rollback (P0)

- **Upgrade and rollback are now two operations.** The rollback no longer reuses
  the upgrade command, so it can never re-install the version that just failed:
  it restores `app/package.json` and `app/package-lock.json` and runs
  `npm ci --no-audit --no-fund` (falling back to a plain `npm install` only when
  there is no lockfile to restore — and never with the target version).
- **The previous installation is identified from disk.**
  `app/node_modules/@deepseek-ai/dsh/package.json` decides what "the old version"
  is; the manifest pin is only a fallback. Every update records a transaction
  (`fromVersion`, `targetVersion`, `installedVersion`, manifests, `startedAt`).
- **Three outcomes instead of two.** `data/state/mega-update.json` now reports
  `succeeded`, `failed_rolled_back` or `failed_rollback_failed`, with the rollback
  result and its error code. The dock shows a distinct, high-visibility
  "回滚未完成，当前安装可能已损坏" state instead of a generic update failure.
- **Verification is real.** The upgrade is verified by installed version, CLI
  entry *and* a `node lib/bin.js --help` boot check; the rollback is verified by
  the restored version.

### Integrated Dock target adapter (P1)

- New `app/extensions/mega/dock/target.js`: one adapter
  (`getWebContents`, `getBounds`, `getSize`, `getVisible`, `capturePage`, `send`,
  `getState`) over the integrated `WebContentsView` and the legacy companion
  `BrowserWindow`. Theme repaint, change pushes, skills pushes, region probes and
  screenshots all go through it; the extension no longer reads `dockWindow` for
  any of them.
- The shell hands the extension a `dockAdapter` instead of a bare webContents, and
  reports dock-ready through `ctx.onDockReady`, which closes the boot gap where
  the first theme paint had no target yet (the view is created after extensions
  start). The callback is re-run when the dock renderer reloads.
- Dock state now carries `mode` (`integrated` / `window` / `detached`) and real
  view geometry, so the theme system never has to infer the UI from a null window.
- Dock toggles push their layout decision to the shell, so the reserved strip is
  actually re-laid out when the dock expands or collapses.

### Theme visual observation (P1)

- New `app/extensions/mega/theme/visual-artifact.js` validates captures: PNG
  signature, IHDR dimensions, and a size floor scaled to the image. A returned
  buffer that is not a usable image is rejected, not counted.
- The snapshot package now records `visual`, `degraded`, `visual_expected`,
  `visual_reason`, `capture_problems` and per-file verdicts. A structure-only
  design is still allowed, but it can no longer be silent: the theme create
  result, the log and the acceptance run all see the degraded state and its
  reason.
- `snapshot.screenshots` is now a page → file-name map (the previous shape mixed
  buffers into the package and broke persistence).
- The live slot-geometry probe is actually invoked before an observation, so the
  observer gets real bounding boxes instead of the last pushed cache.

### Acceptance and tests (P1)

- Acceptance asserts the visual observation: `snapshot.visual === true`,
  `degraded === false`, a real PNG per claimed file (>5 KB, valid header,
  non-zero dimensions), observed slot count > 0 with real bounding boxes, and the
  updater rollback suite. The report now carries `commit`, `branch`, `warnings`
  and per-`modules` counts.
- New tests: `dock-target` (integrated and legacy backends, destroyed targets,
  throwing adapters), `theme-visual-observation` (real capture, empty capture,
  junk buffer, capture exception, allowed degradations),
  `theme-model-adapter`, `encoding-integrity` (guards against a lossy
  encode/decode round-trip), and the rewritten `update-runner` A–E suite whose npm
  stub really rewrites `package.json` on `--save-exact`.
- `npm run check` is now `scripts/check-syntax.cjs`, which checks every shipped
  source file instead of a hand-maintained command list.

### Tooling

- `.github/workflows/verify.yml` runs the syntax gate and the test suite on
  Windows and Linux for pushes and pull requests to `main` and `merging`.
- `scripts/verify.ps1` gained architecture checks for the dock adapter, the
  absence of direct `dockWindow` reads, the split upgrade/rollback operations and
  the distinct rollback outcomes.
- Optional `app/extensions/mega/theme/model-adapter.js` prepares the AI designer
  layer: disabled by default, always falling back to the deterministic
  interpreter, reported in the theme status.
