# TASKS - DeepSeek Harness 部署执行清单(v0.2.0 Electron + 调度队列)

更新时间:2026-09-07

## 工作书 §53 执行顺序(原始)

| # | 步骤 | 状态 |
|---|---|---|
| 01-06 | 机器/D 盘检查、目录、路径重定向、需求调研 | DONE |
| 07 | 安装官方 dsh 到 D:\DeepSeek-Harness | DONE |
| 08 | API 配置(apiKeyEnv + config\.env) | DONE(待真实 key) |
| 09-10 | Basic / Agent 任务测试 | PENDING(需 key;错误路径已验证) |
| 11 | 无 C 盘污染验证 | DONE |
| 12-18 | Balance/Pricing/Peak/Timezone/TaskTracker/Cost/Sound | DONE |
| 19-23 | 轻量 UI + 对比 + 时间轴 + Recent + Settings | DONE |
| 24 | 自动测试 | DONE - 20/20 |
| 25 | 磁盘位置测试 | DONE - verify PASS |
| 26 | 集成测试 | DONE(dsh boot、队列 API、取消、并发);真实模型待 key |
| 27 | 安全审查 | DONE |
| 28-31 | 存储审计/文档/清理/最终验证 | DONE |

## v0.2.0 新增(本轮用户要求)

| 功能 | 状态 |
|---|---|
| Electron 桌面壳替代浏览器启动 | DONE - run.ps1 启动 electron.exe,不再打开浏览器 |
| Electron DOM/控制台自检 | DONE - 无 console error,关键 DOM 齐备 |
| 定时排队(Scheduled Queue) | DONE - 队列持久化、取消/清空/再跑 |
| 峰值时段挂起、谷价自动开始 | DONE - gate 单测 + API 验证 |
| 高峰暂停运行中谷价任务并自动重排 | DONE - interruptRunningAtPeak 选项 |
| 查询本机配置(CPU/内存/占用) | DONE - /api/system + 面板 |
| 动态调整多任务并发 | DONE - computeMaxConcurrent + min/max 持久化 |

## v0.2.1 快捷启动与自动启动(用户要求)

| 功能 | 状态 |
|---|---|
| 桌面快捷启动 DeepSeek Harness(Electron) | DONE - `Desktop\DeepSeek Harness.lnk` |
| 桌面停止快捷方式 | DONE - `Desktop\Stop DeepSeek Harness.lnk` |
| 开始菜单快捷方式 | DONE |
| Windows 登录自动启动 | DONE - Startup 文件夹 Autostart lnk → `scripts\autostart-electron.ps1` |
| 移除/管理脚本 | DONE - `scripts\shortcuts.ps1 -Remove` |
| C 盘例外记录 | DONE - C_DRIVE_EXCEPTIONS.md(仅快捷方式指针,无项目数据) |

## v0.3.x 桌面交互重做(用户要求)

| 功能 | 状态 |
|---|---|
| 设置可编辑(Key/模型/权限/遥测/并发/声音) | DONE - /api/settings GET+POST,持久化多文件 |
| 主窗口切换为 Codex/ChatGPT 风格聊天界面 | DONE - chat.html/css/js |
| 第二窗口合并为同窗口可切换视图 | DONE - 单 Electron 窗口:对话/监控/设置三视图链接切换 |
| 主页面(对话)不显示设置界面 | DONE - 设置独立为 /settings.html 视图 |
| 聊天内容与真实任务状态/回答联动 | DONE - session JSONL 提取 assistantText |
| DOM/console 自检(chat/settings/monitor 三视图) | DONE - 均 0 console issues,关键 DOM 齐全 |

## 遗留阻塞

唯一阻塞:尚未提供 DeepSeek API Key。填入 `config\.env` 后:

```powershell
powershell -ExecutionPolicy Bypass -File D:\DeepSeek-Harness\scripts\run.ps1
```

然后在 Electron 的 Scheduled Queue 添加任务即可跑真实模型、验证余额/费用与铃声。
