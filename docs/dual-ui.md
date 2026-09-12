# 双前端模式（Daily / Work）实施与验收记录

本文件记录 `Update-Plan/Dual-UI.md` 在 `Theme-Cover` 分支上的实施结果：新增了什么、
验收 Gates 各自如何被验证、以及哪些部分需要真实 Electron 运行才能最终确认。

## 1. 最终结构

```text
DS-Hns Main Window
│
├── official_renderer   WebContentsView  ← 官方 @deepseek-ai/dsh Web UI（Work Mode）
├── native_renderer     WebContentsView  ← HNS Native Frontend（Daily Mode，默认）
├── official_shell      WebContentsView  ← 官方外围边框（仅外圈可见、不可交互）
└── hns_native dock     WebContentsView  ← Mega 控制中心（右侧收起/展开）
```

两个前端**只在可见性 / 层级上切换**，两个 `WebContentsView` 从创建到退出一直存在：

```text
Daily:  native visible + official hidden
Work:   official visible + native hidden
```

同一个 Harness Backend 全程服务两者，切换不重启 Harness、不取消任务、不丢失会话。

## 2. 代码结构

| 目录/文件 | 职责 | 计划任务 |
| --- | --- | --- |
| `app/frontend-mode/state.cjs` | 模式持久化（`data/state/frontend-mode.json`）、每模式会话记忆 | 任务 2 |
| `app/frontend-mode/manager.cjs` | 模式状态机、渲染器可见性、失败回退 | 任务 3 / 15 / 20 |
| `app/frontend-mode/model.cjs` | 统一 HNS Model（Session / Message / ToolEvent / Task / ComposerState / BackendState / SettingsState） | 任务 9 |
| `app/frontend-mode/backend.cjs` | Harness 后端桥（unary RPC + 持久化 journal） | 任务 8（边界层） |
| `app/frontend-mode/adapter.cjs` | Backend → HNS Model 归一化；probe 数据源 | 任务 8 |
| `app/frontend-mode/sync.cjs` | Daily ↔ Work 会话/导航/任务同步 | 任务 10 / 11 |
| `app/frontend-mode/probe.cjs` | DSH Compatibility Probe / Report / 升级判定 | 任务 16 / 17 / 18 |
| `app/native-ui/*` | Native Renderer（index.html / preload.cjs / app.js / app.css / state / components / themes） | 任务 6 / 7 / 14 / 15 |
| `app/desktop-main.cjs` | 两个渲染器的创建、布局、模式 IPC、失败回退 | 任务 1 / 3 / 5 / 15 / 20 |
| `app/extensions/mega/*` | 主题下发、HNS Model IPC、Mega 模式切换入口 | 任务 12 / 13 / 14 |

## 3. 关键行为

### 3.1 P0 — 官方 Overlay 退出主架构（任务 1）

`official_overlay` 默认**不再创建**。它被标记为 deprecated，只有显式设置
`DSH_OFFICIAL_OVERLAY=1` 才会创建（保留代码用于历史主题包的排查）。默认路径下
Work Mode 之上没有任何透明视图，官方 UI 的点击、输入、滚动、菜单全部原样可用。

### 3.2 Daily Mode（HNS Native Frontend）

覆盖任务 7 要求的第一阶段能力：会话列表、创建、选择、对话时间线、用户/助手消息、
工具与任务结果、Composer、发送、停止、运行中状态、设置入口、错误显示。

所有数据来自 **HNS Model**：渲染器拿到的是 `Session`/`Message`/`ToolEvent`/`Task`/
`ComposerState`/`BackendState`/`SettingsState`，拿不到后端路由名、journal 事件或官方
选择器（Gate I）。

### 3.3 主题 / 角色 / 皮肤迁移到 Native（任务 14 / 15）

主题引擎的 payload 同时下发给 Dock 与 Native Renderer：
token → `:root` CSS 变量；slot → `--hns-slot-<slot>-<property>`；
背景 / 角色 / 装饰 → `#backgroundLayer` / `#characterLayer` / `#decorationLayer`。
三个装饰层都是 `pointer-events: none`，主题永远无法抢走交互。详见
`app/native-ui/themes/README.md`。

### 3.4 Mega 模式切换入口（任务 12 / 13）

* 收起栏：`#railMode` 一键切换，当前模式直接写在按钮上（`H` = Daily，`D` = Work），
  带 tooltip。
* 展开面板：`Interface Mode [Daily] [Work]` 选择器，附带模式说明。
* 两者读同一份 shell 持有的状态，且切换请求在飞行中会被禁用，不可能出现状态不一致。

### 3.5 失败回退（任务 20）

Native Renderer 的 `render-process-gone`、渲染组件抛错、快照失败，都会上报到 shell；
`manager.degrade()` 保留 backend、切到 Work Mode 并记录 `DAILY_DEGRADED` 原因。
不重启 Harness、不取消任务、不删除会话。

### 3.6 Work Mode 的宽度策略（真机验收后新增）

官方 Web UI 在宽度不足时会**隐藏自己的会话侧边栏**：Mega 展开时占用 560px，官方视图只剩
914px（窗口 1489px），于是 Work Mode 看起来「官方界面没正常渲染」。现在：

* 进入 Work Mode 时，Mega 自动收起到 48px 轨道条，官方视图拿到完整宽度（实测
  1426×884），官方 UI 保持它原本的布局；
* 收起是**运行策略**而不是偏好改写（`persist: false`）：用户在 Work Mode 里手动展开
  Mega 仍然有效，切回 Daily 时会恢复用户原本的展开状态；
* 轨道条上的 `H`/`D` 快速切换在两种模式下都可点击。

### 3.7 模块折叠

Dock 里的每个大模块（Interface Mode / Appearance / Skills / 手动队列 / 硬件自适应并行 /
Sub-worker / 余额 / 拓展状态）现在都可以折叠：标题栏出现一个折叠按钮，点击标题文字也可以
切换；折叠状态按模块保存在渲染器本地（`localStorage`），不随主题或会话同步。Native
Frontend 的 Sessions 与 Activity 两个侧边模块同样可以折叠（窄窗口时把宽度让给对话）。

### 3.8 主题资产真正落到画面上

真机验收发现：主题「应用成功但只有配色变了」，因为**图片从来没有到达渲染器**——

* 主题包用 `assets/persona/banner.png` 这类**包内相对路径**声明图片，渲染器把它当 URL
  去自己的文档里找（找不到）；
* 生成器写出的 `var(--hns-asset-wallpaper)` 引用落在 slot 的 `asset` 属性上，而这个属性
  期望的是 URL 而不是自定义属性引用（声明无效）；
* asset token 在 CSS 里以裸 data URI 输出，`background-image: var(--hns-asset-wallpaper)`
  因此也不成立。

现在 `app/extensions/mega/theme/assets/resolver.js` 在**绘制时**统一解析（dock / official
shell / native 三个消费者共用同一份 payload）：

| 声明形式 | 处理 |
| --- | --- |
| `data:image/...` | 原样使用 |
| `assets/...` | 从主题包目录内联为 data URI（越界的 `../` 引用被拒绝） |
| `var(--hns-asset-*)` | 替换为该 token 的编译值，未填写的引用降级为 `none` |
| 文件缺失 | 回退到同角色 token，再回退到 `none`，并记入 `payload.assets.unresolved` |

同时 `preview.toCssVariables()` 把 asset token 以 `url("data:...")` 形式输出，Native
Frontend 的图层再以 `var(--hns-native-*, var(--hns-asset-*, none))` 兜底，所以「只填 token
的主题」也能显示壁纸 / 角色 / 装饰 / 人设。

验收证据（真机运行，`GateH.assets`）：当前主题在 Native 面上一共 4 个图层是内联图片
（wallpaper / decoration / personaBanner / personaAvatar）。

## 4. 验收

### 4.1 自动化 Gate（本轮已执行）

```powershell
cd app
npm run check     # scripts\check-syntax.cjs（115 个源文件）
npm test          # node --test ..\tests\unit\*.test.js
```

| 项目 | 结果 |
| --- | --- |
| `npm run check` | PASS（117/117，含 `app/frontend-mode/`、`app/native-ui/`、`theme/assets/resolver.js`、`scripts/dual-ui-acceptance.mjs`） |
| `npm test` | 730 tests / 728 pass / 1 fail（+1 为下述多句柄时序项） |

**唯一失败项与本改动无关**：`tests/unit/multi-supervisor.test.js` 的
`并行验收: independent nodes really run at the same time on N workers` 在本机
（较慢的机器）稳定超时（`expected a real speed-up, took ~8.6s`）。在同一台机器上对
未修改的 `HEAD` 建独立 worktree 复跑，结论完全一致，属于既有的、与主机性能相关的
时序断言。

新增测试：`tests/unit/dual-ui.test.js`（28 项），覆盖

| 覆盖点 | Gate |
| --- | --- |
| 模式默认 daily、落盘往返、脏数据降级 | 任务 2 |
| HNS Model 实体与归一化总量性 | 任务 9 / Gate I |
| journal → Message / ToolEvent / turn 判定 | 任务 7 |
| 后端 RPC 失败降级、capabilities 探测 | 任务 8 / 任务 16 |
| adapter 快照不含路由名 | Gate I |
| 切换步骤、会话连续性、官方渲染器不可被驱动（诚实报告） | 任务 10 / 任务 11 / Gate E |
| 状态机、并发切换排队合并、降级回退 | 任务 15 / 20 / Gate D / Gate F / Gate J |
| 八项契约 + Compatibility Report + blocked 时保持版本并生成修复任务 | 任务 16 / 17 / 18 |
| Native 渲染器不读官方 DOM、overlay 默认关闭、shell 只创建一次视图 | Gate C / Gate H / Gate I |

### 4.2 真实 Electron 验收（本轮已执行）

```powershell
node scripts\dual-ui-acceptance.mjs --root D:\DS-Hns --port 3097 --cdp 9337 ^
     --switches 20 --report temp\dual-ui-acceptance.json
```

| 项目 | 结果 |
| --- | --- |
| Dual-UI 真机验收 | **PASS（25/25 checks）** |

该脚本启动真实 Electron（独立 app name / 独立 user data dir / 非 3097 端口），再通过
CDP 驱动**真实**的 Dock 与 Native 渲染器：

| 检查 | Gate | 结果 |
| --- | --- | --- |
| native / dock / official 三个渲染器都起来 | A | PASS |
| 默认进入 Daily Mode | A | PASS |
| backend 可达（`ready`）、主题已下发到 Native（`themeId`） | A / H | PASS |
| Dock 暴露 mode API；收起栏 `H`、展开选择器、snapshot 三者一致 | G | PASS |
| **Daily ↔ Work 往返 20 次全部一致** | D | PASS |
| 切换过程中 Native 渲染器 target id 不变（没有重建） | D | PASS |
| 官方渲染器仍是同一个 target、同一个 URL（没有被 reload/导航） | C | PASS |
| 官方文档仍是活的完整文档（`readyState=complete`，有内容） | C | PASS |
| 强制 native 失败 → 自动回退 Work Mode 且原因可见 | J | PASS |
| 回退不重启/不替换任何渲染器实例 | J | PASS |
| 用户可从回退状态切回 Daily，降级标记清除 | J | PASS |
| 主题在 Native 面上真正画出图片（≥1 个图层为内联图片） | H | PASS |
| Work Mode 下官方视图宽度 ≥ 1200（实测 1426×884） | C | PASS |
| 进入 Work 时 Mega 收起到轨道条 | C | PASS |
| Work 内仍可手动展开 Mega | C | PASS |
| 切回 Daily 恢复用户原本的展开状态 | C | PASS |

不在该脚本内、需要人工或需要 API Key 的 Gate：

```text
Gate B  Daily 真实收发消息（需要配置 DEEPSEEK_API_KEY，脚本刻意不消耗模型额度）
Gate E  会话连续性：脚本验证了 active session 在 20 次切换中不变；带真实会话的完整
        版本需要先有一个会话（Gate B 的前置），见 4.3 的已知限制
Gate F  运行中任务切换不中断（需要真实运行中的任务）
Gate C  点击 / 输入 / 滚动的交互级验证仍由 scripts\acceptance.mjs 覆盖
```

本轮真机运行还发现并修掉了三个**单元测试看不见**的真实缺陷：

1. `official_shell` / `official_overlay` 的 `loadFile` 路径多了一层 `..`，两个表面在真机
   上一直以 `ERR_FILE_NOT_FOUND` 静默降级（stub 会记录任何路径，因此测不出来）。
   现在 `tests/unit/theme-official-surfaces.test.js` 会把每个
   `path.join(__dirname, ...)` 解析到真实文件系统并断言存在。
2. Native Renderer 的 `renderShell()` 被无参调用却读取 `state`，首帧必然抛错并把
   Daily Mode 打成 degraded。现在由 `tests/unit/native-ui-render.test.js` 用真实脚本 +
   DOM stub 驱动整个渲染路径。
3. 降级（`degrade()`）会**持久化** Work Mode，导致一次偶发失败会让下次启动也不再回到
   Daily。现在回退只改变当前会话的模式，不写入用户偏好。

### 4.3 已知限制（诚实记录）

**官方渲染器无法被定位到指定会话。** 任务 10 的 “Daily → Work：sync official
renderer” 在当前官方版本上无法实现：官方 Web UI 没有 session 深链接，而任务 4 /
任务 8 明确禁止向官方渲染器注入 JS 或 DOM。因此：

* Daily → Work 会记录当前会话、保持 backend 连续性，但**不会**改写官方 UI 当前
  显示的会话；`sync.officialNavigation()` 返回 `{ supported: false, reason }`，
  该原因会出现在切换告警里，不做静默假装。
* Work → Daily 会按「用户显式选择 → 记忆的 Work 会话 → 记忆的 Daily 会话 → 后端最新
  会话」的优先级打开会话，且只在会话确实还存在时才复用记忆值。
* 一旦官方版本提供深链接，注入 `navigateOfficial` 钩子即可让同一条切换路径开始使用
  它（`createSync({ navigateOfficial })`），无需改动状态机。

这也是 Gate E 唯一未完全满足的部分：**会话不丢失、任务不中断、Harness 不重启**均已
满足，但“Work Mode 必须显示 Session A”取决于官方 UI 是否允许被定位。

## 5. 配置与环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| — | `daily` | `data/state/frontend-mode.json` 记录当前模式，可手工改为 `work` 作为启动默认 |
| `DSH_FRONTEND_MODE` | 未设置 | `daily` / `work`：强制本次运行的启动模式，且**不改写**用户已保存的偏好（验收/快捷方式用） |
| `DSH_OFFICIAL_OVERLAY` | 未设置 | `=1` 时创建已废弃的官方 Overlay（仅排查旧主题包） |
| `DSH_MEGA_INTEGRATED_DOCK` | 开启 | `=0` 时回退到“官方窗口 + 独立 Mega 窗口”的旧形态，双前端不启用 |
| `DSH_DISABLE_MEGA` | 未设置 | `=1` 时不加载 Mega 扩展（此时双前端 IPC 不可用，Work Mode 仍正常） |
