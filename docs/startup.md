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

**当前的两个诚实缺口**（写在代码注释与这里）：① 清单还没把任何 pin 标成 `tested`，所以**今天不会安装
任何插件**，那一步需要一次真机测试；② 安装调用本身还没接（`install` 未注入）—— 猜一个安装器参数名会把
未验证的代码放到可选插件的安装路径上，所以它随"第一个 pin 被标记 tested"的那次提交一起落地。

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

## 4. 验收怎么读

- `tests/unit/startup.test.js`：状态顺序、预算记录、`defer` 的故障隔离、`onInteractive`、
  `ENHANCED` 只在延迟工作落定后出现，以及**启动顺序**（骨架先于 Harness、可选层全部晚于
  INTERACTIVE）。
- `scripts/verify.ps1`：启动模块与骨架页存在、骨架页无脚本、启动顺序成立。
- 真机看 `logs/desktop-runtime.log` 的 `[BOOT]` 行；`boot report` 那一行是机器可读的全量报告。
