# DS-HNS 自适应多进程执行框架

> 本文件描述 `Update-Plan/multi-sub.md` 工程书的实现状态与使用方式。
> 上一阶段（单个可选 Sub-worker）的参考文档是 [`sub-worker.md`](./sub-worker.md)；
> 本阶段把它扩展为**硬件感知、实时负载感知、任务依赖感知、冲突感知**的自适应并行执行框架，
> 而双进程模式退化为同一套代码路径上的 `N = 1` 兼容模式。

---

## 1. 它是什么

```text
                        DS-HNS Supervisor (WorkerManager)
                                   │
        ┌──────────────────┬───────┴────────┬──────────────────┐
        ▼                  ▼                ▼                  ▼
 Hardware Profiler   Runtime Monitor   Task Planner      Resource Scheduler
   (安装期)            (运行期)          (DAG)             (limits + state)
        └──────────────────┴───────┬────────┴──────────────────┘
                                   ▼
                            Worker Pool (N 个 runtime.cjs)
                                   ▼
                        Integration / Merge → Validation
```

- **Supervisor**：Electron 主进程里的 `WorkerManager`（`app/sub-worker/manager.cjs`）。它拥有进程、状态与所有落盘产物，不渲染任何界面。
- **Worker**：`app/sub-worker/runtime.cjs` 进程，纯 Node、无 Electron、无端口；只执行 Controller 下达的明确 specification。
- **Controller**：主 HNS 或经过它的外部 Codex。Worker 永远只是执行器。

默认（`adaptiveWorkers: false`）就是**兼容模式**：完全等价于上一阶段的单 Worker 行为，走同一套调度代码，只是池上限为 1（工程书 §36）。

---

## 2. 双层资源限制模型（§3）

```text
effective / desired workers = min(
    cpu_limit, ram_limit, io_limit, thermal_limit, config_limit,
    runnable_tasks + busy_workers,      ← 任务实际并行度（§16）
    hardware ceiling, hard_max          ← 安装期与配置上限
)
```

两个概念必须分开：

| 概念 | 何时得到 | 位置 |
| --- | --- | --- |
| **Hardware Ceiling** 硬件理论能力 | 首次运行探测一次并持久化 | `data/sub-worker/hardware-profile.json` |
| **Runtime Ceiling** 当前真实可用能力 | 每次采样（默认 5 s） | `ResourceScheduler.evaluate()` |

### 2.1 安装期探测（`profiler.cjs`）

一次批量 PowerShell 清单 + `nvidia-smi`（可选）+ 本地 I/O 与内存实测，得到：

```json
{
  "logical_cpu_threads": 24,
  "physical_cpu_cores": 16,
  "cpu_model": "Intel(R) Core(TM) i7-14650HX",
  "ram_total_gb": 31.73,
  "reserved_ram_gb": 6.4,
  "usable_ram_gb": 25.4,
  "gpu_vram_gb": 7.96,
  "storage_type": "nvme",
  "ceilings": { "cpu": 9, "ram": 10, "io": 6, "tier": 6 },
  "tier": { "name": "high", "label": "High" },
  "max_recommended_workers": 6
}
```

规则与工程书一致：

| 维度 | 规则 |
| --- | --- |
| CPU 上限（§4） | `floor(physical_cores × 0.6)`（落在 0.5–0.75 区间内），**不按线程数** |
| RAM 上限（§5、§44） | `reserve = max(总 RAM × 20%, 4 GB)`；`usable = total − reserve`；每 Worker 按最重角色画像 2.5 GB 估算 |
| I/O 上限（§8） | `hdd = 1`、`sata_ssd = 3`、`nvme = 6`；Workstation 档位 + NVMe 放宽到 12 |
| 档位上限（§26） | Low 1 / Standard 3 / High 6 / Workstation 12（RAM 阈值允许 1 GB 误差，因为 32 GB 机器实际报 31.7 GB） |
| GPU（§7） | 只用于 GPU Slot：`floor(可用 VRAM × (1 − 20%) / 4 GB)`；不作为 CPU Worker 数量的决定因素 |
| 换页文件（§5） | 只记录，**绝不**当作可用 RAM |

存储类型判定顺序（全部可降级）：`Win32_DiskDrive` 清单 → 实测 256 KiB 写入+fsync 延迟 → `storage.assumeWhenUnknown`（默认 `sata_ssd`）。
注意：Windows 对**所有**固定磁盘都报 `MediaType = "Fixed hard disk media"`，因此该值**不会**被判为 HDD。

### 2.2 运行期探测与采样（`resources.cjs`）

`ResourceMonitor` 采样：CPU 利用率（`os.cpus()` tick 差值）、可用 RAM、磁盘剩余与实测延迟、GPU/VRAM、电池/电源、温度（若可得）、用户活动（可选）、退化传感器清单。
所有指标缺失时都**优雅降级**并记录在 `degraded` 中，任何传感器不可用都不会阻止 HNS 运行（§9）：

| 缺失 | 回退 |
| --- | --- |
| CPU 温度 | 不猜测：仅在「频率塌陷 + 高负载」同时成立时才判定热限流，否则热限制不生效 |
| 电池 | 视为外接电源 |
| VRAM | `gpuLimit = 0`，不调度 GPU Worker |
| 磁盘类型 | 实测延迟判定 |
| 网络 | 默认**不探测**；`externalService.apiConcurrencyLimit` 直接作为在线并发上限（§31） |

---

## 3. 动态性能状态与防抖（§10、§11、§12）

| 状态 | 进入条件 | 行为 |
| --- | --- | --- |
| `NORMAL` | CPU < 70%、RAM < 75% | 正常分配 |
| `BOOST` | 同上且 effective limit > 1 且队列较深 | **逐步**增加 Worker（每次 1 个） |
| `THROTTLED` | CPU > 85% / RAM > 85% / 温度高 / I/O 严重饱和 / RAM 备用区被突破 | 禁止新增 Worker，逐步缩容，等待自然完成 |
| `CRITICAL` | RAM > 95% / CPU > 96% / 严重热限流 / 磁盘低于备用线 | 停止启动新任务；紧急缩容立即生效（不等延迟） |
| `SAFE_MODE` | 可用 RAM 连**一个** Worker 都放不下（§35） | 池置 0，Supervisor 保留，等待资源恢复 |

防抖与渐进（§11、§12）：

```text
扩容：健康状态持续 ≥ scaling.scaleUpDelaySeconds（默认 30 s）→ 每次 +scale_up_step（默认 1）
缩容：压力持续 ≥ scaling.scaleDownDelaySeconds（默认 60 s）→ 每次 −scale_down_step（默认 1）
      「池比任务量大」不是压力，走更短的 idle_down_grace_seconds（默认 10 s）
紧急：CRITICAL / SAFE_MODE 立即缩容，不等延迟
底线：忙碌的 Worker 永不被裁撤；最低并发 workers.min（默认 1）
```

**安全阀（§10「必要时终止可恢复 Worker」）**：进入 `SAFE_MODE` 且持续 3 个周期仍无法腾空时，Supervisor 取**优先级最低**的运行中节点发出 `stop_task`（该节点可通过 `resume-last` 重放），以便把内存还给主机。

---

## 4. Worker Pool（§13、§14、§32、§33、§34）

- **常驻池**，不是每任务 spawn/kill：Worker 完成任务后回到 idle 并等待下一个节点。
- 只有 crash、心跳超时、判定卡死、环境损坏、超时、版本不匹配才重启（§13）。
- 角色（§14）：`generic / code / test / build / explorer / review / integration`，当前共用同一实现，只通过 `role` + `resource_profile` + `capability` 区分。
- **心跳**（§32）：Worker 每 `heartbeatMs` 上报 `{state, task_id, role, cpu_ms, rss_mb, peak_rss_mb, active_child, output_seq, file_change_seq, last_output_at, last_file_change_at}`。
- **卡死判定**（§33）必须多信号一致，绝不只看运行时长：

| 组合 | 判定 | 动作 |
| --- | --- | --- |
| 无输出 + 无文件变化 + CPU 无增长 + **没有子进程在跑** | `STALLED` | 记录节点失败（`TIMEOUT`）→ 重启 Worker → 重试节点 |
| 有子进程在跑但长时间无输出 | `WAITING` | 只告警，不杀（例如安静的长时间命令） |
| 心跳超过 3 个周期未到 | `UNRESPONSIVE` | 重启 Worker |

- **故障隔离**（§34）：任何 Worker 崩溃都只产生一条结构化失败 + 一次重试；Supervisor 绝不退出。默认 `max_attempts = 2`（基础设施失败重试一次），但策略性拒绝（`REQUIRES_CONTROLLER`、`PATH_FORBIDDEN`、`TASK_REJECTED`…）**从不**重试。

---

## 5. Task DAG、优先级与推测执行（§15、§16、§24、§25）

```text
            Inspect
               │
          Architecture
        ┌──────┼──────┐
        ↓      ↓      ↓
      Code   Tests   Docs
        │      │
        └──┬───┘
           ↓
       Integration → Validation
```

提交一个计划：

```json
{
  "plan_id": "boss-kb-031",
  "objective": "Add the SQLite adapter",
  "target_repo": "D:\\Boss",
  "workspace_mode": "isolated_worktree",
  "acceptance_commands": ["npm test"],
  "nodes": [
    { "node_id": "inspect", "objective": "Inspect", "role": "explorer", "write_scope": ["docs/**"],
      "task": { "risk_level": "L0", "permissions": { "read": true },
                "operations": [{ "op": "list_dir", "path": "." }] } },
    { "node_id": "code", "objective": "Implement", "role": "code", "depends_on": ["inspect"],
      "write_scope": ["src/**"], "acceptance_tests": ["npm test -- sqlite"], "timeout": 600,
      "task": { "risk_level": "L2", "permissions": { "read": true, "write": true, "shell": true },
                "operations": [{ "op": "write_file", "path": "src/sqlite.ts", "content": "..." }] } },
    { "node_id": "validate", "objective": "Full suite", "role": "integration",
      "depends_on": ["code"], "write_scope": ["**"],
      "task": { "risk_level": "L0", "permissions": { "read": true, "shell": true },
                "operations": [{ "op": "run_tests", "command": "npm test" }] } }
  ]
}
```

- **只调度依赖已满足的节点**（`depends_on` 全部 `completed`）；环、未知依赖、自依赖在提交时就被拒绝。
- **优先级（§24）**：`priority = critical_path_score + dependent_task_count + failure_blocking_weight × 5 + manual_priority`，其中 `critical_path_score = depth_to_sink × 10`。
- **并行度上限（§16）**：`desired = min(system_limit, runnable + busy, hard_max)`，因此「只有 2 个可并行节点」时绝不会起 8 个 Worker。
- **推测执行（§25）**：只对显式标记 `speculative: true` 的节点、且状态为 `NORMAL`/`BOOST` 时，把同一节点复制到第二个空闲 Worker；先完成者胜出（`completed`），其余副本收到 `stop_task`（`speculative race won by …`），并计入 `metrics.scheduler.speculative_dispatches`。
- **测试并行化（§22、§23）**：`DispatchScheduler.localAcceptanceFor()` 保证代码 Worker 只跑定向测试/ lint（最多 3 条），只有 `integration` / `test` 角色才跑完整套件与 build；控制器可用 `acceptance_commands` 定义最终验收门。

---

## 6. 文件冲突控制与 Git 隔离（§17、§18、§19）

| 机制 | 说明 |
| --- | --- |
| `expected_file_scope` | 每个节点的 `write_scope`（缺省取 `task.allowed_paths`）。两个作用域重叠 → **不允许同时运行**；未声明作用域的节点在别的节点运行时被视为冲突（保守优先） |
| **File Ownership Registry** | `data/sub-worker/file-ownership.json`。派发时把作用域登记为独占声明；其他 Worker 可读不可写，等待 owner 释放。派发时还会把别的 owner 已占用的路径从该节点的可写范围里剔除，最终由执行器的路径守卫硬性拒绝 |
| **每节点 worktree** | `<repo>-worktrees/hns-<plan>-<node>`，各自 detached 检出、各自分支，互不覆盖；兼容模式下仍是文档化的 `<repo>-worktrees/hns-sub-worker` |
| **Integration / Merge** | 计划全部终态后，收集每个节点相对 base commit 的改动 → 只由**一个**节点改动的文件自动合并；**两个**节点改动的同一路径一律判为冲突并上报（绝不猜赢家）→ 写入 `<repo>-worktrees/hns-<plan>-integration` 供 Controller 验收；**Controller 自己的工作树永不被写入** |

---

## 7. Context Snapshot 与 Worker Task Package（§20、§21）

`data/sub-worker/snapshots/<plan>.json` 由 Supervisor 生成一次：项目结构（有上限的遍历）、依赖清单、关键接口文件、项目配置、当前 git 状态、任务相关文件。
每个节点只拿到自己需要的那一份上下文，避免每个 Worker 重复扫描整个仓库。

Task Package 把一个节点**约束住**：

```json
{
  "task_id": "boss-kb-031-code", "node_id": "code", "plan_id": "boss-kb-031",
  "worker_id": "sub-2", "role": "code",
  "goal": "Implement",
  "relevant_files": ["src/index.ts"],
  "read_only_files": ["package.json"],
  "write_scope": ["src/**"],
  "constraints": [],
  "dependencies": ["inspect"],
  "acceptance_tests": ["npm test -- sqlite"],
  "timeout": 1800,
  "workspace": "D:\\Boss-worktrees\\hns-boss-kb-031-code",
  "requires_network": false, "requires_gpu": false, "speculative": false,
  "context": { "snapshot": ["src", "docs"], "relevant_files": [] }
}
```

`taskFromPackage()` 把它翻译成执行器已经在用的 Task Object：`write_scope → allowed_paths`、`read_only_files → forbidden_paths`、`timeout → 每条命令的超时上限`。因此「Worker 自行扩大任务范围」在执行器层面就是不可能的。

---

## 8. 性能指标与自学习画像（§38、§39、§40）

`data/sub-worker/metrics.json` 记录：任务用时、Worker 活跃/空闲时间、CPU 时间、峰值 RSS、测试结果、重试次数、合并冲突率、扩缩容事件。

- **Effective Throughput** = 成功完成的 work units ÷ wall-clock（`metrics.throughput.per_minute`），而不是 CPU 占用率。
- **Parallel Efficiency**（§39）= 单 Worker 估算 ÷ (多 Worker 用时 × Worker 数)；效率过低说明这类任务加 Worker 无益。
- **自学习画像**（§40，EWMA）：按角色学习 `ramEstimateMb` / `cpuWeight` / `averageDurationMs` / `failureRate`。学习值是**修正**而非替代：少于 3 个样本时用种子值，且学习值被限制在种子值的 `RAM 0.5×~4×`、`CPU 0.5×~3×` 区间内 —— 因为 Worker 自报的是**它自己进程**的 RSS（约 50 MB），而任务真正的内存消耗在它的子进程里（一次 `npm test` 可能是几百 MB 到 GB 级）。没有这道夹紧，内存守卫就会被"学"成几乎不设限。

---

## 9. 配置（§27、§44、§45）

生效配置由四层合成，后者逐键覆盖前者：

```text
resource-config.cjs#defaultResourceConfig()        ← 代码内默认
config/app.json#subWorker.resources                ← 出厂声明
config/hns-resource.yaml                           ← 文档化的用户文件（本仓库已随附）
data/sub-worker/config.json                        ← 面板保存/持久化，优先级最高
```

`auto` 表示"交给 Profiler 与 Monitor 决定"，数字表示显式覆盖；无论用户怎么写，安全钳制都会生效（例如 RAM 备用区不得低于 2 GB、心跳不得小于 1 s、`soft_max ≤ hard_max ≤ 64`）。
`app/sub-worker/yaml.cjs` 是一个零依赖的 YAML 子集读取器：支持嵌套映射、标量、引号字符串、布尔/数字/`auto`/`null`、行内数组与 `#` 注释；对多文档、锚点、块标量、标签（含 `!!str`）、制表符缩进**明确报错**而不是猜测。同一文件写成 JSON 也可。

关联开关：

```yaml
workers:    { min: 1, soft_max: auto, hard_max: auto }
scaling:    { enabled: true, scale_up_step: 1, scale_down_step: 1,
              scale_up_delay_seconds: 30, scale_down_delay_seconds: 60,
              idle_down_grace_seconds: 10 }
safety:     { enable_safe_mode: true, keep_supervisor_alive: true,
              emergency_scale_down_immediate: true }
```

---

## 10. 日志与持久化（§37）

```text
data/sub-worker/
├── hardware-profile.json     安装期硬件上限（§3.1）
├── config.json               生效配置（面板写入）
├── state.json                生命周期状态 + 活动计划（可恢复）
├── plan 状态：plans/<plan>.json
├── snapshots/<plan>.json     仓库快照（§20）
├── file-ownership.json       文件所有权登记表（§19）
├── metrics.json              性能指标 + 学习画像（§38/§40）
├── queue.json / history.json / tasks/<task>.json
└── workspace-lock.json       共享工作区单写者锁

logs/sub-worker/
├── supervisor.log   scheduler.log   resources.log
├── workers/<worker_id>.log
└── <task_id>.log                    逐任务审计日志（已脱敏）
```

`runtime/sub-worker-process.json` 记录进程所有权（含全部 Worker PID），供下一次启动回收孤儿。

---

## 11. 界面与操作

Mega 面板「Sub-worker」新增（工程书 §11 的可视化要求）：

| 区域 | 内容 |
| --- | --- |
| 自适应开关 | 「自适应多进程」开关 + 应用；关闭即回到 1 Worker 兼容模式 |
| 调度一次 | 手动触发一个调度循环（采样 → 扩缩容 → 派发），返回本轮决策 |
| 性能状态 | `NORMAL / BOOST / THROTTLED / CRITICAL / SAFE_MODE` 徽章（悬停显示原因） |
| 资源 | CPU 利用率与预算、可用/总内存、存储类型与实测延迟、硬件档位与上限、退化传感器 |
| 限制 | `cpu / ram / io / thermal / config` 各维度上限、`effective`、**瓶颈维度** |
| Worker Pool | 每个 Worker 的 id / 角色 / 状态 / 任务 / PID / 重启次数 |
| Task DAG | 每个计划的节点、依赖状态、负责 Worker、优先级、关键路径、集成结果与冲突数 |
| 性能指标 | 任务数、有效吞吐、平均用时、重试次数、合并冲突率、峰值 Worker RAM、角色画像（EWMA） |

托盘保持不变（Start / Stop / Restart / Pause / Resume / Cancel / Open Live View / Take Over），Live View 继续显示单任务全过程。

---

## 12. 验收对照（§46）

| 验收项 | 如何满足 | 自动化证据 |
| --- | --- | --- |
| **安装验收** 正确识别 CPU/RAM/存储/GPU 并给出合理上限 | `profiler.cjs` 清单 + 延迟回退 + 档位表；`data/sub-worker/hardware-profile.json` | `multi-profiler.test.js`（§26 校准表逐行）、`multi-supervisor.test.js`「安装验收」 |
| **运行验收** 人为制造高 CPU/RAM/高温/磁盘压力 → 自动降并发 | 注入式资源样本驱动 `ResourceScheduler` | `multi-resources.test.js`（§8/§10/§28/§29）、`multi-supervisor.test.js`「运行验收 + 低资源验收」 |
| **恢复验收** 压力解除后逐步恢复，不瞬间拉满 | `scaleUpStep = 1` + 健康持续时长门槛 | `multi-resources.test.js` §11/§12、`multi-supervisor.test.js` 恢复段 |
| **故障验收** 随机 kill Worker → Supervisor 不退出、任务可重试、状态不丢失 | `handleExit` → `CRASHED` + 重试 + 计划持久化 | `multi-supervisor.test.js`「故障验收」「§34 可恢复」 |
| **并行验收** N Worker 明显降低 wall-clock | DAG 并行 + 池扩容 | `multi-supervisor.test.js`「并行验收」（2×5 s 任务 < 8.5 s） |
| **冲突验收** 两个 Worker 改同一文件必须被阻止 | 作用域冲突过滤 + 所有权登记 + 合并冲突上报 | `multi-supervisor.test.js`「冲突验收」×2、`multi-worker` 单元断言 |
| **低资源设备验收** 8 GB/低核环境退化到 Main + 1 Worker 并保持运行 | `ram_limit`/`io_limit`/档位共同限制；`SAFE_MODE` 仅在所有 Worker 都放不下时触发 | `multi-resources.test.js` §10/§35、`multi-supervisor.test.js` 压力段 |

外加：`scripts/sub-worker-acceptance.cjs` 会在**真实 Electron 外壳**上跑默认模式与启用模式的端到端验收（见 `docs/sub-worker.md` §14.1）。

---

## 13. 与上一阶段的关系（兼容性）

- `adaptiveWorkers: false`（默认）= 上一阶段的行为：池上限 1、同一调度代码、同一 IPC 面。
- 上一阶段的所有 API 仍然可用且语义不变：`start / stop / restart / pause / resume / cancelTask / sendNote / takeOver / clearHandoff / resumeLastTask / releaseWorktree / readTaskLog / liveViewFor / assignTask`。`assignTask` 现在内部构造一个**单节点计划**，因此也走同一套 DAG 调度路径（§36）。
- `describe()` 在原有字段之外新增 `pool / resources / resource_state / limits / hardware / plans / dag / integration / file_ownership / metrics / scheduler / health / liveViews / decision / resource_config`，旧字段含义不变。
- 兼容模式下的目录布局不变（`data/sub-worker/**`、`logs/sub-worker*`），新增文件都是"加法"。

---

## 14. 尚未实现（明确边界）

以下仍属于工程书 §41 的后续阶段或明确不在本阶段范围：

- **物理拆分的专用 Worker 进程**（Phase 6）：目前所有角色共用 `runtime.cjs`，仅以 `role`/`resource_profile` 区分（§14 允许这样做）。
- **完整 DAG 重写 / 自动计划生成**：计划由 Controller 提交；Supervisor 不会自行发明节点，也不会自行决定下一个任务。
- **远程 / 分布式 Worker、Worker 间通信、设备联邦**（§31 Phase 3）：协议里没有这样的通道，池只管理本机进程。
- **温度/功耗传感器**：平台不提供时按 §9 降级（不做猜测）；`nvidia-smi` 缺失时不做 VRAM 判定。
- **网络预算**（§30）：默认不探测网络；在线并发上限来自 `externalService.apiConcurrencyLimit`。
- **人机活动的精确检测**（§29）：支持注入/上报的用户活动信号并据此降低 CPU 预算；默认不主动探测前台空闲时间。
