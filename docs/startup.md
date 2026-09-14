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

## 4. 验收怎么读

- `tests/unit/startup.test.js`：状态顺序、预算记录、`defer` 的故障隔离、`onInteractive`、
  `ENHANCED` 只在延迟工作落定后出现，以及**启动顺序**（骨架先于 Harness、可选层全部晚于
  INTERACTIVE）。
- `scripts/verify.ps1`：启动模块与骨架页存在、骨架页无脚本、启动顺序成立。
- 真机看 `logs/desktop-runtime.log` 的 `[BOOT]` 行；`boot report` 那一行是机器可读的全量报告。
