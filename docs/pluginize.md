# 插件化重构：施工记录（updateplan/pluginize.md）

本文件记录 `updateplan/pluginize.md` 的落地进度与证据。该工作书本身是本地施工文件（`updateplan/` 不入库），
所以这里写清"每个阶段做了什么、怎么验证、还差什么"。

**分支**：`plugin-ize`（从 `startup` 分出）。**推送节奏**：每完成一个大阶段推送一次（工作书 §30 的 Phase 1–8）。

## 人工 UI 复查标记（checkpoint 1）

**标记**：`manual-ui-review-1`（本轮的提交 + 注解标签）。**轮到你了**：应用当前还在运行，下面这些要重启之后才看得到。

复查清单（看完告诉我结果，或者直接说"继续"，我按下一条推进）：

1. **重启应用**（现在正在跑的那个实例没有加载新插件）。
2. **官方 UI 仍然正常**：这是最重要的一条 —— profile 里多了两个第三方客户端插件，如果它们出问题，官方界面会表现出来。
   回滚一条命令：`dsh plugin --profile web remove dsh-plugin-wallpaper-engine` / `… remove @dsh-market/plugin`
   （或 Dock 里 Control Center 的 Repair / 禁用入口）。
3. **壁纸插件**：官方界面里应出现它的背景与设置入口（它自己渲染桌面，我们的图层已让开）。
4. **市场插件**：官方界面侧栏应出现它的入口（浏览/搜索/一键安装）。据其 README，插件端不占 token。
5. **治理桥**：`logs/desktop-runtime.log` 里应有 `governance bridge listening on http://127.0.0.1:<port>`；
   Dock 的 Control Center → 诊断段应有一行"治理桥 / Mega 插件通道"，显示 `127.0.0.1:<port> · N req`。

每条要么"好"，要么把看到的现象写下来；`tested: false` 会在这轮复查确认后才翻成 `true`。

---

## Phase 1 — Mega 插件化（进行中）

目标（§4）：Mega 正式变成 Harness 插件 —— `Floating Orb` + `Mini Panel` + `Full Mega Page`，加上
**Plugin registry bridge** 与 **Protection bridge**；验收后删除旧的 Mega 独立 UI 壳。

### 已完成：治理桥（Plugin registry bridge + Protection bridge 的落地）

`app/core/governance-bridge.cjs`：Mega 插件将来跑在 **Harness 进程**里，与本产品的 Electron 主进程不是同一个进程，
所以两者之间需要一条通道，这就是它。

- **只监听回环**：构造时拒绝任何非 `127.0.0.1` 的 host（测试断言了这一点）。
- **每次启动一个新 token**：`crypto.randomBytes(32)`，与端口一起写进
  `data/state/governance-bridge.json`（Harness 子进程以 `DSH_HOME=<root>/data` 启动，所以插件的宿主端可以**从环境**
  找到它，而不是硬编码路径）；进程退出时删除该文件，token 不会活过它的进程。
- **读是快照，写是具名动作**：`GET /governance` 返回治理快照，`POST /action` 只接受 §22 允许的动作
  （`check` / `retry` / `reset-fallback` / `repair` / `disable` / `enable`），没有"调用任意函数"的面。
- **一条真相两个界面**：桥的 `snapshot()` 就是 `controlCenter()`、`act()` 就是 `controlAction()` ——
  与 Control Center 面板完全同一份数据与同一组动作，不重新拼一套。
- **它可以失败**：绑定不了就只写一行日志，产品照常运行，插件看到的是"治理不可用"。

测试：`tests/unit/governance-bridge.test.js` 6 项（回环与发现文件、token 每次不同、无 token 401 / 健康探针免 token、
闭集动作与"被拒绝的答案原样传回"、非回环拒绝与停止后删除 token、以及扩展侧"同一份数据与动作"的接线断言）。

### 还没做（Phase 1 其余部分）

- Mega Core Plugin 包本身（`package.json` 的 `dsh.bundle.patch` + `dsh.client`、`cordis.patch.yml`、宿主端与客户端）；
  契约已从**已安装的** `dsh-plugin-wallpaper-engine` 读出来（它的 `package.json` / `cordis.patch.yml` 就是权威样例：
  宿主端插一条 host row 并用同源 HTTP 路由给浏览器端供数、客户端经 `@deepseek-ai/dsh-client-runtime` 注入）。
- Floating Orb（拖动、位置持久化、边缘吸附、不抢焦点、不挡输入框、刷新后恢复）、Mini Panel、Full Page。
- 旧 Mega 独立 UI 壳的删除（必须在 Orb/Mini/Full 验收之后，见工作书 §30）。

### 已完成：Mega Core Plugin 包与宿主端

`app/plugins/mega-core/` —— 契约不是猜的，是从**已安装的** `dsh-plugin-wallpaper-engine` 读出来的（它的
`package.json`、`cordis.patch.yml`、`lib/index.js` 的 `inject = ['webServer']` + `webServer.register({kind:'exact',
path, handler})`、以及客户端半边的 `window.__ModuleLoader__.load({ id, factory })` 形式都是权威样例）。

包内容：`dsh.bundle.patch → cordis.patch.yml`（只 `insert` 一行 host row，绝不覆盖官方行）、`dsh.client`
（`platform: web`、`immediately: true`、注入 `@deepseek-ai/dsh-client-runtime`）、以及宿主端提供的三条**同源**路由：

| 路由 | 回答 |
| --- | --- |
| `GET /mega-core/health` | 插件是否在、以及 DS-Hns 的治理桥是否可达 |
| `GET /mega-core/governance` | Control Center 显示的那份快照（插件 / 保护层 / 启动 / 待人工项） |
| `POST /mega-core/action` | 具名动作：`check` / `retry` / `reset-fallback` / `repair` / `disable` / `enable` |

宿主端**不持有状态**：它每次请求都去读 DS-Hns 的治理桥（token 来自发现文件），所以插件不会缓存"健康"而在真实
降级后继续显示健康；DS-Hns 没在跑就如实回 `available: false` + 原因。`inject = ['webServer']` 是硬依赖（社区插件
的注释解释了原因：`ctx.get()` 在挂载期有竞态，会让路由被 SPA 回退悄悄吃掉）。

测试：`tests/unit/mega-core-plugin.test.js` 5 项（包与补丁的声明、三条路由挂载并在卸载时全部撤销、
对着**真实治理桥**代理（含 token、409 拒绝原样传回、405 方法拒绝）、DS-Hns 未运行时如实报不可用、
发现文件声称非回环 host 时拒绝）。

### 已完成：客户端半边 —— 悬浮球、迷你面板、整页（§4.2–§4.4）

`lib/client.js`，**装进哪个槽是读出来的，不是猜的**：官方客户端 runner 里带着一份**槽位目录**
（每个槽的 kind、owner、registerOptions、示例、源码路径），照它登记：

| 槽 | 内容 | 为什么是这个槽 |
| --- | --- | --- |
| `shell.overlay` | 悬浮球（含它的面板） | 官方对"整框浮动层"的定义：list 型（**加成**，不会顶掉官方条目），且这一层本身 **click-through**，占位者要自己 opt-in 指针事件——正是 §4.3 "不阻塞官方 UI"要的东西 |
| `settings.section` | Mega 整页 | §28："其余入口统一进官方 Settings 体系" |

三件事是**代码性质**而不是配置项，所以各有断言：

1. **不抢焦点**：没有任何 autofocus，且 `pointerdown` 上 `preventDefault()` —— 点一下球不会把焦点从输入框
   拽走；同时它仍是真 `<button>`，键盘用户照常可达（"可达"与"抢走"的区别就是这一行）。
2. **不空转**：整插件只有一个轮询器（15s），两个界面共用；文档 `hidden` 时不问，重新可见立刻问一次。
   后台标签页为一个没人看的画面反复请求 DS-Hns，是纯粹的开销。
3. **位置存在主机侧**（`GET/POST /mega-core/orb`，文件在 `$DSH_HOME/state`）**而不是 `localStorage`**：
   官方 UI 由 `--port 0` 回环地址提供，原点是每次重启都变的，`localStorage` 里的位置等于每次重启都丢。

**视图模型在宿主半边**（`lib/view.js` + `GET /mega-core/view`），不在浏览器里拼：哪个状态是什么色调、
§4.4 的十一个字段叫什么、"不可用"是什么意思，都是规则，规则放在能被 Node 测的地方 —— 顺带保证球和整页
**不可能各说一套**。"DS-Hns 没在跑"是**自己的状态**（灰色 `Unavailable` + 原因），不是一条静默的空列表：
那是这套东西最容易撒的谎。§7 Human Gate 还没落地，所以 `pending` 读的是快照里的 `pending` 键（现在不存在
→ 报 0，而 0 是真的：没有 gate 就没有东西在等人），gate 落地后不用改代码。

测试：`tests/unit/mega-core-view.test.js` 6 项（动作闭集与治理桥一致、降级在 status/hover/lines/字段四处一致、
干净就是干净、失败压过降级且 pending 进徽标、DS-Hns 不在时各字段仍可读并给出原因）、
`tests/unit/mega-core-client.test.js` 9 项（**按 shell 的方式加载**：`window.__ModuleLoader__` + 平台表里的
react，再驱动它 —— 两个槽的登记与描述符、§4.2 的 hover/徽标/色调、点击开面板且 `preventDefault`、
拖动到边缘吸附并**只写一次**位置、位置从主机读回、hidden 不轮询 + 可见即轮询、整页渲染 §4.4 且动作走
`/mega-core/action`、没有 React 时只画空气而不炸页面）。`mega-core-plugin.test.js` 5 项，新增组合视图与
orb 位置的路径（含非法值 400、错误方法 405）。

### 下一步（Phase 1 收尾）

1. 把插件装进产品自己的 profile（`dsh plugin --profile web add file:…/app/plugins/mega-core`），重启后
   真机看球：位置、拖动、边缘吸附、hover、迷你面板、Settings › Mega 整页、官方 UI 不受影响。
2. 这一轮标记为**人工 UI 复查**（同上一轮的做法：标签 + 文档 + 推送）。
3. 复查通过后再删除旧 Mega 独立 UI 壳（§30：验收在前）—— 那时顺带处理 Phase 7 剩下的
   "重复 market discovery UI / 旧 Mega feature pages"（它们长在旧壳里，先删等于在产品还没有新界面时把
   唯一界面拿掉）。

---

## 人工 UI 复查标记（checkpoint 2：悬浮球与整页）

**标记**：`manual-ui-review-2`（本轮的提交 + 注解标签）。**轮到你了**：插件已经装进产品的 profile，但
现在正在跑的那个实例是在安装之前启动的，所以下面这些要**重启之后**才看得到。

装进去的那一步（真机、可回滚）：

```text
DSH_HOME=D:\DS-Hns\data dsh plugin --profile web add file:D:/DS-Hns/app/plugins/mega-core
回滚：      … plugin --profile web remove dsh-plugin-mega-core
```

**已经实测过的部分（不是"等到重启才知道"）**：用一次性 `DSH_HOME` 起了一个 Harness，profile 里只有
基础 bundle + 本插件，结果是 —— 宿主半边挂载成功（`GET /mega-core/health` = 200，带插件版本 0.1.0）、
组合视图用**真实的治理快照**生成（`GET /mega-core/view` = 200，`4 of 7 plugin(s) active`，直接读的是
正在运行的 DS-Hns 的治理桥）、并且官方前端把我们的客户端半边**当成一个应用组合的一部分发出来了**
（`/plugins/??…dsh-plugin-mega-core/client.js…` = 200，内容里有 `__ModuleLoader__.load`）。一次性目录与
那个探测进程都已删除。

复查清单（看完告诉我结果，或者直接说"继续"）：

1. **重启应用**（必须：新插件是随 profile 在启动时加载的）。
2. **官方 UI 仍然正常**：这是最重要的一条。悬浮球是官方 `shell.overlay` 槽的一个占位者，槽本身是
   click-through 的，所以理论上它不该挡住任何东西 —— 请特别试一下**输入框能不能正常点/打字**、
   侧栏与对话滚动是否正常。
3. **球本身**：右下角出现一个 `●`（健康时绿色、降级黄色、失败红色、DS-Hns 没跑时灰色）。
   - 鼠标悬停应显示四行：`DS-Hns` / 状态 / `N of M plugin(s) active` / `N pending`。
   - **点一下**：面板打开，**焦点不应从输入框跑掉**（这正是 §4.3 那条 `preventDefault`）。
   - **拖动**：拖到左/右边缘会吸附；重启后应回到你放的位置（位置存在产品侧文件里，不在浏览器里）。
   - 键盘：Tab 能聚焦到球，方向键微调，Enter/空格开关面板，Esc 收起。
4. **整页**：官方设置里应多出一个 **Mega** 段（§4.4 的十一个字段：插件健康/依赖/版本/能力/重试/回退/
   最近错误/待人工/恢复动作/兼容性/版本钉），有问题的模块与插件各自带自己的动作按钮。
5. **不撒谎**：把 DS-Hns 主程序关掉再开球的面板，应该是**灰色 Unavailable + 原因**，而不是"Healthy"；
   再打开 DS-Hns，15 秒内应自动恢复成彩色。

每条要么"好"，要么把看到的现象写下来。**这一轮通过之后**才做 §30 的最后一步：删除旧 Mega 独立 UI 壳
（连同它的商店发现页）。

---

## Phase 7 — 去重（第一步：重复 wallpaper backend）

**这一条为什么能先做，而其余去重不能。** §30 把"旧 Mega feature pages / 重复 market discovery UI"的删除放在
**Phase 1 的 orb 验收之后**——商店标签页、旧功能页都长在旧的 Mega 壳里，先删它们等于在产品还没有新界面的
时候把唯一界面拿掉。而"重复 wallpaper backend"不长在壳里：它是**两个界面都在用的后端**，所以社区插件到位后
它可以独立地结清。`docs/startup.md` §3.10 记过它的条件（pin 标成 `tested: true`），这一轮条件达成：

### `tested: false → true`（两个 pin）

人工 UI 复查确认的是**真机事实**：两个插件装进产品自己的 profile 后重启，官方 Harness 界面正常（客户端插件坏掉
的表现就是官方页面被改坏，所以这是关键一条）；壁纸插件画出自己的背景；市场的入口出现；治理桥在回环上应答。
`tested` 因此翻成 `true`，含义不变——**在产品里跑过**。

它**不**声称 §23 的故障行逐条跑过：禁用 / 崩溃 / 坏配置 / 断网 / 版本不符 / 回滚属于保护层与管理器的策略路径，
断言在 `mega-protection.test.js`、`bundled-plugins.test.js`、`appearance-providers.test.js`。这一点写在
`plugins/index.cjs` 的清单注释里，以免半年后有人把 `tested` 读成"什么都测过了"。

### 删除的是什么

`WALLPAPER_KINDS` 现在只有 `image`；`.mp4/.webm/.m4v/.html/.htm` 从 MIME 表里删除，改为
`ADVANCED_EXTENSIONS` + `ADVANCED_REASON` 两样**用来拒绝**的东西：拒绝时**按名字**给出原因（"这是
`dsh-plugin-wallpaper-engine` 的活"），而不是把一个视频静默接受、再画到无处可画。

一起离开的还有它们各自的下游：`VIDEO_TARGETS` 导出、`muted`（唯一有播放器的一面才有意义的状态）、
`dockLayer()` 的 `file:` 源分支、Dock 文档里的 `<video id="wallpaperVideo">` 与它的 CSS 规则、
`wallpaper-layer.js` 里的 `play()/pause()` 可见性联动、以及 `describe()` 里那句"视频只在 Mega 里画"
的 `note`（句子换了主人：面板在选择文件的地方一次说清边界）。

选择框也随之改了：两个过滤器（图片 / "视频与网页壁纸（由壁纸插件负责）"），**故意**让后者可见——把扩展名藏
起来只会让人以为产品坏了，而挑到视频会看到那句拒绝理由。

### 断言

`tests/unit/wallpaper.test.js` 5 项：图片是唯一的 kind（`ADVANCED_EXTENSIONS` 逐个断言 `kindOf` 为 `null`
且 `isAdvanced` 为真）、拒绝时**状态文件不动**（旧壁纸留在原处）、两个表面都拒绝、以及**删除本身**被断言：
Dock 文档里没有 `<video>`、层脚本里没有 `wallpaperVideo` / `isVideo` / `muted` / `.play()`、后端里没有
`VIDEO_TARGETS` / `WALLPAPER_KINDS.video` / `file:` 源路径，`dockLayer().src` 是 inline `data:` 资源。
"只是没用到"的重复实现会在下一次需要视频时回来，所以断言的是它**不在**。

### 其余去重（仍未做，按 §30 的顺序排在 orb 之后）

`重复 market discovery UI`、`旧 Mega feature pages` 随旧壳一起走；`重复 TTS backend`、`重复 ordinary
schedule UI`、`重复普通 permission classifier` 要等对应的社区插件（notify-sound / dsh-automation /
dsh-auto-mode）接入并验收。§5.2 已定的方向不变：DS-Hns 自己的 Store 不删除，收敛为 **Plugin Governance**
（manifest 校验、exact pin、兼容性、回滚、安全禁用），发现与搜索交给市场插件。
