# Sub-worker（可选执行层）参考

本文档描述 DS-Hns 的 **可选 Sub-worker 执行层**：它是什么、如何启用、协议字段、权限与安全策略、工作区模型、Live View、用户干预、状态机、崩溃恢复、持久化路径与配置项。

实现来源（全部在仓库内）：

```text
app/sub-worker/protocol.cjs     版本化任务/结果协议、状态与事件词表、校验
app/sub-worker/state.cjs        状态机 TRANSITIONS + 持久化 SubWorkerStore
app/sub-worker/permissions.cjs  路径/命令/风险策略（纯策略库）
app/sub-worker/task-runner.cjs  最小执行器（operations 执行 + 控制面）
app/sub-worker/reporter.cjs     事件 → 可审计摘要 / 结果 / 日志
app/sub-worker/event-bus.cjs    事件总线 + 密钥脱敏
app/sub-worker/runtime.cjs      被执行进程（纯 Node，唯一被 spawn 的入口）
app/sub-worker/manager.cjs      WorkerManager（Controller 侧，唯一持久化写入者）
app/desktop-main.cjs            workerManager 生命周期、IPC、托盘、退出顺序
app/runtime-process.cjs         ownership 记录（harness + sub-worker 两种类型）
app/extensions/mega/index.cjs   Mega 快照 + 托盘 Sub-worker 子菜单
app/extensions/mega/ui/*        dock 面板、Live View、preload 桥
config/app.json                 subWorker 出厂默认值
```

---

## 1. 它是什么

Sub-worker 是**可选启用的执行器层**（Executor only），不是第二个 Controller、不是第二套 GUI：

- 角色固定为 `Executor`：只执行 Controller 下达的、带完整 specification 的任务；不决定项目方向、不重新设计 architecture、不自行产生新目标、不把任务转交给其他 agent、不自行扩大可修改范围（`manager.cjs` / `task-runner.cjs` 头部契约注释）。
- 唯一可被 spawn 的入口是 `app/sub-worker/runtime.cjs`（纯 Node，无 Electron 依赖），由 `WorkerManager` 通过 `child_process.spawn` 启动，通信走 **stdio 上的换行分隔 JSON**（`protocol.envelope` / `protocol.encode` / `protocol.LineDecoder`）。
- Controller 侧是 `app/desktop-main.cjs` 中的 `workerManager`（`new WorkerManager({ root, nodeExe, runtimeProcess, log, notify })`）。它在官方 Harness 页面就绪之后创建，**创建本身是惰性的**：不 spawn、不建目录。

### 1.1 默认关闭时的保证

`subWorker.enabledOnStartup` 默认 `false`。未启用时：

| 承诺 | 实现依据 |
| --- | --- |
| 不额外启动进程 | `WorkerManager` 构造函数与 `hydrate()` 只读文件；唯一的 spawn 点在 `start()` 中 |
| 不额外占用端口 | worker 只用 stdin/stdout 管道，代码中没有任何端口绑定；`127.0.0.1:3080` 仍只属于官方 Harness |
| 不额外窗口 | worker 无 Electron、无 BrowserWindow；面板与 Live View 是既有 Mega dock 内的 DOM |
| 不创建 `data/sub-worker/` 目录 | `SubWorkerStore.ensureDirs()` 只在 `manager.start()` 和 `runtime.main()` 中调用；`install`/正常启动路径不会调用它 |
| 不改变现有工作流 | 唯一新增的 IPC 面是 `registerSubWorkerIpc()` 注册的 17 条 `sub-worker:*` 通道；托盘菜单只是多出一个 `Sub-worker` 子菜单项 |

只有生效配置里的 `enabledOnStartup` 是布尔 `true` 时，`app.whenReady()` 里才会在启动末尾执行 `workerManager.start({ reason: 'enabledOnStartup' })`；`desktop-main.cjs` 判断的是 `workerManager.describe().config.enabledOnStartup`，即经 `publicConfig()` 归一化后的值，所以字符串 `"true"` 不会开启它（生效配置的三层合成见 §13.2）。

---

## 2. 启用与关闭

### 2.1 Mega dock 面板

dock 内的 `Sub-worker` 面板（`ui/dock.html` 的 `section.panel.sub-worker-panel`）是所有控件的主入口：

```text
Sub-worker                [OFF]        ← #swState 状态 chip（UNAVAILABLE / OFF / IDLE / RUNNING / …）
可选执行层：默认关闭。开启后才会启动独立 worker 进程；它只执行 Controller 下达的明确任务，不决定方向。

Worker / Mode / State / Stage / Task / Queue / Workspace / PID / Restarts / Auto Delegate / Workspace Mode
← #swSummary 摘要网格

[Enable Sub-worker] [Start] [Stop] [Restart] [Pause] [Resume] [Cancel Task] [Take Over] [Open Live View]

▸ 派发任务（Controller 提供明确 specification）      ← #swDispatchBox
    objective / target_repo / risk_level / workspace_mode / workspace
    allowed_paths / forbidden_paths / acceptance / acceptance_commands
    write / shell / git_commit / network / requires_vision
    operations（JSON 数组）
    [派发给 Sub-worker] [恢复上次中断任务]

#swQueue      待派发队列
#swHistory    Task History（最近 12 条）
#swCrash      CRASHED / HANDOFF 提示条
```

按钮语义（`ui/dock.js`）：

- `Enable Sub-worker` 与 `Start` 都调用 `sub-worker:start`（即 `workerManager.start({ reason: 'panel' })`）；worker 运行中时 `Enable`/`Start` 被隐藏（`enable.hidden = Boolean(sw.enabled)`），关闭入口是 `Stop`。
- `Stop` → `workerManager.stop({ reason: 'panel' })`（停进程，状态回到 `OFF`）；`Restart` → `workerManager.restart({ reason: 'panel' })`（restart 计数 +1）。
- `Pause` / `Resume` / `Cancel Task` / `Take Over` 分别送达 `sub-worker:pause|resume|cancel-task|take-over`。
- 面板不显示该功能时（shell 未注入 manager），`swState` 显示 `UNAVAILABLE`，摘要区提示 `Sub-worker 管理器不可用：…`。
- 派发前前端即校验：`objective` 不能为空；`operations` 必须是非空 JSON 数组（“worker 只执行明确 specification，不会自行设计实现方案”）。

`⚙ 设置 → Sub-worker` 分组保存到 `sub-worker:update-config`：

```text
enabledOnStartup  autoDelegate  workspaceMode  maxWorkers(=1)  keepChangesOnStop  allowGitCommit  showNotifications
```

### 2.2 系统托盘子菜单

托盘菜单（`mega/index.cjs#applyTrayMenu`）当前顺序：

```text
DS-Harness
├── Show
├── Mega
├── ────────────────────────────────
├── Sub-worker
│   ├── Sub-worker: OFF                     ← 或 Sub-worker: BUSY (RUNNING) / Sub-worker: IDLE …
│   ├── Task: <task_id>                     ← 无任务时为 Task: Idle
│   ├── ──────────────────────────────
│   ├── Start
│   ├── Stop
│   ├── Restart
│   ├── ──────────────────────────────
│   ├── Pause
│   ├── Resume
│   ├── Cancel Current Task
│   ├── Open Live View
│   └── Restart Worker  或  Take Over Workspace   ← 依据 state 是否为 CRASHED
├── ────────────────────────────────
├── Exit DS-Harness
└── Force Exit DS-Harness
```

- 标题行公式：`state === 'OFF'` → `Sub-worker: OFF`；否则 busy 时 → `Sub-worker: BUSY (${state})`；其余 → `Sub-worker: ${state}`。
- 托盘 busy 集合：`ASSIGNED, RUNNING, PAUSING, PAUSED, BLOCKED, STOPPING`（dock 的 busy 集合额外包含 `BLOCKING` 这一项拼写，见 `ui/dock.js#SUB_WORKER_BUSY_STATES`）。
- 启用条件：`Start` 需 `!enabled`；`Stop` 需 `enabled`；`Restart` 需 `enabled || state !== 'OFF'`；`Pause` 需 `state ∉ {PAUSED, PAUSING}`；`Resume` 需 `state ∈ {PAUSED, PAUSING}`；`Cancel Current Task` 需 busy；`Open Live View` 只需可用。
- worker 事件到达时，托盘刷新与 dock 刷新被合并为 400 ms 一次（`scheduleSubWorkerRefresh`），不逐事件重建菜单。
- `Exit DS-Harness` / `Force Exit DS-Harness` 排在最末，worker 的任何异常都不影响到达它们（`safeWorkerCall` 捕获全部异常）。

---

## 3. Task Object（`protocol.validateTask`）

校验失败**不抛异常**，返回 `{ ok: false, errors: [...], task: null }`，以便用结构化拒绝应答而不是让 worker 结束。校验通过后返回归一化后的 `task`。

| 字段 | 类型 | 必填 | 默认 / 归一化 |
| --- | --- | --- | --- |
| `version` | number | 是 | 必须等于 `PROTOCOL_VERSION = 1`，否则 `unsupported task version: X` |
| `task_id` | string | 是 | `sanitizeTaskId`：仅保留 `[A-Za-z0-9._-]`，其余替换为 `-`，去首尾 `-`，截断 120 字符；为空则报错 |
| `objective` | string | 是 | `trim()` 后不能为空 |
| `target_repo` | string | 是 | `trim()` 后不能为空（`isolated_worktree` 模式必需） |
| `created_at` | string | 否 | 默认 `new Date().toISOString()` |
| `workspace` | string \| null | 否 | 默认 `null`；`shared` 模式或 worktree 失败回退时使用 |
| `workspace_mode` | string | 否 | 只能是 `shared` 或 `isolated_worktree`（其他非空值报 `unknown workspace_mode`）；默认 `isolated_worktree` |
| `allowed_paths` | string[] | 否 | `normalizePathList`：去空、`\` → `/`；**非空时构成「可修改范围」白名单：只约束 write / delete 的路径，不约束 read**（worker 永远不得自行扩大该范围） |
| `forbidden_paths` | string[] | 否 | 同上；**对所有 action（`read` / `write` / `delete`）都是否决项**，优先级高于 `allowed_paths` |
| `acceptance` | string[] | 否 | 逐项 `String()`；无对应自动命令时记为人工复核 |
| `acceptance_commands` | string[] | 否 | 逐项 `String()` 并过滤空串；有值时作为自动验收门 |
| `permissions` | object | 否 | 见 §6；`read` 默认 `true`，`write`/`shell`/`git_commit`/`network` 默认 `false` |
| `risk_level` | string | **是** | `L0`–`L4`，大写归一化；**缺失或空串报 `risk_level is required (L0/L1/L2 are accepted by the executor)`（fail-closed，缺省绝不按“安全”放行）**；未知值报 `unknown risk_level` |
| `requires_vision` | boolean | 否 | 默认 `false`；为 `true` 时被 `guardTask` 拒绝 |
| `operations` | object[] | 否 | 只保留纯对象条目（浅拷贝）；**没有 operations 即视为没有可执行 specification** |
| `notes` | array | — | 由协议内部固定为 `[]`，不接受 Controller 注入 |

补充字段说明（相对工程书 §7.1 的加法项）：

- `operations` —— 工程书未定义的可执行 specification 载体；`hasExecutableSpecification(task)` 即判断 `operations.length > 0`。
- `acceptance_commands` —— 让 `acceptance` 从人工清单变成可自动验证的门（`VALIDATING` 阶段）。
- `workspace` —— 显式工作区（`shared` 模式或 worktree 不可用时的回退）。
- `workspace_mode` —— 显式选择 `isolated_worktree` / `shared`（默认 `isolated_worktree`）。

归一化后的 task 随 `assign_task` 消息下发，worker 侧 `runtime.handleAssignTask` 会再次 `validateTask`（失败即回 `TASK_REJECTED`）。

---

## 4. Result Object（`protocol.createResult`）

`createResult(taskId, overrides)` 生成的结果对象字段如下（`reporter.buildResult` 填充实际值后再补齐）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task_id` | string | 任务标识 |
| `status` | string | `RESULT_STATUSES` 之一：`completed` / `failed` / `blocked` / `cancelled` / `rejected` / `unsupported_capability` / `handoff`；非法值回落 `completed` |
| `summary` | string | 人类可读摘要（`TaskRunner.buildSummary` 生成操作数、变更文件数、测试统计） |
| `changed_files` | string[] | 工作区相对路径列表（与工程书示例一致，纯路径） |
| `changed_file_details` | `{path, status}[]` | 加法字段：每文件 `A`（新建）/`M`（修改）/`D`（删除），供 Live View 直接渲染 `M src/...` |
| `tests` | `{passed, failed, skipped, parser?, inferred?}` | 最后一次 `test_result` 的计数；`parser` 为 `node-test` / `jest-style` / `mocha-style` / `exit-code`，`inferred: true` 表示由退出码推断 |
| `git` | `{dirty, commit, branch}` | 结束时重新采集（`refreshGitState` → `git status --porcelain=v1`、`git rev-parse HEAD`、`git rev-parse --abbrev-ref HEAD`） |
| `warnings` | string[] | 警告文本（测试失败提示、取消提示、验收缺自动命令提示、被取消任务的隔离工作区回滚结果等） |
| `needs_controller_review` | boolean | 默认 `true`（只有显式传 `false` 才是 `false`） |
| `code` | string | `RESULT_CODES` 之一，默认 `OK` |
| `reason` | string \| null | 机器可分支的拒绝/失败原因 |
| `needs_controller_decision` | boolean | 需要 Controller 决策时为 `true` |
| `requires_controller` | boolean | 需交回 Controller 时为 `true` |
| `acceptance` | object[] | 验收条目，见下 |
| `stage_log` | `{stage, at}[]` | 执行阶段轨迹（来自 `stage_changed` 事件） |
| `started_at` | string \| null | 任务开始时间 |
| `finished_at` | string | 结束时间（默认当前时间） |
| `ok` | boolean | **非枚举**派生字段：`status === 'completed'` |
| `workspace` | string | 由 `runtime.cjs` 在发送前追加：实际执行的工作区绝对路径 |
| `worker_id` | string | 由 `runtime.cjs` 在发送前追加：`sub-1` |

`acceptance` 条目形态（真实场景：自动命令通过 / 被拒绝）：

```json
[
  { "criterion": "acceptance command: npm test -- knowledge", "status": "passed", "verified": true, "exitCode": 0 },
  { "criterion": "acceptance command: npm run lint", "status": "denied", "verified": false, "reason": "the task did not grant shell permission" }
]
```

`acceptance[].status` 取值：`passed` / `failed`（自动命令的退出码）、`denied`（命令被策略拒绝，附 `reason`）、`manual_review`（`verified: false`，**仅当 `acceptance_commands` 为空**时，为 `acceptance` 里的自然语言条目生成，并触发一条 “acceptance criterion/criteria have no automated command” 警告）。

### 4.1 `RESULT_CODES` 全表

```text
OK  TASK_REJECTED  REQUIRES_CONTROLLER  UNSUPPORTED_CAPABILITY
PERMISSION_DENIED  PATH_FORBIDDEN  COMMAND_DENIED  MISSING_SPECIFICATION
NO_EXECUTABLE_OPERATION  OPERATION_FAILED  TESTS_FAILED  ACCEPTANCE_FAILED
BLOCKED  CANCELLED  CRASHED  TIMEOUT  WORKSPACE_LOCKED  INVALID_MESSAGE
```

`status` / `code` 的对应关系：

| 情形 | `status` | `code` |
| --- | --- | --- |
| 全部操作执行完、最后测试通过、验收命令通过 | `completed` | `OK` |
| 最后一次测试运行有失败 | `failed` | `TESTS_FAILED` |
| 验收命令失败 | `failed` | `ACCEPTANCE_FAILED` |
| 操作报错（非需 Controller） | `failed` | 该操作错误码（如 `OPERATION_FAILED` / `TIMEOUT` / `PATH_FORBIDDEN` / `COMMAND_DENIED` / `PERMISSION_DENIED`） |
| 操作被判定为需 Controller（仅 `REQUIRES_CONTROLLER`） | `blocked` | `REQUIRES_CONTROLLER` |
| 风险等级 L3/L4、未知风险等级 | `rejected` | `REQUIRES_CONTROLLER` / `TASK_REJECTED` |
| `requires_vision: true` 而运行时不具备视觉 | `unsupported_capability` | `UNSUPPORTED_CAPABILITY` |
| 无 `operations` | `blocked` | `MISSING_SPECIFICATION` |
| 未知 op / op 缺必填字段 | `failed` | `NO_EXECUTABLE_OPERATION`（`unknown operation: …` 或缺少 `content`/`find`/`replace`） |
| 取消（Cancel Task / Stop） | `cancelled` | `CANCELLED` |
| 工作区被占用或无法准备 | `blocked` | `WORKSPACE_LOCKED` / `BLOCKED` |
| 进程崩溃 | `failed` | `CRASHED` |
| Take Over | `handoff` | `BLOCKED` |
| 非法协议消息 | `error` 消息 | `INVALID_MESSAGE` |

拒绝统一使用 `protocol.blockedResult`：`createResult(taskId, { status, summary, code, reason, needs_controller_review: true, needs_controller_decision, requires_controller })`，其中 `TASK_REJECTED` / `REQUIRES_CONTROLLER` → `rejected`，`UNSUPPORTED_CAPABILITY` → `unsupported_capability`，其余 → `blocked`。

---

## 5. `operations` 操作词表

`task-runner.cjs#executeOperation` 的 `switch` 是**唯一**支持的操作集合；每个 op 先经 `permissions.checkOperation` 判定，再执行。

| `op` | 必填字段 | 可选字段 | 行为与上限 |
| --- | --- | --- | --- |
| `list_dir` | `path` | — | 列目录；最多 400 条（`MAX_LIST_ENTRIES`），超出置 `truncated: true` |
| `read_file` | `path` | `allow_large` | 大小超过 512 KiB（`MAX_READ_BYTES`）时拒绝，除非 `allow_large: true` |
| `write_file` | `path`、`content`（必须是字符串） | — | `content` 非字符串时报 `NO_EXECUTABLE_OPERATION`；自动创建父目录；新建记 `A`、覆盖记 `M` |
| `replace_in_file` | `path`、`find`、`replace`（都是字符串） | `expect_occurrences` | `find` 不存在报 `OPERATION_FAILED`；`expect_occurrences` 与实际出现次数不符也报错 |
| `delete_file` | `path` | — | 文件不存在报 `OPERATION_FAILED`；删除记 `D`，并受关键模块删除守卫约束 |
| `run_command` | `command` | `phase`、`timeoutMs`、`allow_failure` | 退出码非 0 且未设 `allow_failure: true` 时报 `OPERATION_FAILED`；超时报 `TIMEOUT` |
| `run_tests` | `command` | `timeoutMs` | 解析测试输出为计数；**测试失败不终止任务**（留给后续 `FIXING`），最终由最后一次测试决定成败 |
| `git_status` | — | — | 需要 `permissions.shell`；依次运行 `git status --porcelain=v1` / `git rev-parse --abbrev-ref HEAD` / `git rev-parse HEAD` |
| `git_diff` | — | — | 需要 `permissions.shell`；运行 `git diff --stat`，统计文件行数 |

其他约束：

- 任何 `op` 缺失或未知 → `NO_EXECUTABLE_OPERATION`（`unknown operation: …`）。
- 每个 op 的执行路径都被 `resolveInsideWorkspace` 限制在工作区内，越界即 `PATH_FORBIDDEN`。
- 命令统一由 `runShell` 执行：`cwd = workspace`、`shell: true`、`windowsHide: true`、`stdio: ['ignore','pipe','pipe']`，环境注入 `DSH_SUB_WORKER=1`、`DSH_SUB_WORKER_TASK=<task_id>`、`CI=1`（若未设）、`npm_config_yes=true`；输出累计超过 200 000 字符时截断并追加 `[output truncated]`；git 内部命令超时 60 s，其他命令超时取 `operation.timeoutMs`，否则用 `config.commandTimeoutMs`。
- 阶段映射（`stageForOperation`）：`list_dir`/`read_file`/`git_status` → `INSPECTING`；`git_diff` → `PLANNING_EXECUTION`；`write_file`/`replace_in_file`/`delete_file`/`run_command` → `IMPLEMENTING`（上一次测试失败后则 `FIXING`）；`run_tests` → `TESTING`。
- 任务结束时若存在 `acceptance_commands`，先进入 `VALIDATING` 再 `REPORTING`。

---

## 6. 风险等级、能力与权限模型

### 6.1 风险等级（`guardTask` 顺序判定）

| 等级 | `RISK_BY_TIER` | 是否接受 |
| --- | --- | --- |
| `L0` | `command` | ✅ 接受（但必须给出至少一个 operation，否则 `MISSING_SPECIFICATION`） |
| `L1` | `local_modification` | ✅ 接受 |
| `L2` | `module_implementation` | ✅ 接受（必须有明确 specification，即 `operations`） |
| `L3` | `architecture_modification` | ❌ 拒绝 |
| `L4` | `product_direction` | ❌ 拒绝 |

- L3/L4 的拒绝码为 `REQUIRES_CONTROLLER`，结果 `status: "rejected"`、`requires_controller: true`、`needs_controller_decision: true`，并实时落一条 `blocked` 事件到历史与 Live View。
- 未知风险等级 → `TASK_REJECTED`。
- `requires_vision: true` 且 `capabilities.vision !== true` → `UNSUPPORTED_CAPABILITY`（`status: "unsupported_capability"`）。运行时的 `CAPABILITIES` 声明为 `{ code: true, shell: true, git: true, browser: false, vision: false, network: true }`。
- `permissions.read` 为假 → `PERMISSION_DENIED`。
- `workspace_mode === 'isolated_worktree'` 但缺 `target_repo` → `TASK_REJECTED`。
- 结构化拒绝形态固定（`manager.rejectTask`）：`{ task_id, status, summary, code, reason, needs_controller_review: true, needs_controller_decision: true, requires_controller: true }`，并同时写入 history、`data/sub-worker/tasks/<task_id>.json` 与 `blocked` 事件。

### 6.2 权限位 `permissions`

| 权限 | 默认 | 作用范围 |
| --- | --- | --- |
| `read` | **`true`**（只有显式 `false` 才为假） | 任务准入：为假时 `guardTask` 直接拒绝 |
| `write` | `false` | `write_file` / `replace_in_file` / `delete_file`：为假 → `PERMISSION_DENIED` |
| `shell` | `false` | `run_command` / `run_tests` / 验收命令：为假 → `PERMISSION_DENIED`（`the task did not grant shell permission`） |
| `git_commit` | `false` | 命中 `git commit` / `git tag` 时必需 |
| `network` | `false` | 命中网络类命令时必须为真，否则 `PERMISSION_DENIED` |

`git_commit` 的三重门（`checkCommand`）：

1. `task.permissions.git_commit !== true` → `PERMISSION_DENIED`；
2. 配置 `subWorker.allowGitCommit !== true` → `REQUIRES_CONTROLLER`；
3. 当前分支属于受保护分支 → `REQUIRES_CONTROLLER`。

受保护分支 `PROTECTED_BRANCHES = ['main', 'master', 'trunk', 'release', 'develop']`，另外正则 `^(release|hotfix)/` 与 `^v\d` 也视为受保护（`isProtectedBranch`，大小写不敏感）。

### 6.3 命令硬拒绝（`DENIED_COMMAND_PATTERNS`，共 18 条）

命中即 `COMMAND_DENIED`，不可被任何权限位放开：

| 类别 | 覆盖范围 |
| --- | --- |
| 根目录递归删除 | `rm -rf /`、`rd /s /q C:\`、`Remove-Item -Recurse -Force C:\` |
| 磁盘操作 | `format` / `diskpart` / `mkfs` / `fdisk` |
| 电源状态 | `shutdown` / `reboot` / `halt` |
| 注册表改写 | `reg add|delete|import` |
| 服务控制 | `sc delete|stop|config` |
| 进程终止 | `taskkill` |
| 推送 | `git push` |
| 历史改写/合并 | `git merge` / `git rebase` / `git cherry-pick` |
| 硬重置 | `git reset --hard` |
| 切到受保护分支 | `git checkout|switch main|master|release/*` |
| 分支删除 | `git branch -D` |
| worktree 释放 | `git worktree remove|prune`（worker 从不释放自己的工作区） |
| 发包 | `npm|pnpm|yarn publish` |
| 破坏性容器操作 | `docker rm|rmi|system prune` |
| 远程脚本管道执行 | `curl|wget|iwr|Invoke-WebRequest … \| sh|bash|zsh|pwsh|powershell`；以及任何管道进入 `iex` / `Invoke-Expression` |

需要 `permissions.network` 的命令（`NETWORK_COMMAND_PATTERNS`）：`npm|pnpm|yarn install|i|add|update|upgrade|ci|audit|publish`、`pip|pip3 install|download`、`curl|wget|Invoke-WebRequest|iwr`、`git clone|fetch|pull|submodule update|ls-remote`、`apt-get|apt|brew|choco|winget|scoop install|update|upgrade`、`npx`、`npm run … deploy|release|publish`、`ssh|scp|rsync`。

### 6.4 路径策略

- 路径一律为**工作区相对路径**（`normalizeRelativePath`）：绝对路径（`C:/…`、`/…`、`//…`）直接 `PATH_FORBIDDEN`；`..` 越界同样拒绝；`.` 被接受，表示工作区根目录本身（`list_dir` 需要）。
- `checkPath(task, path, action)` 的判定顺序：先 `forbidden_paths`（对 `read` / `write` / `delete` **每一个 action 都是否决项**），再对非 `read` 动作套用 `allowed_paths`（非空时构成**可修改范围**白名单，`read` 不受其约束）；命中 forbidden 或写/删不在白名单内 → `PATH_FORBIDDEN`。
- 始终保护、永不写入（`ALWAYS_PROTECTED_WRITE_PATTERNS`）：`.git`、`.git/**`、`**/.git/**`。
- 关键模块删除守卫（`CRITICAL_DELETE_PATTERNS`，命中即 `REQUIRES_CONTROLLER`）：

```text
package.json  **/package.json  package-lock.json  **/package-lock.json
pnpm-lock.yaml  yarn.lock  tsconfig.json  **/tsconfig.json  .gitignore
src/ipc/**  **/ipc/**  **/electron/main*  **/desktop-main*
```

策略细节（与实现一致）：`checkOperation` 对 `list_dir` / `read_file` 使用 `checkPath(task, operation.path, 'read')`，对 `write_file` / `replace_in_file` 使用 `checkPath(..., 'write')`，对 `delete_file` 使用 `checkPath(..., 'delete')`；`git_status` / `git_diff` **需要 `permissions.shell`**（它们会以子进程方式真的调用 `git`，因此不能绕过 shell 权限；缺少 shell 权限时返回 `PERMISSION_DENIED`），通过后为不带路径参数的操作级放行。因此**读路径同样受 `forbidden_paths` 否决**，只是**不**受 `allowed_paths` 约束 —— `allowed_paths` 是「可修改范围」，worker 永远不得自行扩大它；读写删都还要再经过 `resolveInsideWorkspace` 的工作区边界检查（越界即 `PATH_FORBIDDEN`）。

---

## 7. 工作区模型

### 7.1 `isolated_worktree`（默认）

```text
<parent>/<repoName>-worktrees/hns-sub-worker
```

`WorktreeManager.worktreePathFor(targetRepo)` = `path.join(path.dirname(resolved), <repoName> + '-worktrees', 'hns-sub-worker')`。

流程：目标仓库必须存在且为 git 仓库（`git rev-parse --is-inside-work-tree` 输出 `true`）→ 目录已存在则**复用** → 否则 `git worktree add --detach <worktree>`（超时 120 s）。

- 创建失败且任务**没有**显式 `workspace` → 任务直接 `blocked`（`code: BLOCKED`，`reason` 为失败原因）；不会静默改用共享工作区。
- 创建失败但任务给了显式 `workspace` → 按 `shared` 处理该显式路径。
- 隔离 worktree 是 detached 检出，因此 `Result.git.branch` 通常报 `HEAD`，`commit` 为该 commit sha。

**释放隔离工作区（显式动作）**：worktree 里放的是待验收的成果，所以它**不会**被自动删除。需要清理时由 Controller 显式调用 `WorkerManager.releaseWorktree(targetRepo)`（Mega 面板「释放隔离工作区」按钮 → IPC `sub-worker:release-worktree`），它会执行 `git worktree remove --force <worktree>`；若当前有任务在跑则拒绝（`ok: false`），目录不存在时为幂等空操作（`removed: false`）。

### 7.2 `shared`

使用任务显式 `workspace`（`path.resolve` 后 `mkdir -p`，锁模式记 `shared`）；没有显式工作区时的最终回退是 `<root>/workspace/sub-worker/<task_id>`，同样记为 `shared`。共享工作区在 worker 侧**永不**被回滚（见 §13.1 的 `keepChangesOnStop`）。

### 7.3 单写者工作区锁

锁文件为 `data/sub-worker/workspace-lock.json`，由 `WorkerManager` 独占写入：

```json
{ "task_id": "boss-kb-031", "workspace": "D:\\Boss-worktrees\\hns-sub-worker", "mode": "isolated_worktree", "pid": 12345, "at": "…" }
```

- 派发前 `prepareWorkspace` 读取锁：若锁属于**其他** task_id 且 worker 在运行 → 不进入任何工作区，任务直接落 `blocked`（`code: WORKSPACE_LOCKED`，原因 `workspace <ws> is locked by task <id>`），同时补发一条 `blocked` 事件并把状态置为 `BLOCKED`；worker 未运行时，该陈旧锁会被清除后继续。
- 任务结束（`handleResult`）、进程退出（`handleExit`）、停止（`finalizeStop`）、接管（`takeOver`）与强制退出（`forceStop`）都会调用 `releaseWorkspaceLock(...)` 释放锁。

---

## 8. Live View 与可观测性

Live View 是 dock 内的模态层（`#liveView`），头部固定提示：

> 仅显示可审计的执行摘要、命令、文件与测试结果，不显示模型隐藏推理。

### 8.1 分区（`dock.html` 中的 `section.lv-card`）

> 数据来源：`WorkerManager.liveSnapshot()`。它把 worker 上报的**同一条事件流**交给 `reporter.cjs` 的 `Reporter` 做投影（与 worker 侧写日志用的是同一个实现），再叠加只有 Controller 才知道的元信息（`objective` / `workspace` / `started_at`）与终态 `result`。因此面板与 Live View 显示的是**实时**内容，而不是派发时的快照：任务运行中 Execution Summary / Changed Files / Terminal / Tests 就已经在增长（`describe().live.summary` 等字段来自流式事件），任务结束后 `live.result` 才会出现。

| 区块 | 内容 |
| --- | --- |
| **Task** | `task_id`、`objective`、`workspace`；无任务时提示开启并派发 |
| **Status** | `state`、`stage`、`started`、`finished`、`worker`、`heartbeat` |
| **Execution Summary** | 最近 40 条带图标的执行事实（`✓ / → / ✗ / ! / ⛔ / ✎ / ·`） |
| **Changed Files** | `A`/`M`/`D` + 路径 |
| **Tests** | `passed` / `failed` / `skipped` / `parser`（由退出码推断时标注“由退出码推断”） |
| **Terminal** | 最近 80 行命令输出，命令行以 `$ ` 前缀 |
| **Warnings / Errors** | 错误在前、警告在后；皆无时显示“无警告与错误” |
| **Result** | `status`、`code`、`summary`、`needs review`，以及 `acceptance` 逐条；数据来自 `live.result`（任务结束前显示“任务尚未结束”） |
| **Events** | 最近 30 条管理器侧事件（倒序） |
| **Task History** | 历史条目（`status` / `task_id` / `summary`），可点击回溯单任务详情 |

底部操作条：`Pause`、`Resume`、`Cancel Task`、`Stop Worker`、`Restart`、`Take Over`、`Task Log`（读取最近 400 行、已脱敏的任务日志），以及 `Send Note` 输入框。

### 8.2 不显示隐藏推理

`event-bus.cjs` 的注释即契约：Live View、任务日志与结果摘要都来自**同一条事件流**，只暴露可审计的执行事实。Execution Summary 的文本由 `reporter.cjs#SUMMARY_RULES` 从事件类型派生（例如 `Updated src/a.ts`、`npm test -- knowledge exited 0`、`43 passed / 0 failed`、`Git status: HEAD (dirty)`），不存在原始 chain-of-thought、隐藏 reasoning 或模型内部 scratchpad 通道。

### 8.3 事件词表（`EVENT_TYPES`，21 项）

```text
task_received  task_started
inspection_started  file_read  file_write  file_delete
command_started  command_output  command_finished
test_started  test_result
git_status  diff_generated
warning  error  blocked  note_applied
task_completed  task_failed
state_changed  stage_changed
```

`command_output` 不进入摘要（避免刷屏），只进 Terminal 与任务日志；事件在产生时即经 `redactEvent()` **逐字段**脱敏（凡是字符串字段都过 `redactSecrets`，只保留 `timestamp` / `type` / `task_id` / `stream` / `stage` / `state` 这些本身不含密文的字段），因此 `note`、`text`、`reason`、`command`、`summary`、`detail` 等一律安全。`redactSecrets` 覆盖 `sk-…`、`?token=`/`&token=`/裸 `token=`/`token: …`、`api_key=`/`access_token=`/`password=`/`secret=`、`Bearer …`。运行时事件环上限 400 条，管理器内存事件上限 500 条。

---

## 9. 用户干预

| 操作 | 管理器行为 | 运行时行为 | 结果 |
| --- | --- | --- | --- |
| **Pause** | `pause()` → 发送 `pause` 消息，返回 `{ ok: true, state: 'PAUSING' }` | 有任务时 `controller.pause()` 并广播 `PAUSING`，随后在下一个操作边界真正暂停并广播 `PAUSED`；空闲时直接广播 `PAUSED` 并记 `pause acknowledged while idle`；任务尚在受理（`controller` 未建立）时先记为 `pauseRequested`，`TaskController` 一就绪立即生效（§10.4） | 不再启动新的工具动作；已开始的原子命令不会被劈开，`TaskController.cancel` 仍能每 100 ms 抢占暂停门，暂停不会导致取消失效 |
| **Resume** | `resume()` → 发送 `resume` | `controller.resume()` 并广播 `RUNNING`；空闲时广播 `IDLE` | 任务从下一个操作继续 |
| **Stop** | `stop()` → `intentionalStop = true` → `STOPPING` → 发送 `shutdown` 与 `stop_task` → 等待进程退出（默认 5000 ms）→ `killTree` → `finalizeStop` | 收到 `shutdown` 后取消当前命令、回 `bye`，随后退出 | 当前任务记为 `cancelled`（`code: CANCELLED`，`needs_controller_review: false`），状态回 `OFF`，释放锁与 ownership 记录 |
| **Cancel Task** | `cancelTask()` → 发送 `stop_task`；worker 进程**保持存活** | `controller.cancel(reason)` + 一条 `log`（`task cancel requested: …`），杀掉当前子命令树；**不**广播 `STOPPING`（该状态只留给停止 worker 进程本身） | 结果 `status: "cancelled"` / `code: CANCELLED`；若暂停中也会被唤醒取消 |
| **Send Note** | `sendNote(note)`：字符串转 `{ note }`，对象原样；三者全空 → `{ ok: false, reason: 'a note must contain text or explicit constraints' }`；否则入 `pendingNotes`；worker 在运行就立即发 `note` 消息（`delivered: true`），空闲时不发送、只留在 `pendingNotes`，等下次派发时随任务逐条补发 | 有活动任务（`controller` 存在）时 `controller.addNote(note)`；**空闲**时把 note 存进 `state.idleNotes` 并回 `note_applied`（`applied: false, queued: true`，effects 为 `['queued while idle; it will apply to the next task']`），在下一个任务被受理、`TaskController` 建好后、**第一个执行边界之前**注入 | 在下一次执行边界注入，绝不粗暴打断当前原子操作；空闲期收到的 note 永不丢弃 |
| **Take Over** | `takeOver()`：捕获现场 → 发送 `take_over` → 等 150 ms → 记录 `handoff` 结果 → 杀进程树 → 清 ownership → 清工作区锁 → `forceState('HANDOFF', { handoff })` → 落 `tasks/handoff.json` | `controller.pause('workspace handover')`，广播 `HANDOFF`，返回含 `live_view` 的 handoff 载荷 | 状态 `HANDOFF`，工作区交回 Controller/用户；此后派发会被拒绝，需先 `clearHandoff()`（→ `OFF`）再重启 worker |

### 9.1 Note 的解析与生效

`TaskController.addNote` 同时支持结构化与自然语言两种形态：

- **结构化**：`{ forbid: ["src/ipc/**"], allow: ["src/storage/**"] }`
  - `forbid[]` 逐项规范化（`\` → `/`）后追加到 `runtimeForbidden`，effect 记为 `forbidden += <pattern>`；
  - `allow[]` 非空时追加到 `runtimeAllowed`（可累积），effect 记为 `allowed = <a, b>`。
- **自然语言**（正则解析，中英文皆可）：

```text
/(?:do not|don't|never|不要|不得|禁止)[^\n]{0,12}?(?:modify|change|touch|edit|write|修改|改动|触碰|写入)\s*([^\s,;。；]+)/i   → runtimeForbidden
/(?:only|仅|只)[^\n]{0,12}?(?:fix|modify|change|edit|touch|修改|改动|修复)\s*([^\s,;。；]+)/i                                → runtimeAllowed
```

两个捕获组都排除了空白，且命中后还会去掉结尾标点（`.replace(/[.,;:。；：]+$/, '')`）：所以 `Do not modify b.txt.` 记为 `forbidden += b.txt`（而不是把句号一并吃进 pattern）；也正因为捕获组不跨空白，`Only fix storage implementation.` 只记为 `allowed = storage`，多词路径请用结构化 `allow`。例如 `Do not modify IPC. Only fix storage implementation.` 解析为 `forbidden += IPC`、`allowed = storage`。

生效方式与边界：

- Note 记录为 `{ note, forbid?, allow?, applied: false, at, effects }`；`applyPendingNotes()` 在每个操作边界把未生效的 note 标记 `applied: true` 并补充 `applied_at` / `applied_at_operation = operationIndex`，同时发 `note_applied` 事件（含 `effects`）。
- 管理器侧的 `markNotesApplied()` 只在拿到**正面确认**时才把 `pendingNotes` 标记 `applied: true`：worker 在某个执行边界真的生效（`event` 消息里的 `note_applied`），或一条**不带** `applied: false` 的 `note_applied` 回执。空闲回执 `{ applied: false, queued: true }` 只是“已排队，将于下一个任务生效”的确认，note 会一直保持 pending，直到 worker 真的生效为止（任务结束的 `handleResult` 也会收尾标记）。
- worker 空闲期间的 note 同时留在两处：管理器 `pendingNotes` 与 worker 的 `state.idleNotes`。前者在下次派发时（`drainQueue` 发出 `assign_task` 之后）逐条补发，后者在 `TaskController` 建好后立即 `addNote` 注入，两者都由 `applyPendingNotes()` 在第一个操作边界统一生效。
- `controller.effectiveTask(task)` 把 `runtimeForbidden` 追加到 `forbidden_paths`、把 `runtimeAllowed` 追加到 `allowed_paths`，即时的路径策略收紧/放宽；该结果同时用于操作检查与验收命令检查。
- Note **不能**绕过权限位（`write` / `shell` / `git_commit` / `network`）、`DENIED_COMMAND_PATTERNS`、关键模块删除守卫与 `.git` 保护。

---

## 10. 状态机

### 10.1 生命周期状态 `WORKER_STATES`（13 个）

```text
OFF  STARTING  IDLE  ASSIGNED  RUNNING  PAUSING  PAUSED  BLOCKED
READY_FOR_REVIEW  FAILED  STOPPING  CRASHED  HANDOFF
```

工程书 §5 列出的状态是 `OFF / STARTING / IDLE / ASSIGNED / RUNNING / PAUSED / BLOCKED / READY_FOR_REVIEW / FAILED / STOPPING / CRASHED`；实现额外显式化了 `PAUSING`（Pause 的过渡态，对应“不再启动新的 tool action”）与 `HANDOFF`（Take Over 的终态，对应“工作区交给 Controller”）。

### 10.2 执行阶段 `EXECUTION_STAGES`（7 个，与生命周期分开记录）

```text
INSPECTING  PLANNING_EXECUTION  IMPLEMENTING  TESTING  FIXING  VALIDATING  REPORTING
```

### 10.3 `TRANSITIONS` 合法迁移表（`state.cjs`，逐条照抄）

| From | 允许的 To |
| --- | --- |
| `OFF` | `STARTING` |
| `STARTING` | `IDLE`, `FAILED`, `CRASHED`, `STOPPING` |
| `IDLE` | `ASSIGNED`, `STOPPING`, `CRASHED`, `FAILED`, `HANDOFF`, `PAUSED` |
| `ASSIGNED` | `RUNNING`, `IDLE`, `STOPPING`, `FAILED`, `BLOCKED`, `PAUSING`, `CRASHED`, `HANDOFF` |
| `RUNNING` | `PAUSING`, `PAUSED`, `READY_FOR_REVIEW`, `BLOCKED`, `FAILED`, `STOPPING`, `CRASHED`, `IDLE`, `HANDOFF` |
| `PAUSING` | `PAUSED`, `RUNNING`, `STOPPING`, `CRASHED`, `FAILED`, `HANDOFF` |
| `PAUSED` | `RUNNING`, `STOPPING`, `IDLE`, `HANDOFF`, `CRASHED`, `FAILED`, `BLOCKED` |
| `BLOCKED` | `IDLE`, `STOPPING`, `RUNNING`, `HANDOFF`, `CRASHED`, `FAILED` |
| `READY_FOR_REVIEW` | `IDLE`, `STOPPING`, `ASSIGNED`, `HANDOFF`, `CRASHED`, `FAILED` |
| `FAILED` | `IDLE`, `STARTING`, `STOPPING`, `HANDOFF`, `CRASHED` |
| `STOPPING` | `OFF`, `CRASHED`, `HANDOFF` |
| `CRASHED` | `STARTING`, `OFF`, `STOPPING`, `HANDOFF` |
| `HANDOFF` | `STARTING`, `OFF`, `STOPPING` |

规则：

- `canTransition(from, to)` 对未知状态返回 `false`，`from === to` 返回 `true`；`assertTransition` 抛 `ILLEGAL_TRANSITION`。
- 管理器侧用 `setState()` 走合法迁移；非法迁移只记日志并忽略（`refusing illegal transition X -> Y`）。worker 上报的状态若非法同样被忽略（`ignoring worker-reported transition X -> Y`）。
- `forceState()` 是**对账**专用：当现实（进程已死/已被回收）已经决定结果时，仅让记录跟上。
- `isBusyState(state)` = `ASSIGNED` / `RUNNING` / `PAUSING` / `PAUSED` / `BLOCKED`；`isTerminalTaskStatus` = `completed` / `failed` / `blocked` / `cancelled` / `rejected` / `unsupported_capability` / `handoff`。
- `IDLE → PAUSED` 的存在让「空闲时 Pause」有意义：worker 停在 `PAUSED`，不启动新任务（runtime 空闲收到 `pause` 时直接广播 `PAUSED` 并记 `pause acknowledged while idle`），直到 `Resume` 把它送回 `IDLE`。
- 结果状态到生命周期的落点（`handleResult`）：`blocked`/`rejected`/`unsupported_capability` → `BLOCKED`；`cancelled`/`handoff` → `IDLE`；`completed` → `READY_FOR_REVIEW`；其余 → `FAILED`。
- 运行时结算（`runtime.cjs`）：`completed` → `READY_FOR_REVIEW`；`blocked` → `BLOCKED`；`cancelled` → `IDLE`；其他 → `FAILED`。

### 10.4 控制消息与派发保证

- **只有 `assign_task` 被串行化**：`runtime.cjs#enqueue` 把 `assign_task` 排进 `taskChain`（长任务独占这条链），其余消息 —— `pause` / `resume` / `stop_task` / `note` / `take_over` / `shutdown` / `ping` —— **一律立即处理**。所以 Pause、Stop 与 Send Note 能真正到达**正忙**的 worker；把它们排在运行中的任务后面，会让它们在用户最需要的时候恰好失效。
- **受理期间的 Pause / Stop 会被记住、不会丢**：`handlePause` / `handleStopTask` 在 `controller` 尚未建立、但 `state.taskInFlight` 为真（任务正在受理）时，只置 `pauseRequested` / `stopRequested`（并回一条 `log`：`pause will apply before the task starts` / `stop will apply before the task starts`）；`TaskController` 一建好就立刻 `controller.pause(...)` / `controller.cancel(...)`（`handleAssignTask`）。受理期间到达的 `resume` 则撤销尚未生效的 pause 请求（`pause request withdrawn before the task started`）。
- **任务取消不是 worker 停止**：`stop_task`（Cancel Task）只调用 `controller.cancel(reason)` 并记一条 `task cancel requested: …` 日志，**不**把生命周期置为 `STOPPING` —— `STOPPING` 保留给停止 worker 进程本身（`manager.stop()`）。worker 进程保持存活并继续接受新任务。
- **任何时刻最多一个任务在飞**：runtime 在忙时（`state.taskInFlight` 或已有 `state.currentTask`）直接拒绝第二个 `assign_task`，回 `blocked` 结果（`code: BLOCKED`，reason 形如 `worker sub-1 is not accepting work (state RUNNING, task boss-kb-031)`）；`HANDOFF` 状态另有专门文案（`the worker handed the workspace over to the Controller; restart it before dispatching work`）。因为 `maxWorkers = 1`，manager 自己永远不会这样派发，但这条拒绝是协议契约的一部分。
- **可接受下一个任务的状态**：`TASK_ACCEPTING_STATES = ['STARTING', 'IDLE', 'READY_FOR_REVIEW', 'BLOCKED', 'FAILED']`（并要求 `taskInFlight` 为假且 `currentTask` 为空）。`READY_FOR_REVIEW` / `BLOCKED` / `FAILED` 是**任务**结论，Controller 的下一个决定就是一个新任务，所以必须接受；`PAUSED` 与 RUNNING 家族不接受新工作。
- **结果对账**：`handleResult` 记录终态之后，如果 worker 进程仍然存活（`isRunning`）而记录到的状态不在 `IDLE` / `READY_FOR_REVIEW` / `FAILED` / `BLOCKED` 之内（例如一次中途用户操作留下的 `STOPPING` / `PAUSING`），就直接把状态对账为 `IDLE`，不因为一次过期的状态而让队列停摆。

---

## 11. 崩溃恢复与退出行为

### 11.1 CRASHED 与重启

- worker 进程非预期退出 → `handleExit(code, signal)`：清理 ownership、释放工作区锁；若存在当前任务，写入 `status: "failed"` / `code: CRASHED` 的终态记录（`reason: worker process exited unexpectedly: code=… signal=…`）；若为主动停止或状态已是 `STOPPING`/`OFF`/`HANDOFF` 则落到 `OFF`；否则记一次 crash 时间戳、`forceState('CRASHED')`，并推送通知 `Sub-worker crashed` / `Last task: <task_id>`。
- worker 侧自身崩溃也上报：`uncaughtException` / `unhandledRejection` → 发送 `error`（`code: CRASHED`）、广播 `CRASHED`、`flushAndExit(1)`；管理器收到 `code === CRASHED` 的 `error` 消息时同样进入 `CRASHED`。
- 重启路径：面板/托盘的 `Restart`（`restart()` = `stop()` + `start()`，`restarts` 计数 +1）；`CRASHED` 状态下托盘最后一项标签变为 `Restart Worker`；Mega 面板在 `CRASHED` 时显示 `Sub-worker crashed. Last task: …`。
- 断点续跑：`resumeLastTask()`（面板“恢复上次中断任务”）从 history 中找最近一个 `failed` / `cancelled` / `handoff` 条目，读取 `data/sub-worker/tasks/<task_id>.json` 中保存的**原始任务对象**重新派发（`source: 'crash-resume'`，显式派发）；找不到可重放 specification 时返回 `no interrupted task with a replayable specification was found`。

### 11.2 孤儿进程回收

- 启动时 `createWorkerManager()` 先 `hydrate()`，再执行 `runtimeProcess.recoverStaleWorker({ root, entry: app/sub-worker/runtime.cjs })`：读取 `runtime/sub-worker-process.json`；若记录的父进程已不存在且子进程命令行确实包含该 runtime 入口（`isExpectedWorkerProcess`），则 `taskkill /T /F` 回收并清除记录；父进程仍在则不触碰。
- `hydrate()` 本身也会对账残留状态：持久化状态不是 `OFF`/`HANDOFF` 且当前没有运行中的子进程时，`STOPPING` → `OFF`，其余 → `CRASHED`（`pid` 置空，`lastError` 记 `worker was not running when the shell restarted`）。
- ownership 记录格式泛化但向后兼容：`writeOwnership({ root, type, pid, entry, parentPid, … })` 同时写 `childPid` 与 `pid`，`migrateOwnership` 会规范化旧格式并记录改动。

### 11.3 退出顺序

`Exit DS-Harness`（`gracefulExit` → `teardownManagedResources`）：

```text
stop scheduler/extensions（持久化队列与历史）
  → stopSubWorkerOnExit('shell teardown')
       → prepareExit()：busy 时先发 pause，flush state + queue
       → forceStop()：杀 worker 进程树、清 ownership、释放锁、状态置 OFF
  → 销毁集成视图与主窗口
  → stopHarness()（官方 Harness 进程树）
  → app.quit()
```

`Force Exit DS-Harness`（`forceExit`）：

```text
标记 shuttingDown
  → teardownManagedResources（同上顺序，best-effort flush → kill worker tree → kill harness tree）
  → app.exit(0)
```

两条路径都不允许任何清理步骤阻塞退出：`stopSubWorkerOnExit` 内部对 `prepareExit` / `forceStop` 各自 try/catch，失败只写 `logs/desktop-runtime.log`；`before-quit` 也会调用 `teardownManagedResources()`。目标：不留 orphan worker。

---

## 12. 持久化与日志

`state.cjs#paths(root)` 定义了全部落盘位置（`root` 默认 `process.env.DSH_ROOT` 或仓库根）：

```text
data/sub-worker/config.json           控制器侧配置（SubWorkerStore.saveConfig）
data/sub-worker/state.json            最近状态 + handoff（write-then-rename）
data/sub-worker/queue.json            已受理但未派发的任务（上限 100 条）
data/sub-worker/history.json          终态任务记录（上限 200 条，最新在前）
data/sub-worker/tasks/<task_id>.json  单任务完整审计记录（派发记录 + 终态 + 结果 + 最近 300 条事件）
data/sub-worker/workspace-lock.json   单写者工作区锁
runtime/sub-worker-process.json       孤儿回收用的 ownership 记录（与 runtime/dsh-process.json 独立）
logs/sub-worker.log                   worker 运行时日志（含 [worker:sub-1] 前缀行）
logs/sub-worker/<task_id>.log         单任务日志（逐事件一行，已脱敏）
```

- **全部被 git 忽略**：`.gitignore` 忽略 `data/*`、`runtime/`、`logs/`（以及 `*.log`），因此上述文件与目录永不进入版本库。
- **单写者**：`data/sub-worker/**` 的写入由 `WorkerManager`（`manager.cjs`）独占 —— 队列、历史、状态、任务记录与锁只有一个写者，天然无竞争。`runtime.cjs` 侧的注释明确写出这一契约：worker 的持久化产出只有日志文件与 `result` 消息；它在 `main()` 中调用 `store.ensureDirs()` 只是为了确保日志/任务目录存在（不写任何 JSON 状态文件），并读取生效配置（`store.loadConfig()`，即 §13.2 的三层合成结果）。
- `writeJsonFile` 采用「先写 `.tmp` 再 `rename`」，崩溃不会留下半写文件；所有读写方法都吞掉异常并记日志（`sub-worker … save failed: …`），状态目录损坏不会拖垮 Harness。
- 脱敏：任务日志、事件的**所有字符串字段**（`redactEvent`）、`readTaskLog` 的返回内容、worker stderr 均经 `redactSecrets`；管理器是落盘与送 UI 的唯一写入者，因此脱敏在事件进入管理器时再执行一次（纵深防御）。
- 面板的 `Task Log` 按钮读取 `logs/sub-worker/<task_id>.log` 的**最后 400 行**。

---

## 13. 配置参考

### 13.1 `config/app.json` 的 `subWorker` 块（出厂默认）

```json
"subWorker": {
  "enabledOnStartup": false,
  "maxWorkers": 1,
  "autoDelegate": false,
  "workspaceMode": "isolated_worktree",
  "keepChangesOnStop": true,
  "allowGitCommit": false,
  "showNotifications": true
}
```

| 键 | 默认 | 语义 |
| --- | --- | --- |
| `enabledOnStartup` | `false` | 为 `true` 时启动末尾自动 `start({ reason: 'enabledOnStartup' })`；默认保证启动体验不变 |
| `maxWorkers` | `1` | Phase 1 固定 1；`WorkerManager` 实际计算为 `Math.max(1, Math.min(1, …))`，永远为 1 |
| `autoDelegate` | `false` | 自动派发开关，默认关闭（见 §14） |
| `workspaceMode` | `"isolated_worktree"` | 仅接受 `isolated_worktree` / `shared` |
| `keepChangesOnStop` | `true` | 为 `false` 时，**仅在被取消/停止的任务**（`status !== 'completed'`）上对隔离 worktree 执行 `git checkout -- .` 回滚；已完成任务永远保留（其改动正是待验收的成果），共享工作区永不回滚 |
| `allowGitCommit` | `false` | `git commit` / `git tag` 的第二重门；为 `false` 时提交被判 `REQUIRES_CONTROLLER` |
| `showNotifications` | `true` | 是否发送终态/崩溃的系统通知（`desktop-main.cjs#maybeNotifySubWorker` 与 `handleResult` 都检查它） |

这个块**不只是一份声明，而是真的会被读取**：`SubWorkerStore.loadConfig()` 通过 `state.cjs` 导出的 `declaredConfig(root)` 把它作为生效配置的一层，`data/sub-worker/config.json` 再逐键覆盖它（§13.2）。

### 13.2 生效配置与 `data/sub-worker/config.json` 覆盖文件

运行时生效配置由**三层**合成，而不是只看 `data/sub-worker/config.json`：`SubWorkerStore.loadConfig()` 会依次叠加 `state.cjs#defaultConfig()` ← `config/app.json` 的 `subWorker` 块（由新增导出的 `declaredConfig(root)` 读取，缺失或不可解析时按空对象处理）← `data/sub-worker/config.json`，并且**持久化文件逐键取胜**（`{ ...declaredConfig(this.root), ...persisted }` 之后再经 `publicConfig()` 归一化）。`SubWorkerStore` 在构造函数里保存 `this.root = this.paths.root`，`loadConfig()` 用的就是这个 root，所以配置解析与 `paths(root)` 的 root 归一化完全一致。也就是说 `config/app.json` 的 `subWorker` 块是**真正被读取的出厂默认值声明**，用户在面板上的选择（`sub-worker:update-config` → `saveConfig()` → `data/sub-worker/config.json`，也可直接编辑该文件）逐键覆盖它；两层都没有给出某个键时，才落到 `defaultConfig()`。

`defaultConfig()` / `publicConfig()` 的完整键集合与归一化规则：

| 键 | 默认 | 归一化 |
| --- | --- | --- |
| `enabledOnStartup` | `false` | 仅 `=== true` 为真 |
| `maxWorkers` | `1` | 有限且 `>= 1` 取整，否则默认值 |
| `autoDelegate` | `false` | 仅 `=== true` 为真 |
| `workspaceMode` | `"isolated_worktree"` | 仅接受两个合法值 |
| `keepChangesOnStop` | `true` | 仅 `=== false` 为假 |
| `allowGitCommit` | `false` | 仅 `=== true` 为真 |
| `showNotifications` | `true` | 仅 `=== false` 为假 |
| `commandTimeoutMs` | `1800000`（30 分钟） | 加法键：正数取整，否则默认值；单条命令的默认超时 |
| `heartbeatMs` | `2000` | 加法键：正数取整，否则默认值；worker 心跳间隔 |

`commandTimeoutMs` 与 `heartbeatMs` 未在 `config/app.json#subWorker` 中声明（该块只列出上面 7 个键），默认值只由 `state.cjs#defaultConfig()` 提供；两者都属于实现侧的加法配置项，仍可被 `data/sub-worker/config.json` 覆盖。

---

## 14. 故障隔离保证

- **worker 崩溃不影响 Harness**：`runtime.cjs` 把每条失败路径都收在自己进程内（`uncaughtException` / `unhandledRejection` / handler 异常 / 任务异常都转成结构化 `error` 或 `result` 并以非零/零码退出），父进程最多观察到一个退出码与一条结构化消息；Harness 端口（默认 3080，可经 `DSH_HARNESS_PORT` 覆盖见 §14.1）与官方 UI 无关联。
- **管理器从不向 shell 抛异常**：所有致错路径都被收敛 —— `safeCall()` 包裹 ownership 读写与消息处理；`consume()` 对每条消息单独 `safeCall`；事件/通知监听器逐个 try/catch；`releaseWorkspaceLock`、`persistState`、`persistQueue` 全部 on-error 记录。
- **IPC 全部兜底**：`registerSubWorkerIpc` 的 `guard()` 包裹每个 handler，异常一律返回 `{ ok: false, error: '…' }` 并写 `logs/desktop-runtime.log`，绝不产生未处理的 rejected promise。
- **Mega/dock 侧**：`subWorkerSnapshot()` 与 `safeWorkerCall()` 捕获一切异常；shell 未注入 manager 时面板显示 `UNAVAILABLE` 而不是报错；Live View 通道不可用时只提示文案。
- **观测不打断执行**：`EventBus.emit` 从不对订阅者或传输回调抛出的异常做传播；reporter 记录日志失败只返回 `false`。
- **`maxWorkers` 在 Phase 1 恒为 1**：契约与实现（`Math.max(1, Math.min(1, …))`）都固定单 worker，因此同一时刻只有一个执行器持有一个工作区锁。
- **回归覆盖**：Sub-worker 的单元测试是 `tests/unit/` 下的这 8 个文件 —— `sub-worker-protocol.test.js`、`sub-worker-permissions.test.js`、`sub-worker-state.test.js`、`sub-worker-reporter.test.js`、`sub-worker-task-runner.test.js`、`sub-worker-manager.test.js`、`sub-worker-ui.test.js`、`sub-worker-default-regression.test.js`；此外 `tests/unit/mega-extension-integration.test.js`（托盘子菜单与快照）与 `tests/unit/architecture-contract.test.js`（`subWorkerTrayItem` 契约）覆盖集成面。真实 Electron 的端到端验收不在单元套件内，见 §14.1。

### 14.1 运行与验证：端口隔离与端到端验收

单元回归：在 `app/` 目录下执行 `npm test`（等于 `node --test ../tests/unit/*.test.js`），上一段的 8 个 Sub-worker 文件即在其中。

**加法端口覆盖 `DSH_HARNESS_PORT`（`app/desktop-main.cjs`）**：`HARNESS_PORT = Number(process.env.DSH_HARNESS_PORT) > 0 ? Number(process.env.DSH_HARNESS_PORT) : 3080`。默认行为完全不变（仍是 3080），默认启动行也仍然是 `['<dsh bin>', 'web', '--no-open']`；只有当该环境变量被设成正数时，shell 才 ① 用这个端口做自己的端口占用检查（`isHarnessPortListening`）与导航围栏（`allowedHarnessNavigation`），并 ② 给被托管的 Harness 追加 `--port <n>`（否则子进程仍会去绑默认端口）。它存在的唯一目的，是让一次回归运行能与**一个已经在跑的 DS-Harness 并存**。

**端到端验收脚本**：`node scripts/sub-worker-acceptance.cjs [A|B|all]`（不传参数等同于 `all`）。它**不属于单元套件**：它启动真实的 Electron shell 两次，因此必须完全隔离，绝不打扰已经在运行的 DS-Harness —— 脚本先把 `app/` 复制到 `temp/e2e-default` / `temp/e2e-enabled` 的临时 root（`app/node_modules` 用 `mklink /J` 做成 junction，不重复下载依赖），再往该 root 写一份自己的 `config/app.json`（把 `harness.port` 从 3080 挪开：A 用 3210、B 用 3211）并拷贝 `config/.env`，最后用 `DSH_ROOT` / `DSH_HOME` / `DSH_HARNESS_PORT` / `DSH_STARTUP_TIMEOUT_MS` / `DSH_MEGA_OBSERVE_MS` 指向该 root 启动 `electron app`；临时副本保留在 `temp/e2e-*` 供事后检查。

| 运行 | 配置 | 断言 |
| --- | --- | --- |
| **A（默认）** | 不写 `data/sub-worker/config.json` | 共享断言：抓到官方 Harness 的鉴权 URL；官方 UI 的启动序列出现（日志 `--- DSH launch begin ---`）；Mega dock 挂载；`extension started: mega`；`sub-worker manager ready; state=OFF`（管理器就绪且惰性）；shell 启动后仍存活；托管 Harness 子进程的 ownership 记录（`runtime/dsh-process.json`）存在且其 `childPid` 进程存活。**额外**：没有 `data/sub-worker` 目录；没有 `runtime/sub-worker-process.json`；没有 worker 进程（按命令行含 `sub-worker[\\/]runtime.cjs` 且属于该 scratch root 筛选）；`logs/sub-worker.log` 为空（0 字节或不存在） |
| **B（开启）** | 写入 `data/sub-worker/config.json` = `{"enabledOnStartup": true, "maxWorkers": 1, "showNotifications": false}` | 共享断言同 A；**额外**：恰好 1 个 worker 进程（`maxWorkers = 1`），其命令行指向 `sub-worker/runtime.cjs`；ownership 记录是带类型的（`type === "sub-worker"`）；`data/sub-worker/state.json` 的 `state === "IDLE"`；`logs/sub-worker.log` 存在 |
| **优雅退出（每个运行）** | 关闭窗口 = `taskkill /PID <shell pid>`（**不带** `/F`，即文档化的正常退出路径） | 日志出现 `graceful exit requested` 或 `before-quit: reconciling managed resources`；shell 进程退出；没有托管的 Harness 子进程残留 |
| **退出之后（B）** | 同上 | 没有孤儿 worker 进程；`runtime/sub-worker-process.json` 已清除；`data/sub-worker/state.json` 的 `state === "OFF"` |

脚本结束打印 `N/M checks passed`，任一断言失败即以非零退出码结束。之所以必须隔离而不是写进单元套件：它要的是真实产品行为（真实 Electron、真实被托管的 DSH 子进程、真实 worker 进程、真实关窗退出顺序），这些只有在自己的 root、自己的 data 目录、自己的 Harness 端口下跑，才不会与正在使用的 DS-Harness 互相干扰。

---

## 15. Phase 1 未实现（明确边界）

```text
多个 worker（maxWorkers > 1）
远程 / 分布式 worker
worker 与 worker 之间的自由对话或通信
第二个 Electron 窗口（worker 无 GUI，只有 Mega 面板与 Live View）
```

- **Auto Delegate 默认 OFF**：`autoDelegate: false` 时 `canAutoDelegate` 直接返回 `{ eligible: false, reason: 'auto delegate is OFF' }`，Controller 只有显式派发才会下达任务。
- **`autoDelegate: true` 到底做了什么**：它只让 Controller 可以自动派发**同时满足两个条件**的任务 ——
  1. 任务本身已携带**完整可执行 specification**（`operations` 非空，且通过 `guardTask`：风险等级 L0–L2、read 权限、`required_vision` 不成立、`isolated_worktree` 有 `target_repo`）；
  2. `objective` 文本命中允许类别：`implementation`、`tests`、`lint`、`docs`、`small refactor`（中英文正则）。

  并且**永不**自动派发以下类别（命中即 `eligible: false`，`reason: "<category> is never auto-delegated"`）：`architecture redesign`、`security-sensitive`、`deployment`、`large deletion`、`research direction`、`high-risk migration`。
- 自动派发与非自动派发走同一条路径（`assignTask(task, { source, explicit: false })` 只是多一道闸门），仍需通过队列上限与工作区锁检查；因此“开启 autoDelegate”不会改变 worker 的权限边界，也不会让 worker 获得 Controller 权力。

---

## 16. 完整示例

### 16.1 Task Object（派发）

```json
{
  "version": 1,
  "task_id": "boss-kb-031",
  "created_at": "2025-06-01T07:41:02.114Z",
  "objective": "Implement SQLite knowledge-store adapter",
  "target_repo": "D:\\Boss",
  "workspace": null,
  "workspace_mode": "isolated_worktree",
  "allowed_paths": ["src/knowledge/**", "tests/knowledge/**"],
  "forbidden_paths": ["src/ipc/**"],
  "acceptance": ["All existing tests pass", "No public API breaking changes"],
  "acceptance_commands": ["npm test -- knowledge"],
  "permissions": {
    "read": true,
    "write": true,
    "shell": true,
    "git_commit": false,
    "network": false
  },
  "risk_level": "L2",
  "requires_vision": false,
  "operations": [
    { "op": "git_status" },
    { "op": "list_dir", "path": "src/knowledge" },
    { "op": "read_file", "path": "src/knowledge/store.ts" },
    {
      "op": "write_file",
      "path": "src/knowledge/sqlite.ts",
      "content": "import { createRequire } from 'node:module'\n\nexport function createSqliteStore(file) {\n  const require = createRequire(import.meta.url)\n  const Database = require('better-sqlite3')\n  return new Database(file)\n}\n"
    },
    {
      "op": "replace_in_file",
      "path": "src/knowledge/index.ts",
      "find": "export * from './store'",
      "replace": "export * from './store'\nexport * from './sqlite'",
      "expect_occurrences": 1
    },
    { "op": "run_tests", "command": "npm test -- knowledge", "timeoutMs": 600000 },
    { "op": "git_diff" }
  ]
}
```

派发结果（`manager.assignTask` 的返回值，非任务结果）：

```json
{ "ok": true, "accepted": true, "queued": true, "task_id": "boss-kb-031", "queue_length": 1 }
```

工作区准备结果：`D:\Boss-worktrees\hns-sub-worker`（`git worktree add --detach`），锁文件：

```json
{ "task_id": "boss-kb-031", "workspace": "D:\\Boss-worktrees\\hns-sub-worker", "mode": "isolated_worktree", "pid": 41208, "at": "2025-06-01T07:41:02.980Z" }
```

### 16.2 Result Object（`completed`）

```json
{
  "task_id": "boss-kb-031",
  "status": "completed",
  "summary": "Executed 7 operation(s) for \"Implement SQLite knowledge-store adapter\". 2 file(s) changed. Tests: 43 passed / 0 failed.",
  "changed_files": [
    "src/knowledge/sqlite.ts",
    "src/knowledge/index.ts"
  ],
  "changed_file_details": [
    { "path": "src/knowledge/sqlite.ts", "status": "A" },
    { "path": "src/knowledge/index.ts", "status": "M" }
  ],
  "tests": { "passed": 43, "failed": 0, "skipped": 1, "parser": "jest-style" },
  "git": { "dirty": true, "commit": "9f1c2ab7d4e05f3a6c81b0d9e4f7a2c5b8d13e60", "branch": "HEAD" },
  "warnings": [],
  "needs_controller_review": true,
  "code": "OK",
  "reason": null,
  "needs_controller_decision": false,
  "requires_controller": false,
  "acceptance": [
    {
      "criterion": "acceptance command: npm test -- knowledge",
      "status": "passed",
      "verified": true,
      "exitCode": 0
    }
  ],
  "stage_log": [
    { "stage": "INSPECTING", "at": "2025-06-01T07:41:03.021Z" },
    { "stage": "IMPLEMENTING", "at": "2025-06-01T07:41:03.204Z" },
    { "stage": "TESTING", "at": "2025-06-01T07:41:35.771Z" },
    { "stage": "PLANNING_EXECUTION", "at": "2025-06-01T07:41:51.488Z" },
    { "stage": "VALIDATING", "at": "2025-06-01T07:42:02.339Z" },
    { "stage": "REPORTING", "at": "2025-06-01T07:42:11.406Z" }
  ],
  "started_at": "2025-06-01T07:41:02.990Z",
  "finished_at": "2025-06-01T07:42:11.995Z",
  "workspace": "D:\\Boss-worktrees\\hns-sub-worker",
  "worker_id": "sub-1"
}
```

说明：`git.branch` 为 `HEAD` 是因为隔离 worktree 是 detached 检出；`acceptance` 只包含自动命令条目（提供了 `acceptance_commands` 时，`acceptance` 里的自然语言条目不再生成 `manual_review` 行）。`ok` 是**非枚举**派生字段（`status === 'completed'`），序列化时不会出现。

### 16.3 其他典型结果

以下为关键字段摘录（`changed_files` / `changed_file_details` / `tests` / `git` / `stage_log` / `started_at` / `finished_at` 等字段同样存在于每一个结果对象中，此处省略）。

无 specification（`operations: []`）：

```json
{
  "task_id": "boss-kb-032",
  "status": "blocked",
  "summary": "the task carries no executable specification (operations); the worker will not invent an implementation plan",
  "code": "MISSING_SPECIFICATION",
  "reason": "the task carries no executable specification (operations); the worker will not invent an implementation plan",
  "needs_controller_review": true,
  "needs_controller_decision": true,
  "requires_controller": true
}
```

L3 任务：

```json
{
  "task_id": "boss-kb-033",
  "status": "rejected",
  "summary": "risk level L3 (architecture_modification) is outside the executor contract; the Controller must own it",
  "code": "REQUIRES_CONTROLLER",
  "reason": "risk level L3 (architecture_modification) is outside the executor contract; the Controller must own it",
  "needs_controller_review": true,
  "needs_controller_decision": true,
  "requires_controller": true
}
```

`requires_vision: true`：

```json
{
  "task_id": "boss-kb-034",
  "status": "unsupported_capability",
  "summary": "task requires vision but the worker runtime cannot see images",
  "code": "UNSUPPORTED_CAPABILITY",
  "requires_controller": true
}
```

写操作触碰 `.git`（`write_file` 的 `path` 为 `.git/config`）：

```json
{
  "task_id": "boss-kb-035",
  "status": "failed",
  "summary": "path .git/config is repository metadata and is never written by the worker",
  "code": "PATH_FORBIDDEN",
  "needs_controller_review": true,
  "needs_controller_decision": true
}
```

提交到受保护分支（`run_command: "git commit -m x"`）：

```json
{
  "task_id": "boss-kb-036",
  "status": "blocked",
  "summary": "committing to protected branch main requires the Controller",
  "code": "REQUIRES_CONTROLLER",
  "requires_controller": true
}
```

---

## 附录 A：IPC 通道（`SUB_WORKER_CHANNELS`，17 条）

```text
sub-worker:snapshot          读取 manager.describe()
sub-worker:start             workerManager.start({ reason: 'panel' })
sub-worker:stop              workerManager.stop({ reason: 'panel' })
sub-worker:restart           workerManager.restart({ reason: 'panel' })
sub-worker:pause             workerManager.pause(reason)
sub-worker:resume            workerManager.resume(reason)
sub-worker:cancel-task       workerManager.cancelTask(reason)
sub-worker:assign-task       workerManager.assignTask(task)
sub-worker:send-note         workerManager.sendNote(note)
sub-worker:take-over         workerManager.takeOver({ reason })
sub-worker:clear-handoff     workerManager.clearHandoff()
sub-worker:resume-last       workerManager.resumeLastTask()
sub-worker:update-config     workerManager.updateConfig(patch)
sub-worker:live-view         workerManager.liveViewFor(taskId)
sub-worker:read-log          workerManager.readTaskLog(taskId)
sub-worker:pick-target-repo  dialog.showOpenDialog({ properties: ['openDirectory'] })
sub-worker:release-worktree  workerManager.releaseWorktree(targetRepo)
```

preload 暴露为 `window.megaSubWorker`（snapshot/start/stop/restart/pause/resume/cancelTask/assignTask/sendNote/takeOver/clearHandoff/resumeLast/updateConfig/liveView/readLog/pickTargetRepo/releaseWorktree、`onOpenLiveView`）；托盘 `Open Live View` 通过 `mega:sub-worker-live-view` 通知 dock 打开面板。

## 附录 B：协议消息与传输

```text
Controller → worker : hello  assign_task  pause  resume  stop_task  note  take_over  shutdown  ping
worker → Controller : ready  state  stage  event  result  log  note_applied  heartbeat  pong  error  bye
```

- 帧格式：换行分隔 JSON，`envelope(type, payload, extra) = { v: 1, type, ...extra, payload }`；`LineDecoder` 容忍任意分块边界，单行上限 4 MiB，非法/非对象消息被丢弃并记入 `decoder.errors`。
- 双向校验：`validateMessage(message, direction)` 校验 `v === 1`、消息类型属于该方向白名单、`payload` 是对象；不合法则拒绝发送（管理器）或回 `error: INVALID_MESSAGE`（运行时）。
- 心跳：worker 按 `heartbeatMs`（默认 2000 ms）发送 `heartbeat`；管理器记录 `last_heartbeat_at` 供 Live View 的 `heartbeat` 行显示。
