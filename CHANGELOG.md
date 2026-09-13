# Changelog

All notable changes to DS-Hns. Newest first. Each entry names the user-visible
behaviour that changed, not the files that were touched.

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
