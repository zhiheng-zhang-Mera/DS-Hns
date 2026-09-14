# Changelog

All notable changes to DS-Hns. Newest first. Each entry names the user-visible
behaviour that changed, not the files that were touched.

## bundled plugins — 安装调用接线，采纳只剩一次真机测试（updateplan/startup2.md §22–§23）

**`installPinnedPlugin()` 用商店自己的两步安装清单钉住的引用**：`stage({ source, branch: ref })` 把代码放到磁盘
并校验清单，`enable({ id })` 记录宿主可以运行它。函数只决定"要哪个引用"，不决定任何安装策略；因此把第一个 pin
标记 `tested: true` 就是社区插件采纳的全部工作量。

**一个诚实的限制，而不是没写的代码**：商店按分支或 tag 落盘（`git clone --branch`），而 `2BingLing/dsh-market`
没有 tag，它的 pin 是**提交**。提交 pin 会被**按名字拒绝**（`needs a revision-aware stage first`），而不是悄悄
装成默认分支当时的 HEAD；修法是商店支持 revision 感知的 stage —— 那是它的安装路径，不能从这里猜。

**验证**：`tests/unit/bundled-plugins.test.js` 10/10（原 9 项 + 安装调用与提交 pin 拒绝的断言）；
`scripts/verify.ps1` 的既有检查覆盖清单真实性、不追 latest 与未测试不安装。

## appearance tokens — 提供者可以画，不能接管（updateplan/startup2.md §27）

**新增 `app/extensions/mega/appearance/tokens.cjs`：外观提供者允许改什么，是一个封闭清单** ——
`--dsh-surface-opacity` / `--dsh-surface-blur` / `--dsh-surface-tint` /
`--dsh-wallpaper-brightness` / `--dsh-wallpaper-contrast` / `--dsh-wallpaper-saturation` / `--dsh-wallpaper-darken`。
不在清单里的名字按名字拒绝，数值按各自区间夹取，被接受的部分翻译成两个图层已经在用的数字。

**另一半才是重点**：DOM、组件结构、按钮模板、布局网格、窗口控制、任意 JS 钩子**根本没有词汇**。这不是"奇怪的名字
不太可能出现"，而是让壁纸插件无法演化成前端 fork 的方式；测试逐个断言这些名字被拒绝，并给出可读原因。

**它从第一天起就对我们自己生效**：三套阅读预设的数值现在以 token 形式声明（§5 的 亮度 60% / 对比度 90% /
饱和度 80% / 暗化 18% 等），`apply()` 先过白名单再落到图层 —— 产品不豁免自己发布的边界，预设里写错的 token 会被
拒绝并带原因返回，其余部分照常生效；预设测试还断言 token 与图层数字必须一致，防止两套说法漂移。图层侧也具名：
`wallpaper.cjs` 把图片 filter 作为 `--dsh-wallpaper-*` 写进那一层文档，`wallpaper-window.html` 用它做
`brightness()/contrast()/saturate()`，`--dsh-wallpaper-darken` 与图层的 `scrim` 是同一个数字的两个名字
（`patchKey` 明确），避免"有多暗"出现两个答案。

**验证**：`tests/unit/appearance-tokens.test.js` 5/5（词表恰为七项、DOM/结构/布局/窗口/脚本名字被拒、未知名字被拒、
数值夹取与非法值被拒、接受后的补丁只到玻璃与图片、CSS 片段带单位、空或全拒绝的补丁不产生任何东西）；全量
1421/1422（唯一失败是负载敏感的 `multi-supervisor` 并行计时断言）；`scripts/verify.ps1` 增加词表、接管拒绝与
"同一数字两个名字"的检查。

## appearance modes — 官方 / 简单壁纸 / Wallpaper Engine（updateplan/startup2.md §43–§44）

**设置页的外观卡片新增"界面模式"**：**官方 / 简单壁纸 / Wallpaper Engine**。新增
`app/extensions/mega/appearance/providers.cjs` 划出这条分界线：DS-Hns 保留自己的简单壁纸（每个底片一张图 +
位置/不透明度/模糊/压暗），高级实现交给社区插件 `dsh-wallpaper-engine`，自己不再重复维护一套高级渲染器。

三个提供者"对图层做什么"就是它的全部实现：**官方** = 我们不在官方界面之上画任何图（只剩玻璃）；**简单** =
我们自己的图层画；**Wallpaper Engine** = 插件在 Harness 内渲染，因此我们这一层让开（否则会盖住它）。三者都不动
玻璃——玻璃是 Dock 的材质，不是背景。

**§44 的两条要求落在 `select()` 的形状里**：插件缺失/未测试/被用户关闭时，选择社区模式**不安装任何东西**
（描述里明确 `installsAutomatically: false`），**不把用户挪离当前模式**（`kept` 字段），并把用户真正拥有的两个
决定交给界面——保持官方界面、或去看插件。提示里写明"不会自动安装第三方插件"；"查看插件"接到 `mega:open-store`，
由 Dock 自带的插件管理器打开商店页（这条通路此前只有监听端，现在两端都在）。

选择与阅读预设都持久化到 `data/state/appearance.json`（与 wallpaper.json、ui-glass.json 同一套规则：读不出来
就是默认值、不认识的取值丢弃并说明、写失败只是日志）。

**验证**：`tests/unit/appearance-providers.test.js` 7/7（三提供者且只有社区需要插件、官方基线永远可用、未测试
插件的拒绝保留用户并给出回退与两个动作、用户关闭被如实报告、已安装时经自己的钩子生效、钩子抛错按提供者回退、
状态文件的默认/拒绝/降级/容错，以及设置页与 shell 的接线断言）；`scripts/verify.ps1` 增加提供者存在性、
不自动安装、拒绝保留用户、选择持久化与设置页入口检查。

## startup cache — 先恢复，后验证（updateplan/startup2.md §52–§54）

**新增 `app/extensions/mega/startup-cache.cjs`：记住上一次运行长什么样，让启动先恢复、后验证**，而不是每次
全量发现。记录：最近工作区、两个底片的图片与填充方式、外观数值与预设、bundled 插件状态、保护层健康、本次
启动自己的开销。§54 的边界照做——市场**目录**属于市场，这里只记是否已装、版本与健康。

**它不是第二份设置**：里面每个事实都有主人（壁纸文件、玻璃文件、商店已装集合、保护层），缓存只记录主人们
上次说了什么，并当作热启动**提示**读回；冲突时主人是对的、缓存是陈旧的。因此它**不写 Harness 的会话 ID**
——会话由官方 UI 自己恢复，再存一份只会给同一个问题留一个更旧的答案。

三条让它安全的性质（都有测试）：**读不出来就是空缓存**（缺失/截断/改坏都答"什么都没记住"且不抛）、
**写入经临时文件 + rename，失败只是日志**（能把自己写坏的缓存比没有缓存更糟）、**它会遗忘**（超过
`maxAgeMs` 仍可读但不再算热启动，并如实报 `stale`）。

落点：Control Center 诊断段多两行（上次启动缓存 warm/stale/cold、上次工作区），扩展在后台记录（绝不在启动
路径做 IO）。**验证**：`tests/unit/startup-cache.test.js` 5/5（记录与读回、不拥有别的键、读不出来即空、
过期不再是提示、写不进去不致命）＋ Control Center 的诊断行与接线断言；`scripts/verify.ps1` 增加缓存存在性、
遗忘、容错与"不保存会话"的检查。

## control center — 增强层的管理面与保护面板（updateplan/startup2.md §45–§47）

**展开态的 Dock 现在是增强层的管理面。** 新增 `app/extensions/mega/control-center.cjs`：它把"Dock 本来就在读
的那一份快照"加上保护层与 bundled 插件的两份报告，变成六段数据 —— **执行 / 自动化 / 资源 / 扩展 / 保护层 /
诊断**，以及一份可操作的模块列表。因此面板里的数字不可能与旁边的队列/硬件卡片互相矛盾。

**动作来自状态（§47）**：健康模块给 `check` / `retry` / `reset-fallback`；被用户禁用的插件**只**给 `enable`
（不提供任何绕过用户决定的入口）；未安装的 bundled 插件只给 `repair`，而 `repair` 在 pin 未被标记 tested 时
本身就会拒绝。一个对任何状态都提供所有动作的界面，就是在承诺图层不会做的事。**零仍然安静**（§36）：故障数
为 0 照常显示 `0`，但不带颜色。诊断段显示启动报告（阶段数、状态、本产品开销、超预算阶段），所以"这次启动
花了多少、卡在哪个阶段"在界面里就能看到。

面板（`ui/control-panel.js`）只渲染、不持有状态；点击是一个委托监听，按钮自己的 `data-control-action` /
`data-control-id` 决定做什么，走 `mega:control-action`；被拒绝时显示原因而不是让面板坏掉。它在功能注册表里
也是可关闭的一项（`mega.control-center`）。

**验证**：`tests/unit/control-center.test.js` 7/7（六段数据同源、零不染色、每个状态允许的动作、bundled 插件
动作、空快照不崩、接线静态断言，以及面板行为：点击到达 shell 并回读、被拒绝显示原因、无桥接时说明原因）；
`scripts/verify.ps1` 增加六段数据、动作来自状态、面板与修复入口、通道端到端检查。

## appearance — 阅读预设：对两个图层的一个决定（updateplan/startup2.md §26–§28、§5）

**新增 `app/extensions/mega/appearance/index.cjs`：三套阅读预设，数值就是计划书 §5 的那一组。** 两个图层
早就存在（壁纸：每个底片一张图 + 不透明度/模糊/压暗；磨砂玻璃：Dock 的材质），缺的是对它们的一个决定：
**工作 · Work**（默认，玻璃 12px/82%，主屏幕 60/12/18）、**沉浸 · Immersive**（玻璃 10px/60%，主屏幕
78/8/12——展示壁纸用，明确不是默认）、**阅读 · Reading**（玻璃 14px/90%，主屏幕 45/14/22——长文本与代码审阅）。

两条被当作要求而不是偏好的规则：**可读性优先**（每套预设在*没有壁纸*时也完整，阅读档最严）；**失败属于
单个图层**（玻璃先写、壁纸后写，各自返回各自的答案，一个失败不带走另一个——"玻璃层拒绝了这个预设"和
"壁纸拒绝了这个预设"是两条独立记录）。

面板只多一个控件（外观卡片里的"阅读预设"）：选项来自控制器的 `describe()`，当前选中项是**从两个图层读数
反推**的，手工调出的混合值显示为"自定义"而不是硬凑到最近的预设；预设落地后把两层的新状态推给 Dock，避免
面板显示一个屏幕上不存在的玻璃。IPC 为 `mega:appearance` / `mega:appearance-set`。

**验证**：`tests/unit/appearance-presets.test.js` 7/7（三套预设只有一个是默认、数值在图层会夹取的范围内、
阅读档最严、应用时两层各收到正确数值、玻璃失败不带走壁纸、未知预设按名拒绝、混合值报混合、接线静态断言）；
`scripts/verify.ps1` 增加预设存在性、无壁纸可用、逐层失败与接线检查。

## mega rail — 折叠栏去重，且不再是一条状态栏（updateplan/startup2.md §36–§44）

**折叠栏从五个固定方框变成注册表驱动的条目。** 旧形状是"每个数字一个方框、dock 脚本按 id 填数"：新增一个
数字要动三个文件，删一个也要动三个文件，而且 dock 必须知道 `RUN` 是什么意思——这正是它慢慢长成第二条状态栏
的原因。现在 `app/extensions/mega/mega-items.cjs` 让模块自己注册条目
（`registerMegaItem({ id, priority, current })`），`current(snapshot)` 返回 `null` 就是"我没什么要说的"。

于是计划书的两条规则成了机制：**零不是新闻**（§36/§43，空队列/零重试/零错误不出现），**折叠栏有预算**
（§44，最多 5 项，按 priority 排序，装不下的渲染成 `+N` 指向展开态）。去重落点：`RUN` 明确为 **DS-Hns 自己的
worker slot 占用数**（官方 UI 不显示这个数）；`HW` 改名为 `WKR`（并发/硬件上限，就是它真正的含义）；
`SUB` 由 `AUTO` 取代（显示"自动委派"这个用户开关，而不是再抄一遍 agent 状态）；`Q` 与 `ERR` 只在非零时出现；
**峰谷芯片移出折叠栏**（电费时段属于展开态的账单卡片，不是资源策略）；新增 `EXT` = 保护层中降级的可选模块数。

dock 只渲染、不理解条目含义，`features.cjs` 也去掉了 `railPeak`。四个原先钉住旧方框的测试同步更新为新的
契约（折叠栏是容器 + 模板、由 `snapshot.megaItems` 驱动、子 worker 的"一眼可见"状态回归面板本身）。

**验证**：`tests/unit/mega-items.test.js` 5/5（排序、零即静默、预算与 overflow、坏条目不影响整条栏、
id 不可重复、注册表驱动接线）；受影响的 dock/sub-worker/架构测试 69/69；`scripts/check-syntax.cjs` 220/220。

## bundled plugins — 本体自带的社区插件，版本钉死、失败归面板（updateplan/startup2.md §19–§23）

**新增 `app/extensions/mega/plugins/index.cjs`：MEGA 自己管"随本体提供、工程上仍是可选社区插件"的两个插件。**
它是一个**策略层**——不 clone、不写插件目录、不读 package.json，只对注入进来的安装器与注册表做判断，因此
§23 那张状态表（缺失 / 未测试 / 已安装 / 版本超前 / 不兼容 / 用户禁用 / 失败）可以完全离线测试。

**清单是真的、版本是钉的**（§21/§22）：`dsh-wallpaper-engine` 钉在真实存在的 `v0.7.1` tag，
`@dsh-market/plugin` 钉在 `2BingLing/dsh-market` 的 `master` 提交（该仓库没有 tag，提交就是它的版本）。
没有任何一处会问"最新是什么"——否则昨天测过的产品会和今天没测过的产品长得不一样，而没有人做过这个决定。

**没测过的版本不会被装上**：两个条目都是 `tested: false`，管理器据此报 `untested` 并**拒绝安装**。
`repair()` 拒绝得更直白：不能凭空把一个未测试的 pin 装上去。**用户说了算**：被禁用的插件不装、不修、
不复活；清单不认识的版本只被报告（`ahead-of-pin`）而不被替换——用户可能是有意装的。**失败属于面板**：
两个插件都注册成 protected module，fallback 是 `Simple Wallpaper` 与"商店入口隐藏"。

**接线**：MEGA 在 `start()` 注册受保护模块、在后台跑策略（绝不在启动路径上等网络），读取商店自己的记录
判断"是否已安装、是否被用户禁用"，并暴露 `mega:bundled-plugins` / `mega:bundled-plugins-repair` 两个通道；
shell 把保护层交给扩展。**两个诚实缺口**：① 今天不会安装任何插件（没有 pin 被标记 `tested`）；② 安装调用
本身尚未注入——猜一个安装器参数名等于把未验证代码放进可选插件的安装路径，它随"第一个 pin 被测试并标记"的
那次提交一起落地。两处都在代码注释、`docs/startup.md` §3.2 中写明。

**验证**：`tests/unit/bundled-plugins.test.js` 9/9；`scripts/verify.ps1` 增加清单真实性、不追 latest、
未测试不安装、用户禁用与未知版本的处理、受保护注册与"策略不在启动路径上"的检查。

## protection — MEGA 成为增强层的控制平面（updateplan/startup2.md §12–§18）

**新增 `app/extensions/mega/protection/index.cjs`：可选模块的隔离、健康、降级与回退有了一处统一实现。**
MEGA 从"右侧状态栏"变成增强能力的**控制平面**，规则只有一条：任何可选模块都必须注册后由它启动，不允许
裸启动。六态为 `DISABLED / STARTING / HEALTHY / DEGRADED / FAILED / RECOVERING`，每个模块记录状态、版本、
启动耗时、最近错误、重试次数与 fallback 现状——这正是 MEGA 面板要显示、验收要读的东西。

`start()` **只回答、不抛出**：超时、抛错或自己报告不健康都变成 `DEGRADED` 并立刻跑 fallback。计划书点名
禁止的三件事（插件失败导致白屏、壁纸失败带走输入框、Market 失败让 Harness 起不来）因此是结构上不成立的，
而不是靠小心。首启预算默认 3s，超时不再阻塞任何 UI；重试阶梯是一次快速、一次延迟、然后停止（无限重试正是
掩盖真实故障的方式）；回退链写成数组逐级尝试（如 `dsh-wallpaper-engine → Simple Wallpaper → Official
Background`），最后一级也失败就如实报 `unavailable`。健康检查重新通过时状态回到 `HEALTHY` 并清掉错误，
否则面板会一直报告模块已经离开的状态。

**接线（本轮补上）**：`desktop-main.cjs` 现在创建 protection 层并注册三个可选模块（`wallpaper-layer`、
`mega-extension-host`、`mega-dock`），它们的启动仍走启动状态机（`[BOOT]` 阶段不变），状态与失败由保护层
持有；启动结束多一行 `[protection] {...}` 全量报告。一个模块失败时，boot 只看到「这一项降级了」。

**边界**：社区插件
`dsh-wallpaper-engine` / `@dsh-market/plugin` 的接入、MEGA Control Center 的 Protection 面板、`MegaItemRegistry`
前端注册、启动缓存与折叠栏去重都**未做**，条目记在 `docs/startup.md` §3.1，下一轮接线时一并更新文档与
`verify.ps1`。

**验证**：`tests/unit/mega-protection.test.js` 6/6（健康启动、超时→降级+fallback、重试阶梯恰好三次、
不健康→降级与恢复、可选与必需的区别及安全停止、`withTimeout` 两个方向）；`scripts/verify.ps1` 增加
保护层存在性、六态、预算/回退/重试与上报字段检查。

## startup — 先可用，再好看（updateplan/startup.md 的 P0）

**"应用可用"不再绑定在"全部增强渲染完成"上。** 旧流程在窗口显示之前要等完 Harness、扩展宿主、
再到 dock 渲染器 —— 于是"某个可选模块很慢"和"产品根本没启动"在用户眼里完全一样：一个没有反馈的
空窗口（实际上是隐藏窗口，连空白都看不到）。现在窗口创建后**立刻**显示我们自己的骨架页
（`app/splash.html`：顶栏/侧栏/会话区/输入框占位，无脚本、无网络、无控件），官方 UI 就绪后替换它。

**四条状态，INTERACTIVE 就是启动完成**（`app/startup.cjs`）：`BOOTING → CORE_READY → INTERACTIVE
→ ENHANCED`。`CORE_READY` = 官方页面成为窗口页面；`INTERACTIVE` 紧随其后 —— 我们不去探测官方 DOM
（产品硬规则），所以"它加载完并在屏幕上"就是诚实的定义。之后的一切都走 `startup.defer()`：壁纸层、
扩展宿主、Mega dock、重启恢复、子 worker 自启动。它们**不会**拒绝、**不会**延迟用户、**不会**让启动
失败，每个都有自己的记录，失败只写 `failed: <原因> (the boot carries on)`。全部落定才标记 `enhanced`。

**启动有账可查。** 每个阶段一行 `[BOOT] <阶段> <耗时>`，并标注预算与是否超标；预算只记录、不强制
（错过预算仍是能用的启动）。最后一行 `boot report` 是机器可读的全量报告，其中 `ownOverhead()`
是"Harness 给出地址 → 用户可以工作"的时间 —— 这一段才是本产品自己拥有的墙钟，Harness 自身的启动
不是。

**边界写清楚**：本轮只做 P0 与部分 P1。三套阅读预设、社区壁纸插件 `dsh-wallpaper-engine` 与
`AppearanceProvider` 抽象、对外 Appearance token 白名单、设置页重组、MEGA 折叠态去重（仍是
RUN/QUEUE/HW/SUB/PEAK 五个常驻项）都**没有**做，条目与现状记在新增的 `docs/startup.md` 里，避免下
一轮把它们当成已完成。

**验证**：新增 `tests/unit/startup.test.js`（状态顺序、预算记录、`defer` 的故障隔离、
`onInteractive`、`ENHANCED` 只在延迟工作落定后出现，以及启动顺序：骨架先于 Harness、所有可选层晚于
`interactive`）；`scripts/verify.ps1` 增加启动模块与骨架页检查（骨架页必须无脚本、启动顺序必须成立）。

## wallpaper — 壁纸真的垫在整个界面上，而官方 UI 仍然可点

**修的是一个用户直接感受到的缺陷：设了壁纸之后，官方 UI 点不动了。** 上一轮的壁纸层是一个压在官方
页面之上的 `WebContentsView`。本构建（Electron 43.4.0）的 `View`/`WebContentsView` **没有任何输入
API** —— `setIgnoreMouseEvents` 只存在于 `BrowserWindow`/`BaseWindow`（`View` 一共 9 个方法，实测列表见
`scripts/wallpaper-hit-test.cjs` 的运行输出）—— 所以那一层画得完全正确，同时吃掉了官方 UI 的每一次
点击：点击、滚轮、选区全部落进它的矩形，而它自己没有控件，于是什么都不发生。原有验收看不见这件事：
它用 CDP 把事件直接注入官方渲染器，**绕过了窗口层的命中测试**，对"视图吃掉点击"这一类缺陷是盲的。

**修法是换形状，不是加开关。** 壁纸现在是 `app/wallpaper-window.cjs`：无边框、透明、不可聚焦、
不占任务栏、`showInactive()` 的子窗口，创建时 `setIgnoreMouseEvents(true)`，并带一条硬互锁 ——
**构建一旦拒绝让它穿透输入，它就永不上屏**（"能吃掉点击的一层"比"没有壁纸"更糟）。它只画官方页面
之上需要的那一层：整幅图片与压暗；Dock 自己的矩形被 `clip-path` 从这幅图里切掉，由 Dock 用同一套
窗口坐标自己画（`--hns-wallpaper-origin-*`），所以 Dock 边界两边的图片是**同一张**、接着的，而不是
两张不同裁切的图。窗口是懒创建的：没有图片就没有窗口。

**顺带修掉一个更安静、也更根本的缺陷：图片其实从来没画上去过。** `insertCSS` 插进来的样式表排在
文档自己的样式表**之前**，所以文档里那句 `:root { --wp-image: none }`（和其它默认值）以同等优先级
赢了被插入的答案 —— 壁纸被正确读取、正确编码、正确交给那一层，然后被文档的默认值覆盖掉。修法是
一行：shell 写的选择器是 `:root:root`（同源、同重要级，更高的优先级），并在两处都写清为什么。
这条同样是实测出来的：普通 `:root` 插入输给文档，`:root:root` 插入赢。官方外壳/覆盖层的主题样式
（`official-surface-views.cjs`）用的是同一个机制，因此同样被修正。

**换一张大图只有 Mega 会变，也是同一个 bug 家族 —— 而且这次是图片自己太大。** 图片原本通过一个
CSS 自定义属性传给主屏幕那一层（`--wp-image: url("data:…")`）。实测：自定义属性的值在 **1.25 MB 能到、
2 MB 到不了**（读回来是空的），而同样几兆字节放进一条普通声明的 `url()` 里，6 MB 也能到并生效。于是
一张 2.7 MB 的照片会让 `background-image: var(--wp-image)` 在计算时变成非法、回退成 `none`：主屏幕
什么都不画，而 Mega 照常变 —— 因为 Dock 是把图片直接设在元素上的。修法：图片改成**直接声明**
（`#wallpaper { background-image: url(… ) !important }`），不再经过自定义属性。

**主屏幕与 Mega 的底片现在分别设置。** 状态文件从"一张图一套参数"变成
`{ enabled, main: {…}, dock: {…} }`：主屏幕（官方界面之上那一层，Dock 的矩形被切掉）和 Mega（侧栏自己
画的那一张）各有自己的文件、填充方式、不透明度、模糊、压暗，某一侧没有图片（`null`）就是"这一侧不画"。
外观面板的壁纸卡片多了一个**作用范围**选择器：`两处一起 / 主屏幕 / Mega 界面`，下面的选择文件与滑杆
都作用于选中的范围。**旧的状态文件仍然照旧工作**：一张图一套参数的形状被读成"两侧都继承它"，
而扁平的调用（`set({ file })`）也仍然表示"两处一起"，所以旧面板代码和验收脚本没有被抛下。
两张不同的图时，Dock **不再**按整窗坐标对齐（那会让侧栏显示自己那张照片的一个碎片），而是按侧栏自己的
框铺满；只有当两侧是同一张图时，它们才拼成一整张、在切口处接得上。

**"完整垫在整个应用界面"现在是真的**：图片以窗口内容框为基准 `cover`/`contain`/`tile`，覆盖整个界面
——包括官方 UI，以及 Dock 让给官方标题栏的那条带；Dock 只在自己的矩形里负责它那一块。`DSH_OFFICIAL_OVERLAY=0`
仍然是"官方界面之上什么都不画"。

**验证**：新增一对可运行的验收工具（两个都只用自己的临时状态文件，绝不碰用户自己的壁纸设置）。
`scripts/wallpaper-hit-test.cjs`（配 `scripts/hit-test-window.ps1`）
用 Windows 自己的
`WindowFromPoint`（它会跳过对鼠标透明的窗口）做三步实测：① 没有层时命中官方页面；② 层在上且
`setIgnoreMouseEvents(true)` 时**仍然**命中官方页面；③ 把同一个窗口的穿透关掉后，命中的就是那一层
本身 —— ③ 是否定对照，它让 ② 成为测量而不是巧合。`scripts/wallpaper-render-acceptance.cjs` 用真实
模块跑"画上去"这一半：`wallpaper.cjs` 生成样式表 → `wallpaper-window.cjs` 上屏 → 读回文档的计算样式
（图片、不透明度、`clip-path` 顶点顺序）→ 把那一层截图逐像素映射成形状（上面整幅、Dock 矩形为空），
然后**再换一张 2.7 MB 的照片重来一遍**：这一半正是"小图标能画、大照片默默不画"的唯一检查点。
两个工具当前都是 PASS（退出码 0）。单测另外钉住互锁、`focusable:false`、文档无脚本、窗口坐标对齐、
`clip-path` 的顶点顺序、两个底片互不影响、"同一张图才按整窗对齐"，以及"没有图片就没有窗口"。

## plugins — 插件化运行时与单任务加速（Update-Plan/accleration.md）

**DS-Hns 从"靠 require 互相引用的一堆功能"变成"可插拔的能力平台"，并在同一任务内加速。**
新增插件运行时：契约 `dshns.plugin/v1`、插件管理器、能力注册表、事件总线、配置分层、
资源管理器与健康监督器。插件**只依赖能力，不依赖插件 id**（长时 worker 不再 import 检查点，
而是 require `checkpoint` 能力），能力表是封闭且带 fallback 的（`repo-map` 关掉就退化为文本搜索、
`command-cache` 关掉就每次都跑、`workspace-isolation` 关掉就拒绝并行写）。插件有四个独立状态
（installed / enabled / loaded / healthy）与三个故障等级（SOFT / DEGRADED / FATAL），
**没有任何加速器是 FATAL** —— 关掉 computer-use 仍然能写代码，telemetry 崩了任务继续，
repo-map 重启不会拖走 worker。

加速器：**repo map**（一次扫描回答"定义在哪/谁引用/依赖谁/改动会波及谁/该跑哪些测试"，
陈旧即重建，绝不假设）、**dirty context**（稳定前缀在前，预算超了就"申报丢弃"而不是静默丢）、
**reasoning governor**（难度决定档位，问题解决后自动降回，不让一次硬任务把整段会话钉在最高档）、
**tool batching**（读操作合并成一次往返，**写操作永不合并**）、**command cache**（命令+相关文件哈希+
环境指纹全一致才复用，失败结果永不缓存）、**persistent tools**（shell/LSP/浏览器/model server 跨步保活；
句柄绝不凭信任复用、绝不永生、满了就明确拒绝而不是偷偷关掉正在用的会话）、
**incremental validation**（三级验证，只有全量级才能批准完成）、**patch-first**（AST > 定向补丁 > FIM >
整文件重写，小改动遇到大文件直接**拒绝重写**并说明理由）。

**单任务并行**：把同一任务的依赖 DAG 排成 wave/lane —— 读并行、**写集不相交**才并行、
重叠写默认串行（读-写同文件也视为冲突，否则任务会变得 flaky）。Aggressive 是唯一例外：
每个重叠写者拿到自己**已验证的 git worktree**，并明确报 `requiresIntegration` 而不是让最后一个
写者静默获胜；isolation 不可用就退化为串行，中途被拒就明确停止，绝不退回共享工作树。
模型调用在所有模式下都走**同一个队列**（任务并行 ≠ 模型并行）。

`node scripts/combined-acceptance.cjs` 一次跑完两半验收并给出证据：**A** 插件平台（逐个关掉仍能工作）、
**B** 同一任务在 Off/Safe/Adaptive 下的墙钟/模型调用/回滚/正确率对比、**C** 同一 commit 同一任务的
baseline vs optimized（Time To Accepted Patch）、**D** 九类故障注入（模型超时、shell 崩溃、工具超时、
测试失败、UI miss、插件失败、context 重建、git 冲突、进程重启）、**E** 工程运行时 §150 的 26 条完成条件
（每条绑定到真正通过的那个测试名）。B/C 的任务是真的：临时仓库里真的有一个失败测试、真的打一行补丁、
真的跑 `node --test`。测不出来的地方就说明原因：不调用真实模型，所以 Time To Accepted Patch 使用
**声明的**每次调用延迟，真正测量的是每种配置的往返次数。CI 每次推送都会跑这份验收。

**工作台 UI**：新增 Plugins 面板，按计划书分组（Execution / Autonomy / Coding / Performance /
Observability）列出插件，并把四个状态**分开显示**（installed / enabled / loaded / healthy）——
"关掉了"和"坏掉了"是两个不同答案，一个复选框会把它们糊在一起。点开任一插件可看版本、API 版本、
状态、健康（带原因）、延迟、能力、必需/可选依赖（缺哪个会标出来）、带来源层的配置、最近的故障与
重启次数，并可 Enable/Disable、Restart、单插件体检、写 lockfile。Execution 区是计划书 §45 的那组
设置（模式 / 最大 worker / 并行读·测试·模型调用·写 / workspace isolation / CPU·RAM·GPU 上限），
每项都标出取值来自哪一层，并显示当前模式下模型的"实际并行度"与资源管理器给出的 worker 决策。
面板是**控制面**而且这一点是被强制的：它拿不到插件对象、不能指定要提供哪个能力、不碰文件，只能按
**id** 请 shell 去 enable / restart / 重新配置；提交写的 gate 会断言面板只经由 `window.megaPlugins`
访问平台，且自身不含任何文件系统或进程调用。设置写进平台本来就读的地方（`config/plugins/<id>.json`
——配置管理器里"用户对这个插件做的决定"那一层），随后重建插件世界，因此面板显示的就是运行时在用的；
非法值（未知键、越界、类型错）不会写入任何东西，并带着原因返回。

**插件 lockfile**：新增 `dshns-lock.yaml`（计划书 §40）记录插件集合与版本，用于复现稳定环境。
格式是 YAML 但只接受解析器真正理解的那一种形状：多一个顶层键、重复 id、缺版本、写成列表，都会
带行号明确拒绝而不是猜——一个"看不懂就跳过"的 lockfile 解析器会报告一份从未被检查过的稳定性。
`verify` 会对比锁文件与实际安装集合，逐条报出 added / removed / changed；当 `plugins.enforceLock`
打开时漂移是**拒绝加载**，而不是一句警告。随仓库提交的 lockfile 由测试对实际集合做断言，所以它
不会在 CI 绿着的时候悄悄过期。

## engineering — 24h 自主代码维护运行时（Update-Plan/24h-1.md）

**DS-Hns 从"能执行动作"扩展为"能在无人干预下持续维护一个代码仓库"。** 新增 `app/engineering/`：
一个 episode 接收仓库路径与目标，验证 workspace、发现项目类型与工程命令、读取仓库内的
AGENTS.md/CLAUDE.md/CI 等约束、在改动前建立 baseline（并保护用户已有的未提交修改）、生成有界
工程计划（修 bug 的任务必须先复现失败）、通过 mutation 记录每一次写入并在写后重读校验、在
分类后的真实失败上做有界修复（不盲重试、不重复已验证失败的假设）、监督 build/test/服务的
子进程（就绪靠端口/HTTP/stdout 条件，长任务靠输出判活而非墙钟）、按 focused/affected/full
三级跑真实验证并要求证据晚于最后一次改动、周期性 checkpoint 并支持崩溃后按证据恢复、
按 episode 预算划分 deadline band，最后必须通过 result validator 才能报 COMPLETED ——
"模型说完成"不算证据。项目适配器覆盖 Node/Python/Rust/Go/Java/.NET/CMake/Make 与 generic
兜底，破坏性 git 命令（reset --hard、clean -fd、force push、改历史）**根本没有实现**。

## computer-use — 长时间运行执行（Update-Plan/24h.md Tasks 1–20）

**Computer Use 运行时从"能把一个任务做完"收束成"能长时间可靠地执行开发动作"。** 新增长时运行
执行层：焦点信任、弹窗 fail-safe、自适应有界稳定、按风险分级的证据、有意义的进度心跳、有界
stall 阶梯、自有进程监管、资源上限、控制器故障隔离、有界重连、workspace 连续性、文件变更
验证、有界命令契约、resume-safe 步边界、日志卫生与自检健康快照。原则不变：**只根据当前状态
适应，绝不学习任何应用。**

* **焦点信任（Task 1）**：尝试聚焦 ≠ 已验证聚焦。只有验证成功才写入 trusted focus；`failure`
  与 `unknown` 都清空，窗口变化、导航、目标脱离同样清空。没有验证成功的焦点就不会有键盘输入。
* **弹窗 fail-safe（Task 2）**：先把控件分类为安全关闭 / 中性确认 / 正向确认 / 破坏性 / 未知，
  破坏性标签优先匹配（"Delete and close" 是破坏性而不是关闭）；找不到语义时**绝不点第一个
  按钮**，而是返回 `USER_ACTION_REQUIRED`。破坏性确认必须同时满足契约允许、动作声明了该效果、
  安全门通过三个条件。
* **自适应有界稳定（Task 3/16）**：冷却只由当前这一步观测到的信号决定（UI 变化、目标移动、
  上次 miss、窗口变化、动画、导航中、弹窗、目标脱离），最小延迟 + 每信号一格、软上限封顶；
  导航中直接跳到导航预算；强制最小延迟不会超过动作自己的 maximum。UI timing 只有一处定义。
* **证据分级（Task 4）**：strong / medium / weak，按动作风险设门槛：TYPE 要值相等、SAVE 要
  文件证据、DELETE 要授权且目标消失、SEND/SUBMIT/PUBLISH 要具体成功态、普通低风险点击接受
  局部状态变化。弱证据不能通过高风险动作；critical 动作必须先声明预期效果，否则按"未验证"
  处理而不是"成功"。
* **有意义的进度（Task 5）**：`lastProgressAt` 只在验证过的效果、子进程退出、验证过的文件操作、
  状态迁移、成功条件满足时更新；心跳与"已发出动作"不算进度，`direct` 推断被明确拒绝（它正是
  加载动画永远能给的东西）。
* **有界 stall 阶梯（Task 6）**：八级阶梯只在 `stall.cjs` 定义一次，恢复模块复用同一份，最后一级
  是 `fail_with_context`，永不回到第一级；`maxRecoveries` 限制升级次数。
* **进程监管（Task 7）**：build / test / lint / dev server / 包管理器 / git 全部登记 pid、命令、
  cwd、启动时间、归属、预期寿命与状态；有界前台进程超时可判定为 hung，故意长驻的 dev server
  不会；只杀自己启动的进程，退出时统一 dispose。
* **资源上限（Task 8）**：截图记录、调用方 ring、证据字节数都有上限；临时诊断截图先淘汰，
  失败证据保留——长跑不能把"看过的每一帧"都留在内存里。
* **故障隔离与有界重连（Task 9/10）**：单个控制器坏掉只降级，其余能力继续；传输失败按"每步
  每通道"的有界预算重连，backoff 有上限，绝不复用 stale target，预算耗尽报
  `RECONNECT_EXHAUSTED`；stale target 之类的非传输错误不会当成重连重试。
* **workspace 连续性（Task 11）**：每个 shell/file 动作都带解析过的 cwd 并校验边界；没有已验证
  workspace 时相对路径直接拒绝，越界路径需契约显式允许，漂移按 mismatch 上报；workspace 不可用
  就 BLOCK，绝不悄悄退回系统当前目录。
* **文件变更验证（Task 12）**：write 校验存在、内容回读、mtime 与大小；copy 校验目标大小；
  move 要求源消失且目标存在；delete 要求目标缺失；mkdir 要求目录存在。无法验证的变更算失败，
  不算成功。
* **有界命令契约（Task 13）**：shell 动作必须给出 command / cwd / timeout / 期望退出码 / 输出
  捕获 / 进程模式；缺省有界、超长 timeout 会被夹紧；`just run this` 永远不会变成无界等待；
  判定结果使用运行时自己的 `STEP_RESULTS` 词表。
* **resume-safe 步边界（Task 14）**：运行时异常后先重新观测效果，再决定
  `already_complete` / `retry` / `failed`，绝不盲目重放写了一半的文件；文档窗口内的时钟偏移
  被容忍。
* **执行器瘦身（Task 15/17）**：executor 只保留编排、状态迁移与控制器选择，冷却数学、弹窗标签表、
  验证匹配、stall 阶梯各自只有一个定义；recovery 只用五个词的封闭词表
  （`RETRYABLE` / `ALTERNATIVE_AVAILABLE` / `REPLAN_REQUIRED` / `USER_ACTION_REQUIRED` /
  `FAILED`）回答，且只是报告，绝不修改目标、成功条件或计划。
* **日志卫生（Task 18）**：按大小滚动、文件数有界；每行都带
  `runId` / `taskId` / `stepId` / `controller` / `action` / `verdict` / `duration` / `retry` /
  `reasonCode`；重复事件超过上限后只做汇总；终端失败证据跨滚动保留。
* **自检健康（Task 19/20）**：`healthy` / `degraded` / `blocked` 加上 capabilities、
  `lastProgressAt`、`activeOwnedProcesses`、`currentStep`。单个动作失败不是任务致命，单个控制器
  失败不是运行时致命；只有"不存在正确动作"时才 block：workspace 不可用、所有必需能力都不可用、
  安全授权不可用、资源上限超限、状态完整性不确定。
* **验收目标**：`tests/unit/computer-use-longrun-modules.test.js` 逐条覆盖上述规则；
  `docs/computer-use-acceptance.md` 新增加速 soak、十二项故障注入矩阵与场景 A–G 的目标表
  （先写目标，绿灯由后续验收步骤回填）。

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
* **顺带修好了一个一直红着的门**：Theme-Cover 分支的 verify 一直挂在两个与本次改动
  无关的断言上（`theme-official-surfaces` / `dual-ui` 读 `desktop-main.cjs` 并用 `\n`
  做多行匹配，Windows checkout 把行尾改成 CRLF 后必然失败）。现在 `.gitattributes`
  把源码/数据/文档钉成 LF（只有 `*.cmd` 保持 CRLF），两个测试也各自归一化读入内容；
  断言没有被削弱，computer-use 分支的 verify 已经是绿色。

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
