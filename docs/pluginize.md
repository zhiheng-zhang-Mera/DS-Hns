# 插件化重构：施工记录（updateplan/pluginize.md）

本文件记录 `updateplan/pluginize.md` 的落地进度与证据。该工作书本身是本地施工文件（`updateplan/` 不入库），
所以这里写清"每个阶段做了什么、怎么验证、还差什么"。

**分支**：`plugin-ize`（从 `startup` 分出）。**推送节奏**：每完成一个大阶段推送一次（工作书 §30 的 Phase 1–8）。

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
