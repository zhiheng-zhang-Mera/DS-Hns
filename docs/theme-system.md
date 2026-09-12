# HNS 统一自主主题皮肤系统（实现说明）

本文件描述 `Boss-HNS-Unified-Theme-System` 工程书在 **HNS（DS-Hns）** 侧的落地实现。
代码位于 `app/extensions/mega/theme/`（引擎）与 `app/extensions/mega/ui/theme-panel.js`（界面）。

---

## 1. 落地位置与硬约束

| 层 | 位置 | 说明 |
| --- | --- | --- |
| Theme Engine | `app/extensions/mega/theme/` | 契约、注册表、校验、设计、编译、生命周期 |
| 主题包 | `app/extensions/mega/theme/builtin/` | 内置系统主题与 Demo 主题（仓库内自包含） |
| 运行时实例 | `data/themes/user/<theme-id>/` | 用户主题（`data/` 不入库） |
| 预览工作区 | `data/theme-workspace/temp/<draft-id>/` | 批准前只存在于这里 |
| 界面 | `app/extensions/mega/ui/theme-panel.js` | Dock 的 Appearance 面板 |

**架构红线（继承 DS-Hns 既有契约）**

1. 主题系统 **只作用于 HNS 自己的 Dock 渲染器**（`app/extensions/mega/ui/`，独立 CSP 与样式表）。
2. **绝不向官方 `@deepseek-ai/dsh` 渲染器注入 CSS/JS**。官方 UI 只暴露一个只读的配色提示
   （`light` / `dark`），由官方客户端自行应用。这一点在能力清单里是显式声明的：
   `capabilities.can_theme_official_ui === false`。
3. 主题系统故障不得影响调度器、硬件监控、日志刷新与主/子进程；最坏情况是回退 Dark。

---

## 2. 管线（Prompt → … → Install）

```
User Prompt
  → UI Inspection        结构观察 + 视觉快照（只截自己的 Dock）
  → Capability Discovery Theme Capability Manifest
  → Design Intent        规则解释器（可选 LLM 精修，失败即忽略）
  → Preview Mockup       候选主题直接套用到**真实 Dock**
  → Validation           对比度 / 状态可分 / 关键区域 / 越界 / 动效 / 负载
  → User Revision / Approval
  → Theme Compilation    Theme Builder 编译自包含主题包
  → Validation           Package Validator（对编译产物再校验）
  → Registration         Theme Registry
  → Installation         data/themes/user/<theme-id>/
```

`orchestrator.createTheme()` **只到预览为止**；只有 `orchestrator.approve()` 会把包提升到正式目录。

### 2.1 视觉观察必须闭环

`UI Inspection` 不是可选的装饰步骤，它由两部分组成，且结果必须如实上报：

1. **结构 + 几何**：观察前会主动向 Dock 渲染器发一次实时测量请求
   （`mega-theme:probe-regions`），拿回真实 Slot bounding box，而不是等最后一次被动上报。
2. **视觉快照**：对 Dock 自己的 `webContents` 截图（官方渲染器永不参与），
   每个页面一张 PNG，写入 `data/theme-workspace/snapshot/`。

快照包会明确记录：

```json
{
  "visual": true,
  "degraded": false,
  "visual_expected": true,
  "visual_reason": "visual snapshot captured",
  "capture_problems": [],
  "screenshots": { "dashboard": "snapshot/dashboard.png" }
}
```

- **截图必须先通过实体校验**（`visual-artifact.js`）：PNG 签名、IHDR 尺寸、与像素数成比例的
  体积下限。空 buffer、0x0 截图、把文本错误页存成 `.png` 都会被判为缺陷并从包里剔除。
- **允许降级，但禁止静默降级**：Dock 未创建、未显示、headless、显式
  `DSH_THEME_NO_VISUAL=1` 属于**已知且允许**的降级（`degraded: false` + 原因）；
  而当 Dock 明明可用却拿不到图，`degraded` 为 `true` 并带 `visual_reason` /
  `capture_problems`，同时写日志、返回给渲染器。
- `mega:theme-observe` 返回 `visual / degraded / reason / observedSlots`；
  `mega:theme-artifacts` 返回磁盘真相（ui-map.json + 每个 PNG 的校验结论）。
  验收会因此直接失败，而不是相信一个布尔值。

---

## 3. 模块一览

| 模块 | 职责 |
| --- | --- |
| `contract.js` | Theme API 版本、Slot 表与权限等级、Token 模式、HNS 状态词表 |
| `color.js` | 颜色解析、WCAG 对比度、感知距离（无第三方依赖） |
| `png.js` | 纯 Node PNG 编码器（zlib + CRC32），主题资源生成不依赖原生模块 |
| `asset-factory.js` | 程序化生成壁纸 / 面板纹理 / 角色头像 / banner / 装饰 / 图标 |
| `validator.js` | Package Validator：manifest、资源、跨主题路径、可执行载荷、Slot 权限、可读性、状态可分性 |
| `registry.js` | 主题注册表、活动主题、内置主题隐藏标记 |
| `recovery.js` | 载入守卫；任何失败 → Dark，最终兜底是模块内置常量 |
| `designer.js` | Intent 解释、增量修订、对比度自动修复、Token 合成 |
| `builder.js` | 编译自包含主题包（tokens/components/persona/assets/preview/README） |
| `capability.js` | Theme Capability Manifest（含官方 UI 只读声明） |
| `inspector.js` | UI Inspector + UI Snapshot Package |
| `visual-artifact.js` | 截图实体校验（PNG 签名 / IHDR 尺寸 / 密度下限） |
| `model-adapter.js` | 可选 AI 设计层（默认 disabled，失败即回退规则解释器） |
| `preview.js` | 预览载荷（CSS 变量 + Slot 样式）与预览校验清单 |
| `runtime.js` | 活动主题、预览状态、负载自适应降级 |
| `lifecycle.js` | install / delete / duplicate / restore / import |
| `orchestrator.js` | 上述管线的唯一入口 |
| `index.js` | 引擎装配入口（`createThemeEngine`） |
| `ui/theme-panel.js` | Appearance 面板（唯一样式化成 UI 的消费方） |
| `../dock/target.js` | Dock Target Adapter：integrated `WebContentsView` 与 legacy `BrowserWindow` 的唯一入口 |

---

## 4. 用户界面（只保留意图级交互）

```
Appearance · 主题皮肤
────────────────────────────────
当前主题        Dark
Theme API 1.0 · 可主题化槽位 39/42 · 状态 10 种 · 官方 UI 仅配色提示
[观察界面] [导入主题]

Describe what you want
[ 银发角色，黑灰蓝色调，看起来像未来科研工作站，人物别太抢屏 ]
[Generate]

Themes
Dark 🔒   Light 🔒    Minimal Neutral    Anime Persona Demo    Cyber HUD Demo
```

生成后：

```
Preview
  校验通过 · 10/11
  ✓ text contrast      ✓ HNS state distinction
  ! critical regions present（未现场测量）
[Looks Good] [Modify] [放弃]

Modify →
What would you like changed?
[ 人物再小一点，按钮不要这么亮 ] [应用修改]
```

用户只输入自然语言，看不到 slot / token / manifest / 能力清单等内部概念。

---

## 5. 主题包结构

```text
data/themes/user/<theme-id>/
├── manifest.json      id/name/version/source/protected/theme_api_version/
│                      supported_apps/created_at/generated_prompt/
│                      revision_history/derived_from/asset_files
├── tokens.json        Theme API token（颜色/字体/间距/圆角/阴影/效果/资源）
├── components.json    Slot 样式 + 受控动效预设
├── persona.json       轻量角色元数据（HNS 上限 0.4 突出度）
├── preview.png        编译进包内的预览图
├── preview.html       自包含预览（内联 data URI，无脚本）
├── README.md
└── assets/
    ├── wallpapers/  icons/  panels/  persona/  decorations/
```

**自包含性**：运行时绘制所用资源以 `data:image/png;base64,…` 内联进 token，
同时把同一份字节写入 `assets/`，由 `manifest.asset_files` 声明。
`derived_from` 只是历史元数据，**不参与任何资源解析**——删除源主题不会影响副本（已被测试覆盖）。

---

## 6. Slot 与权限

- 命名：`<app>.<domain>.<component>[.<property>]`，共 42 个 Slot。
- `SAFE` / `STYLE` 允许主题生成器写入；`STRUCTURAL` 只在清单中如实描述，**生成器禁止写入**
  （`hns.layout.dock_width` 等 4 个）。
- 包校验器会拒绝：未知 Slot、越权 Slot、Slot 未声明的属性。

HNS 专用 Slot 族：`hns.window.*`、`hns.worker.*`、`hns.process.*`、`hns.hardware.*`、
`hns.log.*`、`hns.status.*`、`hns.tray.*`、`hns.operator.*`、`hns.persona.*`。

---

## 7. 资源与状态

内置包与生成包都不引用外部资源：壁纸、面板纹理、角色头像、banner、装饰、图标全部由
`asset-factory.js` 依据主题色板程序化生成，且**同一设计意图可复现**（确定性随机种子）。

HNS 的 10 个 canonical 状态各有独立 token：

```text
idle running waiting blocked warning failed completed
resource_limit primary_worker sub_worker
```

校验规则：任意两个状态之间的感知距离必须 ≥ 24，否则**拒绝安装**（主题可以换风格，不能混淆状态）。

---

## 8. 预览与校验

预览就是**真实 Dock**：运行时把候选主题的 token 写成 CSS 自定义属性并套用 Slot 样式，
用户看到的就是将要得到的效果。

校验清单（`preview.validatePreview`）：

| 检查 | 失败级别 |
| --- | --- |
| text contrast | 阻断 |
| HNS state distinction | 阻断 |
| token completeness | 阻断 |
| critical controls visible（越界检测） | 阻断 |
| UI bounds respected | 阻断 |
| panel opacity 保持内容可读 | 阻断 |
| background does not cover content | 阻断 |
| persona does not cover interaction | 阻断 |
| animation within allowed intensity | 阻断 |
| critical regions present（渲染器未上报几何时） | 警告（仅记录未测量） |
| load-aware effect budget | 警告 |

**Designer 的对比度自动修复**保证生成器不可能产出被校验器拒绝的配色：修复后仍不达标才报错。

---

## 9. 生命周期、删除与恢复

| 操作 | 行为 |
| --- | --- |
| Apply | 校验通过才应用；损坏主题拒绝应用并回退 Dark |
| Delete | 受保护直接拒绝 → 使用中先切 Dark → 注销 → 删除自身目录/缓存 → 刷新列表 |
| 删除内置 Demo | **只隐藏**（`data/state/theme-deleted-builtins.json`），可 `restore` 出厂 |
| Duplicate | 复制出**完全自包含**的副本，仅记录 `derived_from` |
| Import | 目录导入，重新编号 id，去除受保护标记，重新校验 |
| Recovery | manifest 损坏 / 资源缺失 / 组件异常 → Dark；Dark 也损坏 → 模块内置常量主题 |

---

## 10. 性能与负载自适应

- 负载采样 `15s` 一次（unref 定时器），只读 `scheduler.describe()`，不干扰调度。
- 三档效果预算：

| 级别 | 触发 | 效果 |
| --- | --- | --- |
| 0 full | 正常 | 全部动效/模糊/装饰 |
| 1 reduced | CPU ≥ 75% 或空闲内存 < 1.5GB | 去模糊、去装饰刷新、动效减半 |
| 2 minimal | CPU ≥ 92% 或空闲内存 < 0.6GB 或并发饱和 | 去动效、去重资源（壁纸/装饰静态化） |

降级只改写**运行时视图**，不修改已安装的主题包。

---

## 11. 测试

```powershell
cd app
npm test          # 全部单测，含主题系统
npm run check     # 全部 JS 语法检查
powershell -ExecutionPolicy Bypass -File ..\scripts\verify.ps1
```

主题相关测试：

- `tests/unit/theme-validator.test.js` — 契约与包校验（38 项断言组）
- `tests/unit/theme-designer.test.js` — Intent、增量修订、设计确定性、资源与 PNG
- `tests/unit/theme-engine.test.js` — 沙箱内的完整管线 / 删除 / 副本 / 恢复 / 降级 / 布局（12 个场景）
- `tests/unit/theme-panel.test.js` — Appearance 面板渲染器行为（17 项）
- `tests/unit/theme-visual-observation.test.js` — 视觉观察闭环：真实截图被接受并落盘；
  空截图 / 非 PNG / 8x8 / 抛异常一律 `degraded`；renderer 不可用与显式 no-visual 属于允许降级
- `tests/unit/dock-target.test.js` — Dock Adapter 两种后端、view 销毁、抛异常的 adapter、legacy 形式
- `tests/unit/theme-model-adapter.test.js` — 可选 AI 层默认关闭、失败回退、可开关
- `tests/unit/encoding-integrity.test.js` — 防止有损编码把中文注释写成替换字符

`theme-engine.test.js` 由 `tests/helpers/generate-theme-engine-test.cjs` 生成；
每个场景在**独立的临时 DSH_ROOT** 中运行，避免把测试主题装进真实安装。

重新生成内置主题（仅当系统色板变更时）：

```powershell
cd app
node extensions/mega/theme/builtin/generate.cjs        # Dark / Light
node extensions/mega/theme/builtin/generate-demos.cjs  # 三个 Demo（走真实 Builder 管线）
```

---

## 12. 第二端口验收（真实 Electron + CDP）

单测无法覆盖两件事：Dock 是否**真的**因主题载荷重绘，以及官方 Harness 渲染器是否**真的**
未被主题系统碰过。`scripts/acceptance.mjs` 因此启动真实 Electron 外壳，走 CDP 驱动真实按钮，
断言活的 DOM、真实文件系统与真实 GitHub。

```powershell
# 主实例（3080 / 默认 profile）继续运行；验收跑在第二个端口和独立 profile 上
node scripts\acceptance.mjs --root <checkout> --port 3092 --cdp 9332 --report temp\acceptance-theme.json
```

| 开关 | 作用 |
| --- | --- |
| `--root` | 被验收的 checkout（工作树亦可） |
| `--port` / `--cdp` | Harness 端口与 DevTools 端口，必须避开主实例 |
| `--report` | 结果 JSON 落盘路径 |
| `--skills` | 追加技能模块检查（搜索 / 安装 / 删除 / 批量删除） |
| `--github` | 追加真实 GitHub 仓库安装（需要网络） |

隔离由外壳的两个可选环境变量提供，未设置时默认行为与启动行完全不变：

- `DSH_HARNESS_PORT` — Harness 端口（同时作为子进程 `--port` 传入）
- `DSH_USER_DATA_DIR` / `DSH_APP_NAME` — 独立 profile 与实例名

Electron 的**单实例锁位于 userData 目录**，因此第二个实例必须用独立 profile，否则会在启动时
静默退出，看起来像“Harness 没起来”。验收脚本会为每次运行自动分配独立 profile。

