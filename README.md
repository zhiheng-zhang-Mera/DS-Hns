# DS-Harness — DeepSeek Harness 桌面客户端(合并版)

> 由私有仓库 **Harness-Alien**(桌面壳基线)与 **Harness-Mega**(队列/计费/监控/铃声等功能参考)合并而来。
> **主界面 UI 与本地部署版(D:\DeepSeek-Harness 运行的官方 dsh Web)完全一致**——由 DS-Harness
> **自己的引擎**提供同一版本前端(`@deepseek-ai/dsh-web-frontend` v0.1.2-rc.1,资产逐字节一致),
> **绝不拉起/加载本地部署版的页面或窗口**。
> Mega 功能(队列/峰谷/余额/铃声/监控/设置)作为**附加窗口/托盘入口**保留,不改变官方主界面。
> 铃声(ringtone)已做成 **用户可自定义 + 可选开关**。

## 特性

- **主界面 = 官方 dsh Web UI(与本地部署版一致)**:单进程、单锁(重复启动聚焦既有窗口),日志令牌脱敏、端口自动错开、关闭即停引擎。
- **附加功能窗口(托盘)**:
  - 系统托盘图标(黑色鲸鱼+electron 粒子):主界面(聚焦)、**监控(队列/峰谷/成本/余额)**、**设置(铃声/工作区/密钥/并发)**、**对话管理页(自研功能:附件/权限/历史管理/常驻用量条)**、退出;
  - `Ctrl+1` 聚焦主界面,`Ctrl+2`/`Ctrl+3` 打开 监控/设置 窗口(不会替换官方主界面)。
- 附加对话管理页保留:搜索/视图筛选/添加工作区、左侧历史右键(重命名/文件夹/删除/批量)、Composer 附件上传与权限(官方语义三档+风险确认)。
- **端口自动错开**:dsh Web(默认 3080)与调度中心(默认 3300)被占用时自动错开,实际端口写入 `data\state\ports.json`。
- **铃声(合并版重构)**:`config\sound.json` 唯一真源(总开关/音量/每事件开关与音频),9 预设+本地上传 wav/mp3,试听与预览,三事件触发;失败永不阻塞 dsh。

## 目录结构

```text
DS-Harness/
├── app/                          # 单一 npm 包:桌面壳 + 调度中心源码
│   ├── desktop-main.cjs          #   Electron 主进程(双服务 + 视图切换 + 音频宿主)
│   ├── package.json              #   @deepseek-ai/dsh 0.1.2-rc.1 + electron 43.4.0(lockfile 锁定)
│   ├── electron-assets/preload.js#   contextBridge(桌面信息 + 音频播放桥)
│   └── monitor/                  #   Mega 调度中心模块(全部保留内部相对引用)
│       ├── ui/{server.js,public} #     3300 HTTP 服务 + 三视图 + 铃声客户端
│       ├── scheduler/            #     队列/峰谷门控/headless 运行器/系统探测
│       ├── billing/              #     定价快照/峰谷引擎/成本计算
│       ├── tracker/              #     会话 JSONL 解析/最近任务
│       ├── settings/  notifications/  deepseek/  utils/
├── assets/sounds/                # 内置预设铃声 wav(9 个,入库)
├── config/                       # app.json / sound.json / pricing.json / .env.example
├── scripts/                      # env / install / run / stop / verify / run-task / generate-sounds / shortcuts …
├── tests/unit/                   # node:test 单元测试
├── data/… runtime/ cache/ logs/ workspace/   # 运行期生成,全部 gitignored
├── Start-DeepSeek-Harness.cmd    # 双击启动器
└── LICENSE                       # MIT
```

## 快速开始(Windows)

> **Node.js 缺失也能跑**:`Start-DeepSeek-Harness.cmd`(或 `install.ps1`/`install-deps.ps1`)
> 检测不到 Node 时会**自动下载便携版到 `runtime\node-v*-win-x64\`** 并继续(官方源失败自动切 npmmirror 镜像);
> 也可手动:`powershell -ExecutionPolicy Bypass -File scripts\ensure-node.ps1`。

```powershell
# 1) 安装依赖(自动确保 Node -> npm ci dsh core+Electron;加 -Full 再生成铃声/.env)
powershell -ExecutionPolicy Bypass -File scripts\install-deps.ps1 -Full
#    (完整安装=建目录+依赖+铃声+单测,可用 scripts\install.ps1)

# 2) 配置 API Key(不入库)
Copy-Item config\.env.example config\.env   # 然后编辑填入 DEEPSEEK_API_KEY

# 3) 启动桌面
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
#    或直接双击 Start-DeepSeek-Harness.cmd(自动修复 Node/依赖;已在运行则唤起窗口)
```

停止:`scripts\stop.ps1`。桌面快捷方式/开机自启:`scripts\shortcuts.ps1`(`-Remove` 移除)。

> **启动器行为**:双击 `Start-DeepSeek-Harness.cmd` 时,若 DS-Harness 已在运行,**默认聚焦已有窗口**;
> 若唤起失败(进程无响应/监控不健康),会**强制关闭已有实例并重新启动**。未运行时则全新启动。
> 需要同时开多个窗口时可设 `DSH_MULTI=1` 后再启动(每次再开一个新窗口)。

## 使用

1. **主窗口(默认)= 官方 dsh Web UI(与本地部署版一致,由 DS-Harness 自带引擎提供,引擎 home = `<root>\data`)**。对话/会话/附件/权限等均按官方交互使用。
2. 新增功能不替换主界面,通过 **系统托盘图标** 打开:
   - 监控(队列/峰谷/成本/余额)、设置(铃声/工作区/密钥/并发)、对话管理页(自研:附件上传/权限三档/历史右键管理/常驻用量条/搜索/筛选/添加工作区);
   - 快捷键 `Ctrl+1` 聚焦主界面,`Ctrl+2` 打开监控窗口,`Ctrl+3` 打开设置窗口。
3. 在 **设置 → 铃声** 中:
   - 勾选“启用铃声(总开关)”控制全部铃声;
   - 拖动“播放音量”;
   - 对 **任务完成 / 任务失败 / 任务中断** 各自:勾选是否响铃 → 选择内置预设或“上传本地音频…”→ “▶ 试听”;
   - 点“保存设置”生效。
4. 快速开关:对话管理页/监控头部也有“铃声:开/关”按钮(立即保存)。
5. **队列与调度**:定时排队、峰谷门控(默认谷价执行)、高峰暂停谷价自动重排、取消/清空/再跑、动态并发;监控页显示 24h 峰谷时间轴、成本拆分与余额。
6. **项目工作区(设置页或侧栏“添加工作区”)**:浏览/输入/打开目录并把任意目录设为任务工作区(任务在 `工作区\active\<任务ID>` 执行)。
7. 左侧历史管理(对话管理页):搜索/视图筛选、右键 打开/重命名/移动到文件夹/删除/批量;挂起任务额外显示原因与启动时间。

## 端口与环境变量

| 服务 | 默认 | 覆盖(设为“起点”) |
|---|---|---|
| dsh Web(官方 UI,引擎 home = `<root>\data`) | `127.0.0.1:3080` | `DSH_DSH_WEB_PORT` / `DSH_DSH_WEB_HOST` |
| 调度中心 3300(聊天/监控/设置/API) | `127.0.0.1:3300` | `DSH_UI_PORT` / `DSH_UI_HOST` |

- **端口自动错开(默认行为)**:启动时若 3080/3300 已被其他 Harness 实例或本机程序占用,
  自动向后寻找最近的空闲端口(最多 +30),无需手动配置;实际端口会打印到控制台、
  写入 `logs\desktop-runtime.log`,并保存在 `data\state\ports.json`(供脚本/运维读取)。
  桌面壳使用单实例锁防止重复拉起整套服务;再次启动会通知已运行进程**再开一个窗口(多开)**。
  实际端口见 `data\state\ports.json`。
- 显式指定起点:`set DSH_DSH_WEB_PORT=3180` 后启动即从 3180 起找空闲端口。
- `DSH_NO_DSH_WEB=1`:仅运行调度中心,不拉起 dsh 引擎。
- `DSH_START_VIEW=chat|monitor|settings|dsh`:启动时直接进入的视图(默认 `chat` 主界面;`dsh`=官方 dsh Web 并启动引擎)。
- `DSH_NODE_EXE`:指定启动引擎的 node.exe(最高优先级,其次 `runtime\` 自带运行时,再次 PATH)。

## 配置

| 文件 | 内容 |
|---|---|
| `config\.env`(不入库) | `DEEPSEEK_API_KEY`、`DSH_TELEMETRY_MODE`、`DSH_PERMISSION_MODE` |
| `config\app.json` | 端口、默认模型、时区、历史条数等 |
| `config\sound.json` | **铃声唯一真源**:`enabled` / `volume` / `events.{COMPLETED,FAILED,INTERRUPTED}.{enabled,file,label}` |
| `config\pricing.json` | 备用定价快照与峰谷时段 |
| `data\pricing\official-pricing.json` | 官方定价快照(入库) |
| `data\sessions` | dsh 会话(Web 与队列任务共用,铃声事件据此产生) |
| `data\sounds` | 用户上传的自定义铃声(不入库) |

设置保存即持久化并即时生效。铃声文件必须位于 `assets\sounds`(预设)或 `data\sounds`(上传)下,
文件名为 `[A-Za-z0-9._-]`,扩展名 `.wav`/`.mp3`;服务器只按白名单提供音频。

## 常见脚本

| 脚本 | 作用 |
|---|---|
| `ensure-node.ps1` | 确保 Node.js:找自带运行时 → PATH → 自动下载便携版到 `runtime\` |
| `install-deps.ps1` | 依赖安装:确保 Node + `npm ci`(dsh core/Electron);`-Full` 加铃声/.env |
| `install.ps1` | 完整首次安装(目录/依赖/铃声/单测) |
| `run.ps1` | 启动 Electron 桌面(`-HeadlessShell` 仅 3300 监控;`-FullAccess` 放开权限) |
| `run-monitor.ps1` | 仅 3300 监控(Node,无窗口) |
| `run-dsh-web.ps1` | 单独启动官方 dsh Web(`-Port`/`-NoOpen`) |
| `run-task.ps1 -Prompt "…"` | 跑一个 headless dsh 任务 |
| `stop.ps1` / `verify.ps1` / `test-all.ps1` | 停止 / 完整性校验 / 单测 |
| `generate-sounds.ps1` | 重新生成 `assets\sounds` 内置铃声 |
| `shortcuts.ps1` | 桌面/开始菜单快捷方式与开机自启 |

## 测试

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-all.ps1
```

覆盖:峰谷边界/周末/切换、官方价格快照、成本拆分(含跨档估计)、会话 JSONL 解析、调度门控、动态并发、
铃声配置(默认/兼容迁移/每事件开关/上传校验)等。

## 数据与隐私

- `data\`(会话、凭据、用户铃声)、`config\.env` 一律不入库;上传铃声存 `data\sounds`(gitignored)。
- 默认安全:`workspace-write` + 交互确认;仅 `run.ps1 -FullAccess` 或设置页切换才放开到 `danger-full-access`。
- 引擎数据(会话/存储)统一位于 `<root>\data`(DSH_HOME),日志 `logs\` 内令牌已脱敏。

## 合并来源

- 基线:github.com/zhiheng-zhang-Mera/Harness-Alien(桌面壳 + 官方 dsh Web 用法)
- 功能源:github.com/zhiheng-zhang-Mera/Harness-Mega(调度/计费/跟踪/监控/提示音)
- 本项目铃声中自定义/开关为合并重构新增;Mega 的 `data\dsh\sessions`/`runtime\dsh`/独立 `app\harness` 等布局统一为
  `<root>\data` + 单 `app\node_modules` dsh 安装,路径从工程自推导,不再硬编码 `D:\DeepSeek-Harness`。

## 许可

[MIT](./LICENSE)
