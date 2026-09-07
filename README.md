# DS-Harness — DeepSeek Harness 桌面客户端(合并版)

> 由私有仓库 **Harness-Alien**(桌面壳基线)与 **Harness-Mega**(队列/计费/监控/铃声等功能参考)合并而来。
> **UI 以 Alien 桌面壳为绝对基准**:单一 Electron 窗口,**主界面 = ChatGPT/Codex 式集成对话**;
> Mega 仅作为**功能来源**,其界面不做“整页叠加切换”,队列/峰谷/余额/铃声以小图标+悬浮概要、底部常驻用量条呈现,
> 详细功能放同窗可切换的“监控/设置”页(不弹新窗口);官方 dsh Web 作为可选“官方视图”按需启动。
> 铃声(ringtone)已做成 **用户可自定义 + 可选开关**。

## 特性

- **以 Alien 桌面壳为基准的单窗口体验**:不占用系统浏览器;单实例锁、日志令牌脱敏、端口自动错开、关闭即停引擎。
- **主界面(默认)= 集成对话,参考 ChatGPT/Codex**:左侧任务/排队列表 + 对话区 + 底部 Composer;
  - 对话框下方**常驻参考数据条**:输入 / 输出 / 缓存命中(命中率) / 成本 ¥ / 状态(随所选任务实时更新);
  - **小图标 + 鼠标悬浮概要窗**:队列(等待/挂起/运行数)、余额(TOTAL/TOP-UP/GRANTED)、峰谷(当前/下一档)、铃声(总开关/每事件)——点击小图标直达对应详细页或切到“排队”;
  - 顶部保留峰谷徽标、模型、声音开关。
- **监控/设置(同窗详细视图,不弹新窗口)**,端口 `http://127.0.0.1:3300`:
  - 监控 `/`:双时区峰谷、24h 时间轴、余额、价格对比、动态并发、最近任务、定时排队队列;
  - 设置 `/settings.html`:API Key / 模型 / 权限 / 遥测 / 并发 / **铃声(预设+上传+试听+每事件开关)**;
  - **无顶部系统菜单栏**:视图切换并入窗口内容区(页内导航/链接 + `Ctrl+1..3`)。
- **官方 dsh Web 视图(可选)**:主界面头部“官方 dsh”按钮或 `Ctrl+4`,按需启动引擎加载;
  默认不再进入该页面(避免整页切换与纯黑/空窗问题)。
- **端口自动错开**:dsh Web(默认 3080)与调度中心(默认 3300)被占用时自动向后寻找空闲端口,
  并把实际端口写入 `data\state\ports.json`,多实例/多客户端并存时互不冲突。
- **队列与调度**:定时排队(Scheduled Queue)、峰谷价格门控(默认谷价执行)、高峰暂停并谷价自动重排、取消/清空/再跑、本机资源动态并发(CPU/内存实时计算)。
- **成本与余额**:会话用量→CNY 成本拆分(含跨档估计)、官方价格快照、DeepSeek 余额 TOTAL/TOP-UP/GRANTED。
- **铃声(本合并版重点重构)**:
  - `config\sound.json` 为唯一真源:`enabled` 总开关 + `volume` 音量 + 每事件独立开关与音频文件;
  - 完成(COMPLETED)/失败(FAILED)/中断(INTERRUPTED)三类事件全覆盖——前台 dsh 会话与调度队列任务结束都会触发;
  - 内置 9 个预设铃声(`scripts\generate-sounds.ps1` 重新生成),每个事件也可**上传本地 wav/mp3** 作铃声(存入 `data\sounds`,不入库);
  - 设置页支持每事件“试听 ▶”即时预览;修改点“保存设置”后立即生效并持久化;
  - 桌面版由隐藏音频宿主窗口播放——**无论停留在对话主界面还是监控/设置视图都能听到**;浏览器模式由页面直接播放;铃声失败永不阻塞 dsh 执行。

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

> **启动器行为**:双击 `Start-DeepSeek-Harness.cmd` 时,若检测到 DS-Harness 已在运行,
> 会自动唤起已有窗口(单实例,不会重复启动);若唤起失败(进程无响应/监控不健康),
> 会**强制关闭已有实例并重新启动**。

## 使用

1. **主窗口(默认)**打开即进入 **ChatGPT/Codex 式对话主界面**:在底部输入任务(默认谷价自动开始/可勾选立即或定时)并管理任务;Composer 下方常驻 输入/输出/缓存命中(命中率)/成本 参考数据,顶部“⏱队列”“¥余额”“峰谷徽标”“铃声”小图标悬停可看概要、点击跳对应页面/排队面板。
2. 页面内导航(或 `Ctrl+1..3`)切换:主界面对话 / 监控 / 设置(同窗详细视图,不弹新窗口);`Ctrl+4` 或头部“官方 dsh”= 官方 dsh Web 视图(按需启动引擎)。
3. 在 **设置 → 铃声** 中:
   - 勾选“启用铃声(总开关)”控制全部铃声;
   - 拖动“播放音量”;
   - 对 **任务完成 / 任务失败 / 任务中断** 各自:勾选是否响铃 → 选择内置预设或“上传本地音频…”→ “▶ 试听”;
   - 点“保存设置”生效。
4. 快速开关:主界面/监控头部也有“铃声:开/关”按钮(立即保存)。
5. **左侧历史管理**:右键某条历史可 打开 / 重命名(显示名存于本地元数据) / 移动到文件夹… / 删除 / 进入批量操作;
   批量模式支持 全选 / 移动所选到文件夹 / 删除所选。任务为“挂起”时,底部常驻条与对话区会额外显示 挂起原因与启动时间(计划时间或谷价下一档)。

## 端口与环境变量

| 服务 | 默认 | 覆盖(设为“起点”) |
|---|---|---|
| dsh Web(官方 UI,引擎 home = `<root>\data`) | `127.0.0.1:3080` | `DSH_DSH_WEB_PORT` / `DSH_DSH_WEB_HOST` |
| 调度中心 3300(聊天/监控/设置/API) | `127.0.0.1:3300` | `DSH_UI_PORT` / `DSH_UI_HOST` |

- **端口自动错开(默认行为)**:启动时若 3080/3300 已被其他 Harness 实例或本机程序占用,
  自动向后寻找最近的空闲端口(最多 +30),无需手动配置;实际端口会打印到控制台、
  写入 `logs\desktop-runtime.log`,并保存在 `data\state\ports.json`(供脚本/运维读取)。
  桌面壳为单实例:重复启动只会聚焦已有窗口。
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
