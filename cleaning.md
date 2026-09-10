# DS-Hns MEGA Lifecycle & UX Cleanup

## 0. 工程定位

本工程为 DS-Hns 当前 MEGA Harness 的生命周期、用户交互与桌面入口收尾工程。

目标不是新增一套平行架构，而是在现有 MEGA 架构上完成以下五项行为修正：

1. 挂起任务恢复并完成后自动退出活动队列。
2. 删除 Recent Session Cost。
3. 主 Harness 任意任务进入终态后发送系统通知。
4. 余额模块打开时自动刷新，同时保留手动刷新。
5. 完善快速启动器，并统一使用仓库根目录 `icon.jpg`。

工程采用“纯验收托管”模式：

施工 Agent 负责自行分析现有实现、修改、测试、回归、发现问题、修复问题和再次验收。

不得因为单个子模块失败而让整体 Harness 崩溃。

不得以“部分实现”“接口已经预留”“UI 已显示但逻辑尚未接通”作为完成。

---

# 1. Git 工作策略

## Base branch

`main`

Base commit：

`8e24b7d1e1cdafae39e3c228d9339abf80ae930f`

开始施工前必须：

```text
git fetch origin
git checkout main
git pull --ff-only origin main
```

确认 HEAD 不落后于远端后再创建工程分支。

## Working branch

创建：

```text
mega-hns-lifecycle-cleanup
```

即：

```text
git checkout -b mega-hns-lifecycle-cleanup
```

若施工开始时远端 `main` 已出现更新，则必须以施工时最新 `origin/main` 为实际基线，而不是强制回退到上述历史 SHA。

## Merge target

验收全部通过后：

```text
mega-hns-lifecycle-cleanup
        ↓
       main
```

禁止直接在 `main` 上边改边试。

不得继续向：

```text
alien-rebuild
owner-result-autonomy
```

追加本工程功能。

这些分支仅作为历史工程参考。

---

# 2. 总体设计原则

本轮必须进一步明确以下状态边界：

```text
Active execution state
        ≠
Historical record
        ≠
UI presentation
```

任务生命周期统一抽象为：

```text
QUEUED
   ↓
RUNNING
   ↓
SUSPENDED
   ↓
RUNNING
   ↓
TERMINAL
```

其中：

```text
TERMINAL =
COMPLETED
FAILED_FINAL
CANCELLED
```

进入 TERMINAL 后，标准动作顺序原则上为：

```text
finalize result
      ↓
persist history
      ↓
remove from active queue
      ↓
emit terminal event
      ↓
update UI
      ↓
dispatch notification
```

通知失败、历史写入附加信息失败、UI 刷新失败，不得反向改变已经确定的任务终态。

所有辅助功能执行遵守：

```text
failure isolated
idempotent
recoverable
non-blocking where appropriate
```

---

# 3. MEGA-01 — Suspended Task Terminal Queue Cleanup

## 当前问题

挂起任务恢复执行后，即使已经实际完成，仍可能继续残留于活动队列或挂起队列展示中。

这会造成：

```text
ghost task
queue slot pollution
incorrect active count
restart resurrection
UI/state divergence
```

## 目标行为

任何任务无论是否经历：

```text
queued
running
suspended
resume
retry
```

只要最终进入：

```text
COMPLETED
FAILED_FINAL
CANCELLED
```

都必须退出所有活动执行队列。

## 必须满足

活动队列只能表达：

```text
仍可能继续被执行的任务
```

历史任务进入历史层，不得继续占据：

```text
active queue
suspended queue
dispatchable collection
worker slot
resume candidate list
```

任务历史不得因此被删除。

## 重启恢复

Harness 重启后：

如果持久化任务已经处于终态，则不得重新加载进 Active Queue。

恢复逻辑必须先检查 final state，而不是单纯根据“曾经 suspended”恢复任务。

## 幂等

terminal cleanup 必须允许重复调用。

例如：

```text
finish callback
scheduler state sync
UI refresh
startup recovery
```

同时碰到同一个终态任务时，不得发生异常。

推荐语义：

```text
removeIfPresent(taskId)
```

而不是：

```text
removeOrThrow(taskId)
```

## 重点检查区域

优先检查现有：

```text
app/extensions/mega/scheduler/
app/extensions/mega/tracker/
app/extensions/mega/autonomy/
```

以及 scheduler 与 renderer/UI 之间的状态同步。

## 验收

至少覆盖：

```text
queued → running → completed
queued → running → suspended → running → completed
queued → suspended → cancelled
running → failed-final
suspended → running → failed-final
```

每一种终态均要求：

```text
active queue = 无该 task
history = 有该 task
restart = 不复活
UI = 不显示为仍待执行
```

---

# 4. MEGA-02 — Remove Recent Session Cost

## 目标

彻底移除用户界面上的：

```text
Recent Session Cost
```

该指标不再作为 HNS 主 UI 信息展示。

## 删除范围

删除：

```text
UI card / field
Recent Session Cost renderer binding
专门为 Recent Session Cost 服务的 session 聚合
无意义的刷新监听
只用于该 UI 字段的 cache/state
```

## 不允许误删

不得因为删除该 UI 指标而破坏：

```text
底层 token accounting
provider pricing
cost calculator
billing telemetry
future accounting interface
其他仍被使用的成本统计
```

现有 MEGA billing 层原则上继续保留。

目标是：

```text
remove product/UI feature
≠
destroy billing infrastructure
```

## 旧数据兼容

如果旧 session、settings 或 cache 中仍包含相关字段：

```text
recentSessionCost
sessionCost
recent_cost
```

或实际代码中的等价字段：

必须做到：

```text
ignore safely
no migration crash
no undefined UI crash
```

是否真正删除旧持久化字段由实际数据结构决定。

如果无必要，不进行破坏性数据迁移。

## 验收

启动旧数据环境：

```text
Harness 正常启动
UI 不再显示 Recent Session Cost
其他 billing 功能正常
不存在 console error
```

---

# 5. MEGA-03 — Universal Harness Terminal Notification

## 目标

任何由主 Harness 管理的任务，在进入终态时发出桌面/系统通知。

必须是统一生命周期能力，而不是给每一种 task type 手工加通知。

## Terminal event

建议统一事件：

```text
TASK_TERMINATED
```

payload 至少包含：

```text
taskId
taskName / displayName
finalStatus
completedAt
shortResult / errorSummary
```

## 通知范围

支持：

```text
COMPLETED
FAILED_FINAL
CANCELLED
```

默认：

```text
COMPLETED → notify
FAILED_FINAL → notify
```

Cancelled 可保持通知，也可以通过现有 settings 体系设置开关。

如果当前 settings 架构适合，应留下配置入口，但不得为了配置功能重构整个 settings。

## 去重

一个任务的一个最终生命周期只能通知一次。

必须防止：

```text
scheduler terminal callback
tracker sync
renderer refresh
restart recovery
duplicate event
```

造成多次提醒。

建议使用：

```text
taskId + terminal epoch/state
```

或等价的幂等键。

## 通知隔离

通知属于 side effect。

必须：

```text
task finished
    ↓
notification attempted
```

而不是：

```text
notification succeeded
    ↓
task considered finished
```

因此：

```text
notification failure != task failure
```

## 现有模块复用

优先使用或扩展：

```text
app/extensions/mega/notifications/
```

现有 sound service 如果只负责声音，可以继续负责声音，但桌面通知应作为 notifications 层的另一能力。

不得把 notification 逻辑散落到每个 scheduler/task handler。

## 内容

示例：

```text
DS-Hns
Task completed: <task name>

Status: Completed
Finished: 14:32
```

失败任务：

```text
DS-Hns
Task failed: <task name>

<short error summary>
```

通知正文应简短。

详细日志仍然回到 Harness 查看。

## 验收

运行多个不同来源的 Harness 任务：

```text
normal task
suspended-resumed task
scheduler task
autonomy-supervised task
failed task
cancelled task
```

验证：

```text
terminal → notification
one terminal → max one notification
notification failure → harness unaffected
```

---

# 6. MEGA-04 — Balance Auto Refresh on Module Open

## 目标

余额模块的正常体验调整为：

```text
Open Balance
      ↓
automatic refresh
      ↓
show latest result
```

同时保留：

```text
Manual Refresh
```

## 单一刷新服务

自动刷新和手动刷新必须共用同一个 refresh implementation。

禁止：

```text
autoRefreshBalances()
manualRefreshBalances()
```

内部维护两套不同实现。

推荐：

```text
refreshBalances(trigger)
```

trigger 可记录：

```text
module-open
manual
retry
```

但业务行为保持一致。

## 自动刷新触发条件

每次用户真正打开余额模块时触发一次。

不得因为以下行为产生请求风暴：

```text
DOM rerender
window resize
React/Electron view repaint
focus flicker
state sync
component internal refresh
```

如果用户关闭余额模块后再次重新打开：

可以再次自动刷新。

## 并发保护

如果余额正在刷新：

手动按钮不能再无条件启动第二套并发请求。

可以：

```text
disable Refresh temporarily
```

或者：

```text
coalesce duplicate request
```

## Provider 隔离

多 Provider 情况：

```text
Provider A success
Provider B timeout
Provider C unavailable
```

最终应该显示：

```text
A: latest balance
B: failed / timeout
C: unavailable
```

而不是整个 Balance 页面失败。

## 保留旧余额

请求失败时：

不得立即把上一次成功余额清成：

```text
0
null
--
```

应该保留 last successful value，并注明状态。

## Last Updated

保留轻量字段：

```text
Last updated: HH:MM:SS
```

只有成功刷新到有效数据时更新。

如适合现有实现，也可以记录 provider-level last updated。

## 验收

验证：

```text
打开模块 → 自动刷新
关闭再打开 → 再刷新
手动 Refresh → 正常刷新
快速点击 Refresh → 无请求风暴
一个 provider 失败 → 其他 provider 正常
全部失败 → Harness 不崩
```

---

# 7. MEGA-05 — Quick Launcher & icon.jpg

## Source of Truth

唯一正式图标源：

```text
/repository-root/icon.jpg
```

即：

```text
./icon.jpg
```

不得创建另一份需要人工同步维护的 source icon。

## 注意已有实现

开始施工前必须首先检查现有 launcher/icon 逻辑。

如果已有：

```text
icon.jpg → launcher icon
```

能力，则只验证、补全和修复。

禁止因为工程书要求而重复造第二套 launcher。

## 快速启动目标

用户完成一次安装后，应该拥有一个明显、可靠的快速启动入口。

Windows 当前目标至少覆盖：

```text
desktop shortcut
```

如现有安装器已经具备 Start Menu、desktop shortcut 或其他入口，则复用现有安装逻辑。

快速启动入口最终都指向唯一 Harness 主启动入口。

不得存在：

```text
launcher A → boot path A
launcher B → boot path B
manual cmd → boot path C
```

三套逐渐漂移的启动逻辑。

## JPG 转 ICO

如果 Windows shortcut / executable metadata 需要 `.ico`：

允许构建或安装阶段生成：

```text
icon.jpg
   ↓
generated icon.ico
```

其中：

```text
icon.jpg = source asset
icon.ico = generated artifact/cache
```

生成的 `.ico` 不得反过来成为人工维护主资源。

## 图标失败降级

如果转换、缓存或系统图标注册异常：

```text
launcher still works
Harness still starts
```

只允许：

```text
icon fallback
```

不得：

```text
application launch failure
```

## 与安装器整合

重点检查：

```text
Install-DS-Harness.cmd
Start-DeepSeek-Harness.cmd
app/desktop-main.cjs
app/package.json
```

如果 Electron packaging 已存在 icon 相关逻辑，需要统一配置，避免 installer 和 Electron 分别维护不同路径。

## 验收

全新安装：

```text
运行 installer
→ 出现快速启动入口
→ 图标来自 icon.jpg
→ 点击成功启动主 Harness
```

更新 `icon.jpg` 后重新安装/刷新 launcher：

```text
图标能够更新
```

模拟图标失败：

```text
Harness 依然能启动
```

---

# 8. UI 回归要求

本工程虽然只包含几个明显 UI 改动，但必须整体检查 MEGA UI。

重点包括：

```text
main view
dock
widget
Balance module
queue/task display
billing display
settings
```

Recent Session Cost 删除后，不得留下：

```text
empty card
blank divider
broken grid
misaligned layout
undefined/null string
```

Balance 新增 opening refresh 后不得导致页面闪烁循环。

Notification 不得阻塞 renderer。

---

# 9. Failure Isolation

这是本工程硬性要求。

以下模块任何一个独立失败：

```text
queue cleanup
history write
billing UI
balance provider
notification service
launcher icon
launcher shortcut generation
```

都不能导致整个主 Harness crash。

特别是：

```text
notification error
icon generation error
balance endpoint timeout
```

必须被视为外围服务失败。

Harness 核心执行仍继续。

---

# 10. Regression Protection

不得破坏现有：

```text
Owner-Result autonomy
progress observer
stall detector
episode supervisor
continuation controller
question interceptor
result validator
decision ledger
scheduler
DeepSeek session integration
billing engine
task history
dock/widget
```

尤其要验证：

```text
suspended → resume
```

的行为修复没有误伤正常 continuation/autonomy 控制。

---

# 11. Testing Strategy

必须同时包含：

## Unit-level

针对：

```text
terminal queue cleanup
terminal event dedup
balance refresh lock/coalescing
legacy session data compatibility
```

编写或更新测试。

## Integration-level

完整跑：

```text
Harness start
task create
task run
task suspend
task resume
task complete
history write
queue removal
notification
UI refresh
```

## Desktop smoke

验证：

```text
installer
quick launcher
desktop start
Balance auto refresh
manual refresh
task notification
```

## Restart recovery

构造：

```text
terminal task
suspended task
running/incomplete task
```

退出 Harness 后重新启动。

确认：

```text
terminal task → history only
suspended/incomplete → 按现有恢复规则处理
```

---

# 12. 验收门槛

工程完成必须同时满足：

```text
[PASS] completed suspended task disappears from active queue
[PASS] terminal task does not resurrect after restart
[PASS] historical task remains queryable
[PASS] Recent Session Cost fully removed from UI
[PASS] billing infrastructure remains operational
[PASS] completed task emits one notification
[PASS] failed task emits one notification
[PASS] no duplicate terminal notifications
[PASS] notification failure does not affect task completion
[PASS] Balance refreshes automatically when opened
[PASS] manual Balance refresh remains available
[PASS] duplicate balance refresh requests are controlled
[PASS] provider failures are isolated
[PASS] last successful balance is retained on refresh failure
[PASS] quick launcher starts main Harness
[PASS] launcher uses root icon.jpg
[PASS] icon failure does not prevent startup
[PASS] existing autonomy workflow remains functional
[PASS] tests pass
[PASS] no new uncaught exception
[PASS] no obvious renderer console error
```

任何一项硬性验收失败：

```text
工程状态 = NOT DONE
```

不得以：

```text
mostly complete
works on my machine
future improvement
known limitation
```

结束任务。

---

# 13. 执行顺序

推荐施工顺序：

```text
A. baseline + regression snapshot
        ↓
B. terminal lifecycle cleanup
        ↓
C. terminal event / notification
        ↓
D. Recent Session Cost removal
        ↓
E. Balance refresh lifecycle
        ↓
F. Quick Launcher audit/completion
        ↓
G. restart + desktop integration tests
        ↓
H. full regression
        ↓
I. self-review
        ↓
J. fix all discovered regressions
        ↓
K. final acceptance
```

其中 A/B/C 应优先，因为 Queue Cleanup 和 Notification 应共享统一 terminal lifecycle，而不是分别监听 UI。

---

# 14. 施工 Agent 自主权

施工期间允许 Agent：

```text
重构局部实现
新增小型 service
新增 tests
调整 IPC
调整 renderer binding
调整 installer
调整 generated asset pipeline
删除死代码
```

前提是：

```text
不扩大产品功能边界
不重写无关模块
不改变核心 Harness 产品方向
不删除仍被其他模块依赖的 telemetry
```

无需因为普通实现选择向 Owner 逐项询问。

遇到多个合理方案时：

优先选择：

```text
最小依赖
低耦合
幂等
可测试
failure-isolated
与现有架构一致
```

的实现。

---

# 15. 最终交付

完成后必须提交：

```text
1. implementation
2. updated tests
3. regression results
4. acceptance matrix
5. changed-files summary
6. known non-blocking limitations, if any
```

最终报告不得只说：

```text
implemented successfully
```

必须能对应本工程书每一项验收门槛。

最终通过后：

```text
mega-hns-lifecycle-cleanup
        ↓
       main
```

结束本轮 MEGA 收尾工程。