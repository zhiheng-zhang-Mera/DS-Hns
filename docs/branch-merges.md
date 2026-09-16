# 分支合并记录：全部历史收敛到一条 `main`

> **后续分支（未合并，仍在开发中）：`better-install`。** 本文记录的是"把所有历史收敛到 `main`"那一轮。
> 之后从 `main` 开出的 `better-install` 做的是另一件事：安装器的干净安装体验。它的内容见
> `docs/install-flow.md`，要点是四条 ——
>
> 1. `multi-supervisor` 的 8500 ms 墙钟阈值不再当门禁：并行是**结构性断言**（两个节点确实同时在跑、
>    plan 完成、任务数对得上），墙钟只输出 `[benchmark]`，只有显式设置
>    `DSH_SUPERVISOR_WALL_CLOCK_GATE=strict` 才会失败。安装器不会再因为"机器慢"退出 1。
> 2. 安装器新增**两个可选社区插件**（`@dsh-market/plugin`、`dsh-plugin-wallpaper-engine`），分别询问、
>    默认跳过、参数优先（`-InstallMarket` / `-InstallWallpaper` / `-SkipOptionalPlugins`），冲突时报错而不是
>    静默覆盖。
> 3. 安装走的是**已有的**链路：发布清单钉版本 → `installBundled()` → Harness 自己的 CLI
>    （`dsh plugin --profile <p> add <pkg>@<ref>`）→ 适配器层的新适配器 `dshns.harness-profile` 回读校验。
>    没有第二条 clone 安装路径。
> 4. 可选插件失败只警告不致命；Mega Core 仍是主体安装的一部分，没有被变成可选项。
>
> 分支清单（尖端、独有提交、合并方式）在它被合并进 `main` 时按本文的格式补一行。

本文记录的是：本轮把仓库里**每一条分支**都并进 `main`，最终远端与本地都只保留 `main`。合并以
`test-merge-install`（`a05f6b8`）为**最终版**：`main` 的内容就是它的内容；其余分支的提交全部成为 `main` 的
祖先 —— 分支名消失了，历史一条没删。

## 合并方式（三种，逐条对应下表的"方式"列）

| 方式 | 用在 | 为什么 |
| --- | --- | --- |
| `--no-ff` 真合并 | `test-merge-install` | 它就是最终版。这一次合并不改任何文件，但把它的 54 个提交接进 `main` |
| `--no-ff -s ours` | 6 条分叉分支 | 它们的内容已被最终版取代（同名工作重新落回并向上扩展），而"最终版为准"要求它们不得改动最终树：只接历史，不动树 |
| 不合并（已含） | 8 条分支名 | 它们早就完整地躺在最终版的血统里（0 独有提交），没有可合并的东西 |

每一步合并后当场核对两件事，全部通过：

```text
git diff --name-only HEAD^ HEAD      ->  空（一个文件都没动）
git rev-list --count HEAD..<分支>    ->  0（该分支再无独有提交）
```

## 合并清单（按执行顺序）

| # | 分支 | 尖端 | 独有提交 | 方式 | 合并提交 |
| --- | --- | --- | --- | --- | --- |
| 1 | `test-merge-install` | `a05f6b8` | 54 | `--no-ff` | `90aadf8` |
| 2 | `adapter-fix` | `22b3261` | 1 | `-s ours` | `d26d705` |
| 3 | `cordis-adapter-fix` | `7969807` | 2 | `-s ours` | `0794ceb` |
| 4 | `process-adapter-fix` | `791773d` | 3 | `-s ours` | `e2d7b79` |
| 5 | `HNS-adapter-fix` | `96c571f` | 4 | `-s ours` | `21519fb` |
| 6 | `auto-install-fix` | `d76dc3d` | 5 | `-s ours` | `b36bc40` |
| 7 | `test-merging` | `2b25c75` | 8 | `-s ours` | `5bc378c` |

六条分叉分支是一条**线性血统**，每一步给"插件适配器"加一层，新增文件数就是这条线的刻度：

```text
66e371a (旧 main)
   └── adapter-fix            15 个新文件   框架：detect -> select -> adapt -> validate -> standardise -> unify
        └── cordis-adapter-fix 25 个新文件  + Cordis/DSH 社区适配器与受控桥
             └── process-adapter-fix 33 个  + 受管进程适配器（argv、授予环境、心跳、重启策略）
                  └── HNS-adapter-fix 37 个 + 原生加载路径 NativeHnsAdapter、健康调度器
                       └── auto-install-fix 44 个 + 唯一安装管线 app/core/plugin-install/
                            └── test-merging 44 个  预演：把三条分支与这条链合到一起
```

最终版把这条线的**终点**按同样的顺序重新落回（`db5ebab` → `d44d835` → `9417ca8` → `16d722c` →
`1965f33`），并在其上继续扩展。所以这六条分支的独有内容不是"被丢掉"，而是"已被最终版覆盖"：早期形态的唯一
孤儿文件 `app/core/plugin-adapters/adapters/native.cjs`（`createNativeAdapter`，118 行）在最终版就是
`adapters/native-hns.cjs`（`createNativeHnsAdapter`，189 行）。

## 逐条：目的、内容变动、效果

### 1. `test-merge-install`（`a05f6b8`）→ 合并提交 `90aadf8`

* **目的**：承载产品到此为止的全部内容 —— 官方界面里的悬浮球（`app/plugins/mega-core` 注册
  `shell.overlay`）、插件适配器框架、唯一安装管线，以及本轮新增的"把随产品发布的插件签进 Harness
  profile"安装步骤（`scripts/install-profile-plugin.ps1`，安装器 4/8 步）。
* **内容变动**：相对旧 `main` 54 个提交、131 个文件。除适配器与安装管线外，还包含
  `app/extensions/mega/system-orb.cjs`、`app/plugins/mega-core/**`、`docs/pluginize.md` 等。
* **效果**：`main` 的树自此与它逐字节相同（`git diff --stat test-merge-install HEAD` 为空）。这是唯一一次
  真正改动 `main` 内容的合并。

### 2. `adapter-fix`（`22b3261`）→ `d26d705`

* **目的**：给"本来不是 `dshns.plugin/v1` 的东西"一条正式通道：工件走
  detect → select → adapt → validate → standardise → unify，管理器收到同一种结构；替掉
  `plugin-host.cjs` 里"一种格式一条分支"的做法（那正是隔离边界所在）。
* **内容变动**：新增 15 个文件，`app/core/plugin-adapters/{index,contract,detect,lifecycle,registry}.cjs` 与
  `adapters/{native,cordis,mock}.cjs`。
* **效果**：0 文件变动。对应最终版 `db5ebab`。

### 3. `cordis-adapter-fix`（`7969807`）→ `0794ceb`

* **目的**：用新框架吃下最大的真实生态。为 DeepSeek Harness / Cordis 写的社区插件，不必为它写一行代码、
  也不动它的源码，就能走普通插件流程安装、启用、禁用、重载、健康检查、卸载。读取器从
  `dsh.bundle.patch`、`dsh.client.inject`、`cordis.patch.yml`、`peerDependencies` 学形状。
* **内容变动**：在上一代之上新增 25 个文件，含 `adapters/cordis-dsh.cjs` 与
  `bridge/{host,child,contract}.cjs`（受控桥）。
* **效果**：0 文件变动。对应最终版 `d44d835`。

### 4. `process-adapter-fix`（`791773d`）→ `e2d7b79`

* **目的**：给"根本不该住在 DS-Hns 里"的插件一条路：要活过应用本体的监督进程、带自己解释器的模型服务、
  有自己的生命周期的编译产物。`ProcessPluginAdapter` 理解**进程**，不理解"进程是干什么的"；
  `dshns-process.json` 声明 argv 数组（绝不经 shell）、**授予而非继承**的环境、心跳与重启策略。
* **内容变动**：新增 33 个文件，含 `adapters/process.cjs` 与 `process/{contract,supervisor,transport}.cjs`。
* **效果**：0 文件变动。对应最终版 `9417ca8`（含重启伴随进程）。

### 5. `HNS-adapter-fix`（`96c571f`）→ `21519fb`

* **目的**：补上框架自己的洞。随产品发布的插件曾被 `shippedPlugins()` 当"现成对象"塞给管理器 —— 那是第二条
  加载路径，代价是每个 `list()` 条目都没有 adapter/adaptation/runtime/permissions。`NativeHnsAdapter`
  是正式答复：`shippedPlugins()` 消失，`installedPlugins()` 变 `installedArtifacts()`；同一轮带来不会重启
  任何东西的健康调度器。
* **内容变动**：新增 37 个文件；`adapters/native.cjs` 在这一代**改名**为 `adapters/native-hns.cjs`，并加入
  `app/plugins/health-scheduler/`、`docs/health-scheduler.md`。
* **效果**：0 文件变动。对应最终版 `16d722c`。

### 6. `auto-install-fix`（`d76dc3d`）→ `b36bc40`

* **目的**：让"将要装的是什么、它被允许做什么"只有一个回答的地方。商店在取、兼容模式在收、适配器框架在适配
  已经落盘的东西 —— `app/core/plugin-install/` 把
  source → materialise → inspect → plan → adapt → manager.install 变成**一条**管线。
* **内容变动**：新增 44 个文件，以 `app/core/plugin-install/**` 为主，附带安装级验收。
* **效果**：0 文件变动。对应最终版 `1965f33`。

### 7. `test-merging`（`2b25c75`）→ `5bc378c`

* **目的**：这次收敛的**预演**。三个合并把 `plugin-ize`、`startup`、`trash-fixing-1` 与整条适配器链
  （`22b3261` → `7969807` → `791773d` → `96c571f` → `d76dc3d`）合到一起。
* **内容变动**：它的 5 个适配器提交就是上面前 5 条分支的血统，另外 3 个是它自己的合并提交；相对其合并基
  （`3398b20`）新增的 44 个文件全部来自那条链。
* **效果**：0 文件变动，且无独有内容丢失 —— 合并它之前那 5 个提交已是 `main` 的祖先，它合并进来的三条分支
  也各自 0 独有提交。最终版把同样的工作放在一条线上，所以它作为历史保留、不作为内容。

## 已含、无需合并的 8 条分支名

它们的尖端都是最终版的祖先（0 独有提交），因此没有可合并的提交，也不产生合并提交。

| 分支 | 尖端 | 目的 | 效果 |
| --- | --- | --- | --- |
| `main`（旧） | `66e371a` | 壁纸一轮：图到达官方界面，每种背景各自一张 | 其提交全在 `main` 历史中；本次由最终版的内容接续 |
| `mech-adapter-merge` | `8808e2f` | 适配器合并轮（53 个提交：框架 + 三条适配、唯一安装管线、安装级验收、球的路由修复） | 最终版的直接前身 |
| `Mech-standby` | `18d91de` | 把"过去时刻"的调度规则放到非高峰时段断言 | 基线轮，已在血统中 |
| `plugin-ize`（远端） | `56f3e7f` | 插件化 Phase 1 与 review 4：只留系统球、能盖住别的应用、点击不再闪烁 | 已在血统中 |
| `plugin-ize`（本地） | `8781543` | 同一轮的下一步：跑的是插件客户端，面板打开整页主体（与远端 `trash-2` 同提交） | 已在血统中 |
| `startup` | `9035cf4` | 两个社区插件装进产品 profile，MEGA 在其中看得见它们 | 已在血统中 |
| `trash` | `99671ca` | 垃圾桶轮的中间状态：官方页面里的球与它的面板 | 已在血统中 |
| `trash-2` | `8781543` | 同轮的继续（与本地 `plugin-ize` 同一提交） | 已在血统中 |
| `trash-fixing-1` | `3398b20` | 启动时刷新 profile 里的插件副本；启动失败带上 Harness 自己的话 | 已在血统中 |

## 最终状态

* `main` 的树 = `test-merge-install`（`a05f6b8`）的树 + 本文件。
* 远端只剩 `main`（`origin/HEAD` 指向它）；本地只剩 `main`。
* 所有原分支的提交都仍在 `main` 的 DAG 里，可随时用上表的尖端 SHA 取回：
  `git merge-base --is-ancestor <尖端> main` 对全部 15 条分支名均为真。
