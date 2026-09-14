# 启动：先可用，再好看

本文件记录 `updateplan/startup.md` 的 **P0（与部分 P1）** 在 DS-Hns 侧的落地。计划书本身是本地
施工文件（`updateplan/` 不入库），所以这里把结论与边界写全，下一次施工不必再回去读一遍。

## 1. 四条状态与一句话规则

```
BOOTING      进程 / 窗口 / 核心资源准备
CORE_READY   基础主框架出现（本产品：官方 Harness UI 成为窗口页面）
INTERACTIVE  用户可以输入、阅读、工作 —— **这就是"启动完成"**
ENHANCED     壁纸、Mega、外观与可选插件在背后补齐
```

> 「应用可用」不允许绑定在「全部增强渲染完成」上。

这条规则写在 [app/startup.cjs](../app/startup.cjs) 里，并且**是被测出来的**，不是注释里的愿望：
`tests/unit/startup.test.js` 断言 `interactive` 之前的阶段才允许阻塞，且每个可选层都排在
`startup.mark('interactive')` **之后**。

## 2. 改了什么

### 2.1 窗口先出现，且不是空白

旧流程：创建窗口（隐藏）→ 等 Harness → 等扩展宿主 → 等 dock 渲染器 → 最后才 `show()`。
于是"某个可选模块很慢"和"产品没启动起来"在用户眼里完全一样。

新流程：创建窗口 → **加载骨架页 `app/splash.html` 并立刻显示** → 骨架页是"马上要出现的形状"
（顶栏 / 侧栏 / 会话区 / 输入框占位），无脚本、无网络、无控件；官方 UI 就绪后替换它。
最差也是一个用户看得懂的加载状态，不允许是无反馈的空白（计划书 §13/§14）。

### 2.2 官方 UI 就绪即 INTERACTIVE

`CORE_READY` = 官方页面成为窗口页面；`INTERACTIVE` 紧随其后。我们**不去探测官方 DOM**（这是产品的
硬规则），所以"它加载完成并在屏幕上"就是诚实的定义 —— 用户真正要的东西就是官方 UI 本身。

### 2.3 之后的一切都是后台

壁纸层、扩展宿主、Mega dock、重启调度恢复、子 worker 自启动全部通过 `startup.defer()` 运行：

- **不会**拒绝、**不会**延迟用户、**不会**失败整个启动；
- 每一件都有自己的一条 `[BOOT]` 记录，失败写 `failed: <原因> (the boot carries on)`；
- 全部落定后标记 `enhanced`（计划书 §17/§18/§42/§47）。

### 2.4 启动日志

每个阶段一行，形状固定，慢在哪一行一眼可见（计划书 §26）：

```
[BOOT] window-created            112ms   budget 200ms
[BOOT] shell-ready               168ms   budget 800ms
[BOOT] harness-ready             2.4s
[BOOT] core-ready                2.6s   budget 800ms · OVER BUDGET
[BOOT] interactive               2.6s   budget 1.5s · OVER BUDGET
[BOOT] official-surfaces-ready   2.7s   background
[BOOT] extensions-ready          3.9s   background
[BOOT] dock-ready                4.1s   background
[BOOT] wallpaper-ready           4.2s   background
[BOOT] boot report {...}
```

**预算只记录、不强制**（计划书 §24）：错过预算仍然是能用的启动，晚了不许变成失败。真正值得看的
数字是 `ownOverhead()` —— 从 Harness 给出地址到用户可以工作，这一段才是本产品自己拥有的时间；
Harness 自身的启动不是我们能优化的部分。

## 3. 明确仍然没做（下一轮）

按计划书的优先级，P0 已落地；下面这些是 **P1/P2 的剩余项**，本轮**没有**实现，避免半成品：

| 计划书 | 项目 | 现状 |
| --- | --- | --- |
| §4/§9 | CSS 作用域化（`official-surface.css` / `wallpaper-compat.css` / `community-extension.css`） | 现有壁纸层与 dock 已是作用域化的自有文档，未做文件拆分 |
| §5 | 三套阅读预设（Work / Immersive / Reading） | 未做 |
| §6/§7 | 接入社区插件 `elysia395/dsh-wallpaper-engine` + `AppearanceProvider` 抽象 | 未做（自有壁纸已按计划降级为简单实现：图片 + 位置 + 不透明度 + 模糊 + 压暗） |
| §8 | 对外 Appearance API token 白名单 | 未做（`--wp-*` / `--hns-glass-*` 目前只在 shell 与 dock 之间使用） |
| §43/§44 | 设置界面「外观」重组与社区插件缺失提示 | 未做 |
| §29–§38 | MEGA 去重（折叠态只留 RUN/AUTO/PWR，Q/ERR 动态出现，零状态隐藏） | **未做**：MEGA 已从首屏阻塞链移除，但折叠态仍是 RUN/QUEUE/HW/SUB/PEAK 五个常驻项 |
| §22 | `startup-cache.json` | 未做 |

## 3.1 第二轮：MEGA Protection Layer（`updateplan/startup2.md` §12–§18）

第二轮把"增强层活得安全"落成了代码：[app/extensions/mega/protection/index.cjs](../app/extensions/mega/protection/index.cjs)。
MEGA 不再只是右侧状态栏，而是增强能力的控制平面；**任何可选模块都必须注册后由它启动，不允许裸启动**。

- **六态**：`DISABLED / STARTING / HEALTHY / DEGRADED / FAILED / RECOVERING`；每个模块记录状态、版本、
  启动耗时、最近错误、重试次数、fallback 现状（§14）。
- **失败规则**（§15）：`start()` 只回答、不抛出。超时、抛错、或自己报告不健康 → 标 `DEGRADED`，
  立刻跑 fallback，**绝不抛给 Core**。计划书里那三条禁止项（插件失败导致白屏 / 壁纸失败带走输入框 /
  Market 失败让 Harness 起不来）由结构保证，而不是靠小心。
- **预算与重试**（§16/§17）：默认 3s 首启预算，超时不再阻塞任何 UI；重试阶梯是**一次快速、一次延迟，
  然后停止** —— 无限重试正是让真实故障被掩盖的方式。
- **回退链**（§18）：`dsh-wallpaper-engine → Simple Wallpaper → Official Background` 这种顺序被写成数组，
  逐个尝试，最后一个也失败就如实报 `unavailable`。
- **恢复可见**：健康检查重新通过时状态回到 `HEALTHY`、清掉 `lastError`、fallback 归 `idle`，否则面板会
  一直报告模块已经离开的状态。

测试：`tests/unit/mega-protection.test.js`（6 项：健康启动、超时→降级+fallback、重试阶梯恰好三次、
不健康→降级与恢复、可选/必需的区别与安全停止、`withTimeout` 两个方向）。

**仍然没做**（`startup2.md` 的 P1/P2）：社区插件 `dsh-wallpaper-engine` 与 `@dsh-market/plugin` 的实际接入、
MEGA Control Center 的 Protection 面板与插件修复入口（§45–§47）、`MegaItemRegistry` 的前端注册（§49）、
启动/壁纸/市场缓存（§52–§54）、以及 MEGA 折叠栏去重（§36–§41，仍是 RUN/QUEUE/HW/SUB/PEAK）。
**接线（本轮补上）**：`desktop-main.cjs` 在启动时创建 protection 层，并注册三个可选模块 ——
`wallpaper-layer`（壁纸窗口，fallback = 官方界面本身）、`mega-extension-host`（扩展宿主，fallback = 仅核心 IPC）、
`mega-dock`（Mega 侧栏，fallback = 隐藏侧栏）。它们的**启动**仍通过 `startup.defer()` 走启动状态机（所以
`[BOOT]` 的阶段账目不变），而**状态与失败**由 protection 层持有：模块失败时 boot 只看到「这一项降级了」，
MEGA 面板看到的是状态、最近错误、重试次数与 fallback 现状。启动结束时会多一行 `[protection] {...}` 全量报告。

## 3.2 第三轮：Bundled Plugin Manager（`updateplan/startup2.md` §19–§23）

MEGA 现在自己管"随本体提供、工程上仍是可选社区插件"的那两个插件：
[app/extensions/mega/plugins/index.cjs](../app/extensions/mega/plugins/index.cjs)，一个**策略层**——
它不 clone、不写插件目录、不读 package.json，只对注入进来的安装器与注册表做判断，所以 §23 的那张状态表
可以完全离线测试。

- **清单是真的、版本是钉的**（§21/§22）：`dsh-wallpaper-engine` 钉在真实存在的 `v0.7.1` tag，
  `@dsh-market/plugin` 钉在 `2BingLing/dsh-market` 的 `master` 提交（该仓库没有 tag，提交就是它的版本）。
  没有任何一处会去问"最新是什么"。
- **没测过的版本不会被装上**：清单里两个条目都是 `tested: false`，管理器据此报 `untested` 并**拒绝安装**
  （§21 把那个字段叫 `TESTED_VERSION` 是有原因的）。装与不装之间只差一次真机测试与一行翻转——不是一次
  静默升级。
- **用户说了算**（§23）：用户禁用的插件不装、不修、不复活；一个清单不认识的版本只被**报告**
  （`ahead-of-pin`），不会被替换；`repair()` 是唯一会替换已安装副本的路径，且永不自动。
- **失败属于面板，不属于 boot**：两个插件都注册成 protected module，fallback 分别是
  `Simple Wallpaper` 与"商店入口隐藏"（§18）。
- **接线**：MEGA 在 `start()` 里注册受保护模块、在后台跑策略（`Promise.resolve().then(() => ensure())`，
  绝不在启动路径上等网络），并暴露 `mega:bundled-plugins` / `mega:bundled-plugins-repair` 两个通道；
  读取的是**商店自己的记录**（`installer().list()`）来判断"是否已安装、是否被用户禁用"。

**安装调用已接线，adoption 只剩一次真机测试**：`installPinnedPlugin()` 用商店自己的两步 ——
`stage({ source, branch: ref })` 把代码放到磁盘并校验清单，`enable({ id })` 记录宿主可以运行它 —— 来安装
清单钉住的引用。因此"第一个 pin 标记 `tested: true`"就是采纳的全部工作量。

**提交 pin 现在也能装了**：商店新增 **revision 路径**（§22–§23 的"钉一个引用"对没有 tag 的仓库也成立）——
`git init` + `remote add` + `git fetch --depth 1 origin <sha>` + detached `checkout FETCH_HEAD`，因此
`2BingLing/dsh-market`（无 tag）钉的提交会被真的装上，而不是"默认分支当时的 HEAD"。状态文件记录
`revision`（与 `branch` 互斥，二者同时给出会被拒绝，非十六进制的 revision 也会被按名拒绝），
`installPinnedPlugin()` 据此选择走分支还是走 revision。

测试：`tests/unit/bundled-plugins.test.js` 9 项（清单为真且不追 latest、未测试不安装、缺失的已测试版本按 pin 安装、
用户禁用优先、未知版本只报告、不兼容只报告且只有 repair 会重装、repair 拒绝未测试 pin、受保护模块与 fallback、
以及接线与"安装路径尚未接线"的静态断言）。

## 3.3 第四轮：MEGA 折叠栏去重（`updateplan/startup2.md` §36–§44）

折叠栏原本是 dock 标记里五个固定方框（RUN/QUEUE/HW/SUB + 峰谷芯片），由 dock 脚本按 id 填数。这个形状正是
"状态栏变成第二条状态栏"的原因：每个新数字都要新开一个框，删掉一个要改三个文件，而且 dock 必须知道
"RUN 到底是什么意思"。

现在它是**注册表驱动**的：[app/extensions/mega/mega-items.cjs](../app/extensions/mega/mega-items.cjs)。
模块注册条目（`registerMegaItem({ id, priority, current })`），`current(snapshot)` 回答"我现在要说什么"，
返回 `null` 就是"我没什么要说的"。于是计划书的两条规则变成机制而不是纪律：

- **零不是新闻**（§36/§43）：值为 0 / 空 / `OFF` 的条目不出现——空队列、零重试、零错误是正常状态，正常状态
  不占永久注意力。
- **折叠栏有预算**（§44）：最多 5 项，按 `priority` 排序，装不下的计入 `overflow`，dock 渲染成 `+N`
  指向展开态的 Control Center，因此它不会无限增长。

去重的落点（§37–§41）：`RUN` = **DS-Hns 自己的 worker slot 占用数**（`activeQueue.workerSlotsInUse`，
官方 UI 不显示这个数）；`WKR` = 并发 / 硬件上限（原名 `HW`，改成它真正的含义）；`AUTO` 取代 `SUB`
（显示"自动委派"这个用户拥有的开关，而不是再抄一遍 agent 状态）；`Q` / `ERR` 只在非零时出现；
**峰谷芯片从折叠栏移除**——那是电费时段，属于展开态的账单卡片，不是资源策略。另外多一项 `EXT`：保护层里
处于降级状态的可选模块数（§42），同样只在非零时出现。

dock 只负责渲染（`renderRail`），不知道任何条目的含义；`features.cjs` 的 peak 元素表也去掉了 `railPeak`。
测试：`tests/unit/mega-items.test.js`（排序、零即静默、预算与 overflow、坏条目不影响整条栏、id 不可重复，
以及"折叠栏由注册表驱动"的静态断言），并同步更新了原先钉住旧方框的四个测试（architecture-contract、
mega-dock-render、sub-worker-ui、sub-worker-default-regression）。

## 3.4 第五轮：外观控制器与阅读预设（`updateplan/startup2.md` §26–§28、§5）

两个图层早就在（壁纸：每个底片一张图 + 不透明度/模糊/压暗；磨砂玻璃：Dock 的材质），缺的是**对它们的
一个决定**。现在它是 [app/extensions/mega/appearance/index.cjs](../app/extensions/mega/appearance/index.cjs)
里的三套阅读预设，数值就是计划书 §5 的那一组：

| 预设 | 玻璃（模糊/通透度） | 主屏幕（不透明度/模糊/压暗） | 用途 |
| --- | --- | --- | --- |
| **工作 · Work**（默认） | 12px / 82% | 60 / 12 / 18 | 长时间阅读：图看得见，字不用为它买单 |
| **沉浸 · Immersive** | 10px / 60% | 78 / 8 / 12 | 展示壁纸、短时间浏览，**不是默认**（§5.2） |
| **阅读 · Reading** | 14px / 90% | 45 / 14 / 22 | 长文本、代码审阅（§5.3） |

两条被当成要求而不是偏好的规则：**可读性优先**（§4.2）——每套预设在没有壁纸时也完整（只有玻璃数值），
阅读档最严；**失败属于单个图层**——玻璃先写、壁纸后写，各自返回各自的答案，一个失败不会带走另一个
（"玻璃层拒绝了这个预设"与"壁纸拒绝了这个预设"是两条独立记录）。

面板只加了一个控件（`appearancePreset`，外观卡片里的"阅读预设"），它的选项来自控制器的 `describe()`，
当前选中项是**从两个图层读数反推**的（`presetFor`）：手工调出来的混合值显示为"自定义"，而不是硬凑到最近
的一个预设。IPC：`mega:appearance`（读）与 `mega:appearance-set`（写）；预设落地后会把两层的新状态推给
Dock，避免面板显示一个屏幕上并不存在的玻璃。

测试：`tests/unit/appearance-presets.test.js` 7 项（三套预设且只有一个是默认、数值落在图层会夹取的范围内、
阅读档最严、应用时两个图层各自收到正确数值、玻璃失败不带走壁纸、未知预设按名拒绝、混合值报混合、接线静态断言）。

## 3.5 第六轮：MEGA Control Center 与 Protection 面板（`updateplan/startup2.md` §45–§47）

展开态的 Dock 现在是增强层的**管理面**：[app/extensions/mega/control-center.cjs](../app/extensions/mega/control-center.cjs)
把"Dock 本来就在读的那一份快照"加上保护层与 bundled 插件的两份报告，变成六段数据 ——
**执行 / 自动化 / 资源 / 扩展 / 保护层 / 诊断**，以及一份可操作的模块列表。

三条设计约束，都体现在代码形状里：**只有一份真相**（数值来自旁边那些卡片读的同一份快照，队列数不可能与
队列面板互相矛盾）；**动作来自状态**（§47 —— 健康模块给 `check`/`retry`/`reset-fallback`，被用户禁用的
插件只给 `enable`，未安装的 bundled 插件只给 `repair`，而 `repair` 在 pin 未被标记 tested 时本身就会拒绝；
对任何状态都提供所有动作的界面，就是在承诺图层不会做的事）；**零仍然安静**（§36 —— 故障数为 0 照常显示
`0` 但不带颜色，因为颜色才是吸引注意力的东西）。

面板（[ui/control-panel.js](../app/extensions/mega/ui/control-panel.js)）只渲染：段落 → 行；模块 → 状态 +
版本/启动耗时/重试次数/fallback/最近错误 + 该状态允许的按钮。点击是**一个委托监听**：按钮自己的
`data-control-action` / `data-control-id` 决定做什么，走 `mega:control-action`；被拒绝时把原因显示在面板里，
而不是让整块面板坏掉。诊断段的数字来自 shell 的启动报告（`startup.summary()`），所以"这次启动花了多少、
哪个阶段超预算"在界面里就能看到，不必翻日志。它在功能注册表里也是可关闭的一项
（`mega.control-center`，group `Interface`，panels `controlPanel`）。

测试：`tests/unit/control-center.test.js` 7 项（六段数据同源、零不染色、每个状态允许的动作、bundled 插件动作、
空快照不崩、接线静态断言，以及面板的两条行为：点击到达 shell 并回读、被拒绝时显示原因）。IPC：
`mega:control-center` / `mega:control-action`。

## 3.6 第七轮：启动缓存（`updateplan/startup2.md` §52–§54）

[app/extensions/mega/startup-cache.cjs](../app/extensions/mega/startup-cache.cjs)：一个记住"上一次运行长什么样"的
文件，让启动可以**先恢复、后验证**，而不是每次都全量发现 —— 最近工作区、两个底片的图片与填充、外观数值与
预设、bundled 插件状态、保护层健康、以及这次启动自己的开销。§54 的边界照做：市场**目录**属于市场，这里只记
是否已装、版本与健康。

它不是第二份设置。里面每个事实都有主人（壁纸文件、玻璃文件、商店的已装集合、保护层），缓存只记录"主人们
上次说了什么"并把它当作热启动**提示**读回来；两者冲突时主人是对的、缓存是陈旧的 —— 这正是"先恢复后验证"
的意思。因此它**不写 Harness 的会话 ID**：会话由官方 UI 自己恢复，在这里再存一份只是给同一个问题留一个更旧
的答案。

三条让它安全的性质，都有测试：**读不出来就是空缓存**（缺失、截断、被手工改坏，答案都是"什么都没记住"，
且不抛）；**写入经过临时文件 + rename，失败只是日志**（会在启动中途写坏自己的缓存比没有缓存更糟）；
**它会遗忘**（超过 `maxAgeMs` 的条目仍可读，但不再算热启动，并如实报 `stale`）。

用途落点：Control Center 的诊断段多两行 —— 上次启动缓存（`warm` / `stale` / `cold`）与上次工作区；扩展在
后台记录（`Promise.resolve().then(() => rememberStartup())`，绝不在启动路径上做 IO）。

测试：`tests/unit/startup-cache.test.js` 5 项（记录与读回、缓存不拥有别的键、读不出来即空、过期不再是提示、
写不进去不致命）＋ `control-center.test.js` 的诊断两行与接线断言。

## 3.7 第八轮：界面模式与外观提供者（`updateplan/startup2.md` §43–§44）

设置页的外观卡片现在有**界面模式**：**官方 / 简单壁纸 / Wallpaper Engine**（§43）。
[app/extensions/mega/appearance/providers.cjs](../app/extensions/mega/appearance/providers.cjs) 是这三个选择
背后的分界线：DS-Hns 保留自己的**简单壁纸**（每个底片一张图 + 位置/不透明度/模糊/压暗），高级实现交给社区插件
`dsh-wallpaper-engine`，自己不再重复维护。

三个提供者"对图层做什么"就是它的全部实现：**官方** = 我们不在官方界面之上画任何图（只有玻璃）；**简单** =
我们自己的图层画；**Wallpaper Engine** = 插件在 Harness 内渲染，所以我们这一层让开（否则会盖住它）。三者都不动
玻璃 —— 玻璃是 Dock 的材质，不是背景。

**§44 的两条要求落在 `select()` 的形状里**：插件缺失 / 未测试 / 被用户关闭时，选择社区模式**不安装任何东西**
（描述里 `installsAutomatically: false`），**不把用户挪离当前模式**（`kept`），并把用户真正拥有的两个决定交给
界面 —— 保持官方界面、或去看插件。提示里写明"不会自动安装第三方插件"；"查看插件"接 `mega:open-store`，由 Dock
自带的插件管理器打开商店页（这条通路此前只有监听端，现在两端都在）。

选择与阅读预设都持久化到 `data/state/appearance.json`（与 wallpaper.json、ui-glass.json 同一套规则：读不出来
就是默认值、不认识的取值丢弃并说明、写失败只是日志）。

测试：`tests/unit/appearance-providers.test.js` 7 项（三个提供者且只有社区需要插件、官方基线永远可用、未测试
插件的拒绝保留用户并给出回退与两个动作、用户关闭的插件被如实报告、已安装时经自己的钩子生效、钩子抛错按提供者
回退报告、状态文件的默认/拒绝/降级/容错，以及设置页与 shell 的接线静态断言）。

## 4. 验收怎么读

## 3.8 第九轮：外观 token 白名单（`updateplan/startup2.md` §27）

[app/extensions/mega/appearance/tokens.cjs](../app/extensions/mega/appearance/tokens.cjs)：把"外观提供者允许改什么"
写成一个**封闭清单** —— `--dsh-surface-opacity/blur/tint` 与 `--dsh-wallpaper-brightness/contrast/saturation/darken`。
不在清单里的名字按名字拒绝，数值按各自区间夹取，被接受的部分翻译成两个图层已经在用的数字。

**另一半才是重点**：DOM、组件结构、按钮模板、布局网格、窗口控制、任意 JS 钩子**根本没有词汇**。这不是"奇怪的名字
不太可能出现"，而是让壁纸插件无法演化成前端 fork 的方式；测试逐个断言这些名字被拒绝，并给出可读原因
（"an appearance provider may paint, not take over"）。

它从发布那天起就对我们自己生效：三套阅读预设的数值现在以 token 形式声明（§5 的 亮度 60%/对比度 90%/饱和度 80%/
暗化 18% 等），`apply()` 先过白名单再落到图层 —— 产品不豁免自己发布的边界，预设里写错的 token 会被拒绝并带原因
返回，其余部分照常生效。图层侧也具名：`wallpaper.cjs` 把图片的 filter 作为 `--dsh-wallpaper-*` 写进那一层的文档，
`wallpaper-window.html` 用它们做 `brightness()/contrast()/saturate()`，而 `--dsh-wallpaper-darken` 与图层的
`scrim` 是**同一个数字的两个名字**（`patchKey` 明确这一点），避免"有多暗"出现两个答案。

测试：`tests/unit/appearance-tokens.test.js` 5 项（词表恰为七项、DOM/结构/布局/窗口/脚本名字被拒、未知名字被拒、
数值按区间夹取与非法值被拒、接受后的补丁只到玻璃与图片、CSS 片段带各自单位、空/全拒绝补丁不产生任何东西）＋
预设测试新增"token 与图层数字必须一致"的断言。

## 4. 验收怎么读

## 3.9 第十轮：外观成本账与 `[MEGA]` 日志词表（`updateplan/startup2.md` §55–§57）

§55/§56 关心的两件事都在本产品手里：**模糊了多少屏幕**（计划书点名的 `backdrop-filter: blur(30px)` 这种全屏重度
形状）与**壁纸层要扛多少字节**（内联成 `data:` 的图片就是文件大小那么长的字符串，常驻渲染进程）。

[app/extensions/mega/appearance/cost.cjs](../app/extensions/mega/appearance/cost.cjs) 是一本**账**，不是限流器：
它读取两个图层正在用的数字（玻璃通透度与模糊、两个底片各自的图片负载、在画的图层数），说清代价，并在超出计划书
建议区（§55 的 6–14px）或图片过重时**警告** —— 写进日志，也写进 Control Center 的"资源"段。它**不会**把用户设的
数字夹掉：玻璃滑杆是用户的，一个悄悄夹取的产品等于在谎报屏幕上画了什么；能做的是让代价**可见**，这正是"很重的外观"
与"一个没解释的外观"之间的区别。

落地：`wallpaper.cjs` 的 `windowLayer()`/`dockLayer()` 直接报出各自载荷的字节数（只有那里已经握着 data URL，账本
不必再造一个几兆的字符串）；每次外观变化（`pushWallpaper()`）打印一行
`[PERF] appearance glass=12px/82% pictures=20KB layers=1 warnings=…`（§57）；Control Center 资源段多三行 ——
玻璃模糊、图片负载、性能警示（无警示时是绿色 `none`）。

§57 的日志词表也统一了：保护层现在用 `[MEGA]` 前缀 —— `[MEGA] protection-ready`、
`[MEGA] module healthy|degraded: <id> — <原因>`、`[MEGA] fallback: <id> → <回退>`，一次 grep 就能回答"哪个增强模块
不健康、现在由谁顶着"。

**§56 的性能测量是真的、可跑的**：`scripts/appearance-cost-acceptance.cjs` 用真实模块在自己的临时状态里量两个
能造出来的场景（无壁纸 / 静态壁纸），读 Electron 自己的 `app.getAppMetrics()`（每进程 CPU、内存）与那一层的图片
载荷，并**把造不出来的场景按名字跳过并给出原因**（1080p/4K 视频与 scene 属于社区插件；market 打开不是这一层的
成本；MEGA 展开由运行中的产品测量）——而不是给它们编一个数字。示例输出：

```
no wallpaper           cpu=    0%  ram=  482MB  processes=4  picture=0KB
static wallpaper       cpu= -0.1%  ram=  479MB  processes=4  picture=3752KB  (2814 KB picture)
1080p video            skipped: the community plugin renders video (§24)
```

测试：`tests/unit/appearance-cost.test.js` 5 项（数字与一行日志、模糊两档警告且不夹取、超重图片被报告、空外观零成本
且未知不可写成 0、两个图层都报字节数），`mega-protection.test.js` 新增 `[MEGA]` 词表断言，Control Center 测试新增
成本三行。

## 4. 验收怎么读

## 3.10 第十一轮：表面归属（`updateplan/startup2.md` §48、§55 的 CSS ownership）

三条边界本来是**惯例**，现在是被测的**约束**（`tests/unit/surface-ownership.test.js`）：

1. **Dock 能调的每个通道都有主人。** preload 是 Dock 全部的可达面；它能 invoke/send 的通道必须由某个模块
   声明 —— mega 扩展自己的 `CHANNELS`，或 shell 的四个功能族（`computer-use`/`engineering`/`plugins`/
   `sub-worker`）。没有主人的通道意味着清点与功能闸门都不知道它存在，而"被删掉的功能还能用"正是这样发生的。
   preload 里也不允许**动态拼接**通道名（那样就无法被审计）。
2. **只有外观词汇能跨边界。** `--dsh-*` 是发布出来并被校验的那一套（§27）；它属于 `appearance/` 目录本身、
   把图片 token 写进自己文档的 `wallpaper.cjs`，以及消费它们的那份图层文档 —— 其它任何文件出现 `--dsh-` 都是越界。
3. **一份样式表只属于一份文档。** Dock 的样式表不碰图层文档的私有元素与私有变量（`#wallpaper-scrim`、`#wp-`），
   图层文档也不碰 Dock 的（`#rail`、`#detail`、`.panel`）。

§48 的目录映射记录在此：`mega/protection/`（Supervisor/健康/超时/重试/回退/诊断的合并实现）、
`mega/plugins/`（bundled 管理器 + 清单 + 安装/修复策略）、`mega/appearance/`（提供者、预设、token 边界、
成本账、状态文件），而 §48 里的 `execution / automation / resource-policy / diagnostics` 在本仓库是
`control-center.cjs` 的**六段数据**而不是六个目录 —— 它们共享同一份快照，拆成目录只会让"同一份真相"
变成六份需要同步的东西。

**一处有意的偏差**：§6.2/§25 建议删除"复杂 Video Pipeline"，但视频目前仍是**自有图层唯一能播的东西**，
而社区插件尚未被采纳（其 pin 仍等一次真机测试）。删掉它会在替代品到位之前先失去一个可用能力，因此本轮
**保留**，并在此记录：等 `dsh-wallpaper-engine` 的 pin 被标记 `tested: true` 之后，这段代码才该删。

## 4. 验收怎么读

- `tests/unit/startup.test.js`：状态顺序、预算记录、`defer` 的故障隔离、`onInteractive`、
  `ENHANCED` 只在延迟工作落定后出现，以及**启动顺序**（骨架先于 Harness、可选层全部晚于
  INTERACTIVE）。
- `scripts/verify.ps1`：启动模块与骨架页存在、骨架页无脚本、启动顺序成立。
- 真机看 `logs/desktop-runtime.log` 的 `[BOOT]` 行；`boot report` 那一行是机器可读的全量报告。
