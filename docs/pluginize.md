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

## 人工 UI 复查标记（checkpoint 3：复查的两个问题 + 一个定位缺陷）

**标记**：`manual-ui-review-3`。第二轮复查的结论是"其余项目通过"，指出三件事：悬浮球只在 Electron 界面、
官方设置里的 Mega 页面是白字磨砂底难辨认、以及球的详情窗"定死区域然后下滑"。前两件已改，第三件顺着查出
了一个**真实的定位缺陷**：

### 1. 信息窗改成"从角落向外长"（§4.3 的补充）

原来的面板用 `top`/`left` + 固定 `70vh` + `overflow:auto`：点开详情时内容变长，于是变成一个**一开始就
框错的盒子**在滚动。现在面板是**锚在球的角上**的：竖直方向能向上就用 `bottom`（球的上沿 + 间隔），
水平方向靠右边就用 `right` 对齐球的右沿 —— 打开就**向上、向左长**；球在左半边或上方空间不够时，它换到
有空间的那一侧；只有内容真的比整个层还高时才滚动（兜底，不是布局）。`data-hns-mega-panel-side` 记录了
它选了哪一侧。

### 2. 两个界面都有自己的不透明底板

第一轮复查看到的"白字磨砂底"是结构性的，不是配色问题：我们的文字有自己的调色板，而 `all: initial` 让
我们的盒子**完全没有背景**，于是官方那层磨砂玻璃透上来。现在面板与整页各自带一张**不透明卡片**
（`CARD`，`rgba(14,16,20,.97)` + 边框 + 阴影），文字一定落在自己的底上，因此与官方主题是明是暗无关。
面板里的次级文字也从 `.5` 提到 `.62`。

### 3. 定位改成"相对自己所在的层"，并因此修掉一个真 bug

这是"悬浮球只在 Electron 界面"这条最可能的成因，而且是**代码里的错**：原实现用 `window.innerWidth/Height`
算 `left/top`，但在官方 UI 里球并不住在窗口里 —— 它住在 `shell.overlay` 槽渲染的那个盒子里，那个盒子可以
比视口小，也可能位于带 `transform` 的祖先里（此时 `position: fixed` 是**相对祖先**而不是窗口）。于是
坐标算错，球就可能被放到视野外或另一个位置。现在：

* 球外面多一层 wrapper（`position: fixed; inset: 0`，就是槽给我们的那个盒子的尺寸），球与面板都是它里面的
  `absolute` —— 不管有没有 transform 都对；
* 存的位置也从 `{x, y}`（窗口坐标）改成 **`{right, bottom}`（相对层自己右/下角的距离）+ 吸附边**，
  所以缩放窗口时吸在边上的球跟着边走，不需要任何人重算；宿主端的 schema 因此升到 **version 2**，
  version 1 的文件读作"还没有位置"（它的数字在没有当时窗口尺寸的情况下无法换算），球回到默认角一次。
* 拖拽仍是相对的，但**每次移动都相对按下时的偏移量**：用"当前偏移量"会让每个 pointermove 把整段位移再加
  一遍，球会加速飞走。这个 bug 也是在写这轮测试时暴露并修掉的（`tests/unit/mega-core-client.test.js`
  的拖拽用例现在断言两次连续移动的绝对值）。

### 还要你确认的一条

**"悬浮球只在 Electron 界面"我还不确定具体现象**：`shell.overlay` 是官方界面自己的槽，客户端半边在浏览器
与 Electron 里是同一份 bundle（同一个 HTTP 服务发出来的），所以按道理两边都该有。上面第 3 条是能解释
"在官方界面里看不到/位置离谱"的那类原因，但如果重启后**仍然**只在某一个界面看到球，请告诉我：是在
DS-Hns 窗口里有、浏览器（用同一地址）打开时没有，还是反过来？——那是另一种成因，值得单独查。

复查清单（重启后）：

1. **球**：右下角出现；拖动会跟着指针走（不再加速飞走）；拖到左/右边缘会吸附，改窗口大小后仍贴着那条边；
   重启后回到原处。
2. **详情窗**：点开后**向上、向左长**，不再是一个固定高度然后往下滚的小窗；球拖到左上角时，窗口换到右下。
3. **官方设置 › Mega**：文字应该落在一张深色不透明卡片上，清晰可读。

---

## 人工 UI 复查标记（checkpoint 4：向中心展开、系统悬浮球、旧侧栏退场）

**标记**：`manual-ui-review-4`。第三轮复查给出的三条，逐条落地：

### 1. 详情窗按位置**向屏幕中心**展开（不再是"固定向上"）

第二版把面板锚在球的角上、只要上方有空间就向上——这就是"固定向上"的来源。现在的规则是**看球在屏幕的哪
一半**：下半 → 面板在球上方并向上长；上半 → 在下方并向下长；左半 → 在球的右侧并向右长；右半 → 在左侧并向
左长。也就是"面板占的永远是球与屏幕中心之间那块地方"，面板的**远边**随内容增长。

这条规则不需要"哪边空间大"来兜底，而且**想兜底也兜不了**——朝中心的那一侧按定义就是更宽的一侧（球心在下
半意味着它上方超过半个屏幕）。这一点写在 `choosePanelSide` 的注释里，免得下一个人以为漏了一个分支。
高度仍按所选那一侧的空间夹取，所以矮屏上是面板变矮，而不是换边。

### 2. 系统悬浮球（`app/extensions/mega/system-orb.cjs`）

"可以做成系统悬浮球吗？" —— 可以，而且这是唯一一种不去碰别人的做法：**我们自己的一扇窗口**（透明、无边框、
`alwaysOnTop`、`skipTaskbar`、`focusable: false`），画我们自己的文档（`ui/orb.html`），浮在所有应用之上。
官方渲染器里没有注入任何东西，也没有被套上任何样式 —— 和壁纸层同一条规矩。

三条性质让它成为"球"而不是"打扰"，而且都是结构性的：

* **不拿它没被给的东西**：默认 `setIgnoreMouseEvents(true, { forward: true })` —— 点击/滚轮/拖动全部落到下面
  那扇窗口，同时渲染端仍能看见指针移动，于是只有"光标在球或面板上"时才把窗口切成可交互；`focusable: false`
  让它完全不进键盘链，点面板上的按钮不会把焦点从用户正在打字的地方抢走。
* **永远不比它画的东西更大**：窗口 = 球 +（打开时的）面板 + 几像素透明边距。它能透明又常驻最上层却不成为"一
  块压在桌面上的玻璃"，就是因为它里面没有可挡的地方。
* **向屏幕中心长**：与界面内那颗球同一条规则（`layoutOrbWindow`，纯函数、有单测），然后重排窗口：**球在屏幕上
  不动**，面板占据球与中心之间那块空间。拖动即移动窗口，球就停在指针放下的地方。

数据同源：球读的是**同一个视图模型**（`app/plugins/mega-core/lib/view.js` 的 `buildMegaView`），喂给它的是
Control Center 用的同一份 `controlCenter()`；动作走的是**同一个** `controlAction`。位置存在
`data/state/system-orb.json`（屏幕坐标 + 吸附边），重启后回到原处；多显示器按所在显示器的 work area 夹取，
被拖到屏幕外会被拉回。

### 3. 旧 Mega 侧栏退场（默认不再出现，但仍然可达）

"Mega侧栏一直残留没有处理" —— 现在**默认不上屏**：壳体不再为它保留右侧那条，壁纸也不再需要给它切口
（`wallpaperNotch()` 在隐藏时返回 null），扩展自己那扇 legacy 窗口也不在启动时创建。它**没有变得不可达**：
托盘"Mega 控制台"、插件管理入口、`Ctrl+Shift+M` 都会在需要时**当场创建并显示**它（§30 的删除是下一步，
但在那之前"藏起来"和"点不到"必须是两件事——球坏掉的那天，这个区别就是全部）。
`DSH_MEGA_DOCK=1` 恢复旧行为，`=0` 是彻底关掉。

**为什么这一轮还没有删代码**：删除是 §30 的独立阶段（会牵动 dock 的 html/css/js、dock target、geometry、
几十个测试与 verify 检查）。把它和"球第一次上屏"塞进同一次推送，等于在没有任何退路的情况下换界面；这一轮
先把侧栏从屏幕上拿掉并保持可达，删除单独走下一轮。

### 验证

`tests/unit/system-orb.test.js` 11 项（窗口的创建参数：常驻最上层/不抢焦点/不在任务栏、默认无视鼠标、
只在悬停时交互；面板向中心的四个方向、矮屏与窄屏的夹取、多显示器的 work area、被拖出屏幕后拉回；
拖动只写一次位置且写入的正是画出来的位置；关闭面板缩回球的尺寸；没有 BrowserWindow 或 `DSH_MEGA_ORB=0`
时每一个调用都只回答不抛异常）。`mega-core-client.test.js` 11 项（新增"向中心展开"的四个方向断言）。
`surface-ownership.test.js` 新增一项：球的窗口只有六个入口 + 一个推送，且全部有主（`orb-preload.cjs`
现在也在审计范围内）。`mega-extension-integration.test.js` 与 `startup.test.js` 按新语义更新：
启动时创建的唯一窗口是球（不是侧栏），而托盘的 Mega 入口**当场**把它创建出来。

---

## 人工 UI 复查标记（checkpoint 5：只留系统球，修好置顶与闪烁）

**标记**：`manual-ui-review-5`。第四轮复查给出四条，其中"侧栏已正确移除"是确认，另外三条都改掉了 ——
而且两条是**真缺陷**，不是观感问题。

### 1. 两个球 → 只留系统那一个

第一版把球注册进官方 `shell.overlay` 槽，第二版又加了系统球，于是同一个快照有两个地方在看。用户的判词是
"现在有两个球，只要系统最外层那个"。现在浏览器半边**只注册 `settings.section`**（Mega 整页），
`shell.overlay` 不再占用；球的位置、唤醒/收起、动作全部由系统球那一侧负责（它们本来就共用同一个视图模型
与同一个 `controlAction`）。`client.js` 里也留了断言：没有任何 `inject('shell.overlay')`。

### 2. 球盖不住别的应用 → 是 `parent` 的错

第一版给球设了 `parent: mainWindow`（当时的理由是"关掉产品窗口时球一起走"）。这在 Windows 上是致命的：
**被拥有的窗口（owned window）的 z 序跟随 owner，`alwaysOnTop` 不被遵守** —— 于是球永远只能待在产品窗口
之上、别的应用之前。现在球是**顶层窗口**（无 parent），`setAlwaysOnTop(true, 'screen-saver')` 在创建时
再确认一次；它仍然随扩展一起销毁（那是 parent 唯一买到的东西）。单测直接断言 `options.parent === undefined`
与创建参数，注释里写明原因，免得下一个人"顺手"把 parent 加回来。

### 3. 点击闪烁 → 自己在跟自己打架

两个原因叠在一起，都修了：

* **交互状态被"悬停"一个人决定**。打开面板会重排窗口，于是有一两帧光标落在透明边距而不是球上：悬停变
  false → 窗口切成穿透 → 转发的指针事件又把光标判成"在球上" → 再切回来，两个状态互相追。现在
  `syncInteractive()` 由**三件事**决定：光标在不在我们身上、**是否正在拖动**、**面板是否开着**。后两件都是
  "用户正在用这个东西"的明确信号，不依赖一个会在脚下变的命中测试。原生的 `setIgnoreMouseEvents` 也只在
  答案**变化**时才写（并且`interactive` 的初值是 `null` 而不是 `false`：新窗口默认是"可交互"的，
  "答案恰好是 false"和"窗口已经是穿透"不是一回事，第一版就是在这里漏掉了首次写入）。
* **原生 reshape 太频繁**：`setBounds` 现在只在矩形**真的变了**时才调用（`sameBounds`），15 秒一次的
  状态推送不再无意义地重塑一扇透明的置顶窗口；面板测量也从"把 `max-height` 去掉再量"改成读
  `scrollHeight`（内容高度，即使被夹住也正确），省掉每次推送两次强制重排。

顺带补了一条交互：面板打开时，点在面板和球之外会**收起面板**（那时窗口本来就是可交互的），所以不必先去
找关闭按钮。

### 4. 侧栏：确认已移除，代码删除排在下一轮

用户确认"Mega 侧栏已经正确移除"。删除那套代码（dock.html/css/js、dock target、geometry、十几个测试与
verify 检查）仍是 §30 的独立阶段：它和本轮的三处修正没有耦合，单独一轮做完更安全。

### 验证

`tests/unit/system-orb.test.js` 13 项（新增：`parent` 必须不存在；开着面板时悬停变 false 也不会把窗口
切成穿透，拖动同理；重复的悬停答案不产生原生写入；相同状态的推送不重塑窗口，打开面板则必须重塑）。
`tests/unit/mega-core-client.test.js` 7 项（重写为单界面：只注册 `settings.section`、源码里没有
`shell.overlay` 注册、整页渲染 §4.4 与自带的深色卡片、动作走 `/mega-core/action`、隐藏不轮询、
DS-Hns 不应答时画出原因、没有 React 时只画空气）。`mega-core-plugin.test.js` 5 项（路由从五条回到四条，
`/orb` 随界面一起消失）。语法门 229/229；`verify.ps1 -SkipTests` ALL PASSED（新增"插件只画一个界面、
球不在其中"的检查）。

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

---

## 仪表盘接回真实数据源（DashboardView）

**这一轮解决的问题不是画得不好，是没有数据。** 球的面板打开后画的是 §4.4 的治理字段（插件健康/依赖/版本/
能力/重试/回退/最近错误/待人工/恢复动作/兼容性/版本钉），而旧 Dock 顶部那四张卡 —— 时段与谷价倒计时、任务
运行/等待、并行 current/cap、余额三张卡 —— **在治理快照里根本不存在**：`buildControlCenter()` 只回答
`{ sections, modules, plugins, degraded, failed, failing }`，治理桥转发的就是这一份，所以运行中的球拿不到余额，
也拿不到倒计时。

### 数据源是找回的，不是新造的

新增的 `dashboard` 块由 `buildControlCenter()` 装配，**与 sections/modules/plugins 同一份快照**，另外两件它
自己拿不到的事实由扩展交给它（各自真实 owner，绝不重新加载第二份）：

| 仪表盘 | 来源 |
| --- | --- |
| 时段 PEAK/OFF-PEAK、下一次切换时刻 | `scheduler.describe().peak`（`billing/peak-engine.js`） |
| 峰价时段表、价格来源 | `PricingRepository.getSchedule()/describe()` —— 与计费同源 |
| 余额（总/充值/赠送/读取状态） | `balanceService.describe()` |
| 运行/等待/挂起/阻塞/重试/失败/总数 | `scheduler.describe().activeQueue` / `.counts` |
| 并行 current/cap、CPU、空闲内存 | `scheduler.describe().concurrency` / `.system` |
| 子工作器、自动委派 | `snapshot.subWorker` |

三条不撒谎的规则写在代码里并被断言：**没读过的余额是 `—` 而不是 `¥ 0.00`**；读取失败保留上次成功值并标
`stale`；`controlCenter()` 与 `view.js` 都拿不到某个事实时给**理由**，不给一排零。

### 倒计时按"时刻"发布，不按"剩余秒数"

快照 15 秒一份，倒计时每秒都在变。所以 dashboard 行里存的是 `nextChangeIso`（价格切换的那个瞬间），由
`view.js` 用它**自己的时钟**减出来 —— 旧 Dock 每秒重算那行逻辑，在新结构里由"发布时刻 + 视图重算"承担。
再加一条：面板打开时 `useCountdown` 每秒自减一次，所以它不是 15 秒跳一格。下一次变化的钟点按**计费时区**
（`schedule.timeZone`，Asia/Shanghai）格式化：06:00Z 显示成 14:00，与用户对照的价格页一致。

标题也据实改了：旧 timer 卡叫"距下一次谷价"，但 `nextChange` 是**下一次价格切换**（两个方向都算）——谷价
时段里它指向的是"下一次峰价"，照旧文案会让人等一个已经在手的东西。现在叫"距价格切换 / Until price change"。

### 一条真相，两个界面各画一半

* **球的面板**（`client.js` 的 `MegaOrb`，以及系统球 `orb.js`）：**仪表盘在上** —— 价格/账户/子工作器三组，
  加任务与并行两组 —— 然后是治理的 lines、数字与动作按钮（`check`/`retry`/… 就在手边）；再点
  "治理详情 · Governance" 才展开 §4.4 字段与模块名册。
* **官方 Settings › Mega 整页**（`MegaPage`）：§4.4 十一个字段、模块名册、社区插件名册与它们的动作。
  **不重复画仪表盘**（那是球的活）。
* 两半来自**同一个** `buildMegaView()` 的返回对象（`fields` 与 `dashboard`），所以一个数字只有一个来源。

### 顺带修掉一个真缺陷

`verify.ps1` 里那条"球点外面会收起"**一直是 FAIL**：检查项找 `node.contains(event.target)`，而浏览器半边
实际只有 Esc 与 × 能关面板 —— 那套"点外面收起"的逻辑当时只实现在**系统球自己的窗口**里（`orb.js` 的
`documentPointerDown`）。复查结论那轮把 in-UI 球拿掉时，检查项没跟着走，于是它一直在报一个不存在的东西。
现在球真的实现了这件事（`document` 上 `pointerdown` + 球与面板两个 box 的 `contains`，**不**
`preventDefault`：点击照样落到它原本该落的地方），检查项也改成断言真实代码。

### 验证

`tests/unit/control-center.test.js` 9 项（新增 2：仪表盘与 sections 同源、余额没读过不编 `¥0.00` 且失败保留
上次成功值）；`tests/unit/mega-core-view.test.js` 9 项（新增 3：仪表盘数字 + 十一个字段原样不动、倒计时按
时刻重算三档、无 dashboard 块给理由）；`tests/unit/mega-core-client.test.js` 9 项（新增 2：球开在仪表盘而
页面不重复画、倒计时每秒自减）；新增 `tests/unit/orb-ui.test.js` 5 项（系统球面板画出五组数字与三种色调、
仪表盘在治理之前、缺 dashboard 给理由、关着不画、球的色调仍来自治理）。

真实链路验证（`buildControlCenter` + **真实 `SchedulerService`/`PricingRepository`** + 一次性 state 目录）：

```text
电费时段=OFF-PEAK | 峰价时段表=09:00-12:00, 14:00-18:00 · Asia/Shanghai | 价格来源=official · 2026-09-07
距价格切换=已是谷价 · off-peak now | 下一次变化=14:00 → 峰价 Peak
账户=未刷新（未读，不编 0）| 并行 current=4 / cap=4 | 空闲内存=13.4 GB
view.dashboard: price:until-off-peak=3m 59s（由 nextChangeIso 与视图时钟算出）
```

全量测试唯一失败是既有的 `mega-extension-integration`（orb 窗口要 `DSH_SYSTEM_ORB=1` 才创建，基线同样
失败）；`verify.ps1`（`-SkipTests`）**ALL CHECKS PASSED**。

---

## Phase 2 — 定时任务：官方界面里的新建浮窗（对话式输入 + 定时设置）

**要解决的问题**：创建定时任务的界面原来只长在旧 Dock 的"手动队列"面板里 —— 而那个 Dock 默认不出现，所以
"新建一个定时任务"在产品里其实没有入口；即便打开 Dock，它也是一个表单（textarea + 三个 select +
`datetime-local`），和"对话"没有任何共同点。

### 入口与浮窗

入口注册进 **`conversation.session.header.actions`**（官方闹钟与任务列表所在的槽，`order: 30` 排在它们之后；
list 型槽是加成，不会顶掉官方条目）。点开的是**官方组件库的居中浮窗**：
`@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`（该模块名确实在官方前端构建的 platform table 里：
`{react, "react/jsx-runtime", "react-dom", …, "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives",
"@deepseek-ai/dsh-client-ui-dockkit"}` —— 这是这一轮读出来的事实，也是插件可以 require 它的依据）。
它自带 portal 到 `document.body`、遮罩、`role="dialog"` + `aria-modal`、Esc 关闭与居中；`headless: true` 让我们
自己排布内部，于是输入框与定时设置是**一个整体**而不是官方 chrome 切成的两半。宿主没有这个模块时入口不出现
（`try/catch` 包住 require）：一个会开出坏盒子的按钮比没有按钮更糟。

### 结构与语义

弹窗内自上而下：**对话输入区**（同形输入框 + "Enter 发送 / Shift+Enter 换行"提示 + 字数），**定时设置**
（发送时间 + 四个快捷值 + 允许峰价 + 时区/峰价时段），**一句人话总结**（"将在 … 作为官方新会话发出 · in 2h 12m"，
峰价且未允许峰值时多一句"会挂起到谷价"），**两个按钮**。创建回执显示真实任务（id/状态/到点），拒绝显示
DS-Hns 原话。Enter 的三种情况（发送 / Shift 换行 / 输入法组字）都有独立断言。

### "与正常对话相同"是可断言的性质

新任务走 `scheduler.addTask` → `launchOfficial` → **官方 `session/create` + `session/prompt`**（与真人按发送
同一对 RPC），提示词原样发送。`tests/unit/scheduled-task.test.js` 用真实 `SchedulerService` + 假 official client
钉住：早一小时 tick 只挂起（`waiting-schedule`，零发送）；到点后同一 tick 变成官方会话且 `prompt` 逐字相同；
峰价未允许 → `peak-window` 挂起，允许 → 照发。

### 能力由 DS-Hns 回答

桥新增 `/timing`（能力面：默认时间 now+3m、时区、峰价时段、当前是否峰价、执行方式、限制）与 `/task`
（创建，原样透传请求，保留 DS-Hns 的 400 与原话）；插件同源暴露 `/mega-core/timing`、`/mega-core/task`。
**动作闭集没有扩大** —— 调度不是对模块的恢复动作 —— 桥的发现文件 schema 因此升到 **2**；旧版桥对 `/timing`
回答 404，对话框显示"读不到调度能力：… does not answer timing questions"（**已在运行中的旧实例上实测到 404**，
即这条兼容路径不是推测）。

### 验证

`mega-core-client.test.js` 15 项（新增 4）、`mega-core-plugin.test.js` 6 项（路由六条 + 经真实治理桥创建并保留
拒绝原话）、新增 `scheduled-task.test.js` 3 项；全量 **1499/1499**；`verify.ps1 -SkipTests` ALL CHECKS PASSED；
语法门 229/229。真实链路探针（真实 `SchedulerService` + `PricingRepository`）：`surface.defaults =
{startAt: now+3m, allowPeak: false, deliveryMode: 'official-session'}`、`timeZone: Asia/Shanghai`、
`peakNow: true`；空提示词 → `{ok:false, reason:'a task needs a prompt', field:'prompt'}`，坏时间 →
`not a time this scheduler can read`，正常创建 → `status: PENDING` → 随即 `SUSPENDED`（未到点）。
