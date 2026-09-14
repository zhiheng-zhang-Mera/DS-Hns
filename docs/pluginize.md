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

### 下一步（Phase 1 剩余）

1. 客户端半边 `lib/client.js`：`window.__ModuleLoader__.load({ id, factory })` + `apply/inject`，画
   Floating Orb（拖动、位置持久化、边缘吸附、不抢焦点、不挡输入框、刷新后恢复）、Mini Panel（§4.2 的
   hover/展开内容）与 Full Page（§4.4 列出的治理字段）。
2. 全链路验收（orb 可用、官方 UI 不受影响、治理数据正确）。
3. 验收通过后再删除旧 Mega 独立 UI 壳（§30：验收在前）。
