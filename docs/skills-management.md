# HNS Skills 管理（实现说明）

Mega 界面的 **Skills · 技能管理** 面板提供技能（agent skills）的搜索、安装与删除能力。
后端代码位于 `app/extensions/mega/skills/`，界面位于 `app/extensions/mega/ui/skills-panel.js`。

---

## 1. 为什么不自己定义技能格式

技能的格式、发现规则与加载策略由 Harness 拥有，HNS 只是它的管理界面。因此
`skill-format.js` 严格复刻 `@deepseek-ai/dsh-skill-filesystem` 的解析规则：

| 规则 | 值 |
| --- | --- |
| 技能名 | `^[a-z0-9]+(?:-[a-z0-9]+)*$`（kebab-case） |
| 目录包 | `<name>/SKILL.md` |
| 单文件 | `<name>.md`（根目录顶层） |
| 必须字段 | `name`、`description` |
| 可选字段 | `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable` |
| 布尔写法 | `true/false`、`yes/no`、`on/off`、`1/0`（大小写不敏感） |
| 不发现 | 嵌套的 `**/SKILL.md`、`.system/`、根目录 `README.md` |

**为什么坚持复刻**：面板报告"已安装"的技能，必须是 Harness 真的会加载的技能。
反之，面板拒绝的文件，就是 Harness 会静默跳过的文件。两条规则不一致会制造最糟糕的
一类问题——界面显示成功，agent 却看不到这个技能。

安装根目录是 `<dshHome>/skills`（即 `data/skills/`），这是 DSH 的一等用户根
（rank 400, `user-dsh`），而且它**被监听**：安装和删除对下一次目录读取立即生效，
**不需要重启 Harness**。

---

## 2. 交互（复刻技能商店的心智模型）

```
Skills · 技能管理
──────────────────────────────────────────────
[ 粘贴 GitHub 链接或 owner/repo，例如 anthropics/skills ] [安装]
[ 快速搜索技能：名称、用途、标签… ]            ☐ 同时搜索 GitHub
[git 2] [official 1] [documents 1] …

[发现]  [已安装]                                    2 个已安装
☐ 全选   已选 0 / 2                     [批量删除]

┌ commit-message  [内置] [模型可用]                    i  🗑
│ 按仓库既有风格撰写提交信息…
└──────────────────────────────────────────────────
```

五种操作，全部在面板内完成：

| 操作 | 入口 |
| --- | --- |
| 快速搜索 | 搜索框（防抖 220ms），可勾选"同时搜索 GitHub" |
| 安装（精选/内置） | 结果卡片上的「安装」 |
| 安装（指定 GitHub 链接） | 顶部输入框，回车或点击「安装」 |
| 安装（本地） | 「本地安装」→ 系统目录/文件选择器 |
| 单独删除 | 卡片上的 🗑 |
| 批量删除 | 「已安装」页 → 逐项勾选或全选 → 「批量删除」 |
| 整组删除 | 合集成员卡片上的 ⧉（删除该合集全部技能） |

---

## 3. 安装来源与解析

`skill-source.js` 把用户输入解析成可安装目标。支持的 GitHub 写法：

```text
https://github.com/owner/repo
https://github.com/owner/repo/tree/main/skills
https://github.com/owner/repo/blob/main/skills/docx/SKILL.md
https://raw.githubusercontent.com/owner/repo/main/skills/x/SKILL.md
owner/repo
owner/repo@main/skills/docx
git@github.com:owner/repo.git
https://任意域名/xxx/SKILL.md          → 直接下载该文件
D:\path\to\skill  /  /path/to/skill   → 本地路径
```

仓库内技能的定位顺序（`locateSkills`）：

1. 指定子路径本身是技能包或技能文件；
2. 仓库根目录本身就是一个技能；
3. 仓库收集了多个技能：根目录平铺、`skills/` 目录、或任意一层子目录。

> 一个容易被忽略的事实：**仓库根目录通常还有 README/LICENSE**。早期实现要求
> "解压后只有一个顶层条目"，结果真实仓库几乎全部解析为空——测试抓到并修掉了这一点。

安装多技能合集时按仓库名加前缀命名（`demo-alpha`），避免两个仓库各自的 `review`
互相覆盖；`upstreamName` 保留原始名，界面会显式提示发生了重命名。

GitHub 归档通过 `codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<ref>` 获取，
仓库名/分支不存在时回退 `main`/`master` 与标签形式。

---

## 4. 搜索

两个来源，刻意分开：

- **内置 + 精选**（`skill-catalog.js`）：随 DS-Hns 一起分发，**永远可用**。
  内置 5 个可直接安装的入门技能（提交信息、代码评审、发布说明、仓库导读、故障分级），
  精选指向 Anthropic 官方 skills 仓库。搜索框返回空结果是不可接受的体验，
  所以离线基线是一等功能，而不是降级方案。
- **GitHub Code Search**（可勾选）：搜索 `filename:SKILL.md`。未认证的代码搜索配额很低且
  经常被拒，所以它**严格是增量**：失败只报告"不可用"，精选结果照常展示。

搜索结果是**不可信的**：安装时重新从解析出的真实位置读取 `SKILL.md`，
所以一个已迁移或已变更的条目会在安装时明确失败，而不是装进一个别的东西。

---

## 5. 安全与完整性

技能文件就是 live agent 配置，因此规则很硬：

| 关注点 | 处理 |
| --- | --- |
| 安装前校验 | `stageCandidate` 先落到临时目录，**校验通过才** 进入技能根；失败的安装不会留下半成品 |
| 路径穿越 | tar 条目的 `..`、绝对路径、盘符路径一律拒绝；写入前再校验解析后的路径仍在目标目录内 |
| 符号链接/硬链接/设备 | 不落地，记为 skipped |
| 压缩炸弹 | 条目数与总字节数上限（默认 4096 条 / 32 MB） |
| 删除越界 | 只删除技能根内解析出的路径，`isInside` 拒绝同前缀兄弟目录（`skills-other`） |
| 批量删除 | 逐项报告，**不会因为第一个失败就中断**；重复项只报一次 |
| 渲染 | 面板只用 `textContent` / 转义后的 `innerHTML`；技能正文以纯文本展示 |

---

## 6. 与主题系统的双向适配

这是本模块的硬要求，实现方式是让两个面板走**同一个集成点** `ui/theme-bridge.js`。

```text
theme  →  module   主题包里的 slot 样式被写成 CSS 自定义属性
                   `--hns-slot-<slot>-<property>`（+ dock 既有短别名）
                   面板只消费变量，不读 token 文件、不读主题目录
                   后注册的面板会收到最后一次 payload（重放），不会漏画

module →  theme   面板把自己的 slot 与受保护区域的实时几何上报给引擎
                   UI Inspector / 预览校验因此"看得见"这个面板
                   新面板不会被主题静默遮挡
```

为 Skills 面板新增的 Theme API slot（`contract.js`）：

```text
hns.skill.card     hns.skill.header   hns.skill.badge
hns.skill.tag      hns.skill.search   hns.skill.danger
```

配套改动：

- 新增 token `color.accent.subtle`（tag/badge 用的低强调色，随 accent 色相）；
- 新增页面 `skills` 与受保护区域 `skills-search`、`skills-list`；
- **Designer 与内置主题生成器都会输出这些 slot**——生成的主题与内置主题一样能
  重绘 Skills 面板。只让内置主题适配、生成主题不适配，等于双向适配没有做。

顺带修掉一个真实缺陷：preload 监听的是 `mega-theme-probe-regions`，
主进程发送的是 `mega-theme:probe-regions`（差一个冒号），
导致"实时几何探针"从未被响应——校验器一直拿不到关键区域的实测位置。

---

## 7. 界面入口

主题系统与 Skills 面板都是可选模块，各自独立 attach，任一个失败都不影响
队列 / 硬件 / 余额模块渲染（`dock.js` 中分别 try/catch）。

```powershell
cd app; npm test        # 全部单测
powershell -ExecutionPolicy Bypass -File ..\scripts\verify.ps1
```

技能相关测试：

- `tests/unit/skills-service.test.js` — 格式、tar、来源解析、安装/删除服务（40 项）
- `tests/unit/skills-panel.test.js` — 面板行为：搜索/安装/单删/批删/主题桥（18 项）
- `tests/unit/theme-bridge.test.js` — 双向适配与容错（9 项）
- `tests/unit/theme-designer.test.js` — 生成主题覆盖 Skills 面板
