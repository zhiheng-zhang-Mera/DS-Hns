# DS-Hns Mega UI / Tray 收敛修订规格

## 1. Windows 托盘最终行为

托盘图标继续保留。

### 双击

保留现有行为：

```text
Double Click Tray
        ↓
Focus / Restore DS-Harness Main Window
```

如果窗口：

- 最小化 → restore
- 被其他窗口遮挡 → focus
- 已显示 → bring to front

当前版本本来就通过 tray double-click 调用 `focusMain()`，这一行为保留。

---

### 右键菜单

最终只保留：

```text
Exit DS-Harness
Force Exit DS-Harness
```

删除：

```text
Official Harness
Expand Mega Dock
Collapse Mega Dock
Show Mega Dock
Hide Mega Dock
Full Mega Tools
```

#### Exit DS-Harness

正常退出：

```text
stop scheduler
→ stop extensions
→ flush/persist state
→ stop managed Harness
→ destroy windows/tray
→ app.quit()
```

应尽量完成正常清理和状态保存。

#### Force Exit DS-Harness

强制退出：

```text
mark shuttingDown
→ best-effort state flush
→ kill managed child process tree
→ destroy extension/runtime resources
→ destroy windows/tray
→ app.exit()
```

Windows 下继续利用现有 `taskkill /T /F` 能力强杀受管 Harness 子进程。当前主程序已经有这一底层能力。

Force Exit 的任何附加清理失败均不得阻止最终退出。

---

# 2. Full Mega Tools 独立页面彻底取消

删除 Full Mega Tools 作为单独窗口/单独页面的产品概念。

当前：

```text
Official Harness
Mega Dock
Full Mega Tools BrowserWindow
```

改为：

```text
Official Harness
      +
Mega Dock
```

禁止再创建单独的 Mega 管理 BrowserWindow。

删除：

```text
toolsWindow
openTools()
mega:open-tools
Full Mega Tools tray item
preload.openTools()
```

当前 `openTools()` 会额外创建一个独立 Electron BrowserWindow，这一整条生命周期删除。 

当前 preload 中的 `openTools()` IPC 桥也同步删除。

---

# 3. Full Mega Tools 功能不得删除

这里只删除：

```text
独立页面 / 独立窗口
```

不删除其实际能力。

当前 Full Mega Tools 中已有的能力全部迁移至 Mega Dock 设置入口，包括：

```text
模型设置
全局 Permission Mode
Telemetry
API Key
提示音总开关
提示音音量
提示音文件导入
系统通知开关
Cancelled / Interrupted 通知设置
Workspace 选择
Scheduler 高级设置
其他仍然有效的 Mega 配置
```

当前这些功能确实集中在 Full Mega Tools 页面，因此删除页面时必须迁移，而不是一起删除。

---

# 4. Mega Dock 新增 Settings 小弹窗

Mega Dock Header 新增：

```text
⚙ Settings
```

建议放在折叠按钮旁边。

点击后在 **同一个 Mega Dock 内部**弹出设置层：

```text
Mega Dock
┌──────────────────────────┐
│ Queue / Balance / ...  ⚙ │
│                          │
│       normal content     │
│                          │
│   ┌──────────────────┐   │
│   │ Mega Settings    │   │
│   │ ...              │   │
│   └──────────────────┘   │
└──────────────────────────┘
```

不得：

```text
new BrowserWindow
new native window
navigate to another page
replace Official Harness
```

---

# 5. Settings UI 结构

建议使用单个小型 overlay / drawer，而不是再做一个复杂控制台。

内容分组：

```text
General
- Default Model
- Permission Mode
- Telemetry
- API Key

Notifications
- Sound Enabled
- Volume
- Ringtone
- Import Sound
- Desktop Notification
- Cancelled / Interrupted Notification

Workspace
- Headless Workspace
- Browse / Change

Scheduler
- Minimum concurrency
- Maximum concurrency
- CPU reserve
- RAM reserve
- Memory per worker
- Default allow peak
- Interrupt at peak
```

可以采用：

```text
折叠分组
```

避免一个很长的设置弹窗。

高级设置默认折叠即可。

---

# 6. 设置逻辑继续复用现有 Backend

不得因为 UI 搬迁复制 service。

Dock Settings 继续使用现有：

```text
mega:update-settings
mega:update-scheduler
mega:pick-workspace
mega:pick-sound
mega:snapshot
```

因此结构应为：

```text
Mega Dock Settings UI
        ↓
existing preload IPC
        ↓
existing settings/scheduler/sound/workspace services
```

而不是创建：

```text
dock-settings-service-v2
```

等平行实现。

---

# 7. Recent Session 仍然彻底删除

虽然 Full Mega Tools 页面现在整体删除，但 Mega Dock 中的：

```text
最近 Session
```

仍需单独删除。

当前 Dock 确实仍有完整 Recent Session 模块。

同时删除：

```text
snapshot.sessions
session list rendering
Recent Session UI
只为该 UI 服务的 session projection
```

官方 Harness 自己的 Session 历史：

```text
保留
```

Mega 不再重复展示。

---

# 8. 通知 / 响铃修复保持原计划

继续处理：

```text
普通官方 Harness Session
Scheduler Official Session
Headless Task
```

三种路径。

最终：

```text
任意实际用户任务达到终态
        ↓
Unified terminal observer
        ↓
┌───────────────┬──────────────┐
│ desktop notify│ ringtone     │
└───────────────┴──────────────┘
```

不得再仅依赖 Mega Scheduler 自己产生 `TASK_TERMINATED`。

---

# 9. 最终 UI 形态

最终产品应收敛为：

```text
Windows
│
├── DS-Harness Main Window
│   ├── Official Harness
│   └── Mega Dock
│       ├── Queue
│       ├── Hardware
│       ├── Balance
│       └── ⚙ Settings popup
│
└── Tray
    ├── double click → focus main window
    └── right click
        ├── Exit DS-Harness
        └── Force Exit DS-Harness
```

不存在：

```text
Full Mega Tools
Mega secondary control window
Recent Session duplicate panel
Tray navigation/control menu
```

---

# 10. 本轮分支

继续使用：

```text
base:
main@e783ba0

working branch:
fix/mega-terminal-alert-cleanup
```

本轮一次完成：

```text
1. Universal audible terminal notification
2. Remove Mega Recent Session
3. Remove Full Mega Tools window/page
4. Migrate Full Mega features into Dock Settings popup
5. Simplify Windows tray
6. Add Normal Exit + Force Exit
7. Keep tray double-click focus
8. Regression / desktop acceptance
```

## 最终硬性验收

```text
[PASS] tray double-click restores/focuses DS-Harness
[PASS] tray right-click only shows normal Exit + Force Exit
[PASS] normal Exit performs graceful shutdown
[PASS] Force Exit kills managed runtime/process tree
[PASS] Full Mega Tools no longer exists
[PASS] no mega:open-tools dead IPC remains
[PASS] all useful former Full Mega settings remain accessible
[PASS] settings open inside Mega Dock, not a new window/page
[PASS] Mega Recent Session completely removed
[PASS] Official Harness history remains intact
[PASS] ordinary Harness task completion produces audible alert
[PASS] Scheduler task completion produces audible alert
[PASS] Headless task completion produces audible alert
[PASS] no duplicate alerts
[PASS] no module failure crashes the Harness
```