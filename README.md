# Harness-Alien

DeepSeek Harness 桌面客户端（Electron 壳工程）。

在独立 Electron 窗口中运行本地 DeepSeek Harness 服务（`dsh web --no-open`，默认 `http://127.0.0.1:3080/`），
不依赖默认浏览器；关闭窗口时自动停止 Harness 子进程，认证令牌在日志中脱敏。

> 本仓库由本机桌面部署整理而来，仅收录“作者编写部分”（桌面壳、启动器、文档、锁定依赖清单），
> 不含第三方依赖实体、运行时与个人数据 —— 依赖按 `package-lock.json` 还原，首次运行自动安装。

## 特性

- 独立窗口加载 Harness Web UI（含临时认证 URL），不占用系统浏览器
- 自动拉起 / 停止 Harness 子进程；重复启动只聚焦已有窗口（单实例锁）
- 日志写入 `logs/desktop-runtime.log`，令牌等敏感串落盘前脱敏
- Node 运行时自动定位：优先使用安装根目录 `runtime\` 下的自带运行时，其次系统 `PATH`
- 首次运行自动按 `package-lock.json` 执行 `npm ci` 还原依赖

## 版本基线

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh` | `0.1.2-rc.1` | Harness 核心（npm 官方包，由 lockfile 锁定） |
| `electron` | `43.4.0` | 桌面运行时（devDependency） |
| Node.js | v24.x（推荐 24.14.1） | 启动 Harness 服务；自带运行时放在 `runtime\` 下即自动启用 |

## 目录结构

```text
Harness-Alien/
├── app/                        # Electron 桌面壳（源码）
│   ├── desktop-main.cjs        #   主进程：解析 Node、拉起 dsh web、加载窗口、日志脱敏
│   ├── package.json            #   依赖清单
│   └── package-lock.json       #   锁定版本（npm ci 的还原依据）
├── Start-DeepSeek-Harness.cmd  # 双击启动器（自动建目录 / 装依赖 / 启动）
├── README.md
├── LICENSE                     # MIT
└── .gitignore
```

安装根目录 = 仓库检出目录（`app` 的上级）。运行期会在根目录生成以下内容，均已加入
`.gitignore`，请勿提交：

| 目录 | 内容 |
| --- | --- |
| `data/` | 用户数据：设置、凭据（`.credentials.yaml`）、会话、桌面状态 —— **敏感，勿外传** |
| `cache/` | npm 缓存 |
| `downloads/` / `temp/` | 下载与临时文件 |
| `logs/` | 运行日志 |
| `runtime/` | （可选）自带 Node 运行时，如 `node-v24.14.1-win-x64/` |

## 快速开始

### 方式一：双击启动器（推荐）

1. 安装/放置 Node.js：在根目录放 `runtime\node-v24.14.1-win-x64\`（官方 zip 解压即用），
   或安装 Node 并加入 `PATH`。
2. 双击 `Start-DeepSeek-Harness.cmd`。
   - 首次运行会自动执行 `npm ci`（联网下载依赖与 Electron），稍候片刻即可。
   - 之后启动直接打开窗口。

### 方式二：手动

```bat
cd app
npm ci
npm start
```

### 开发检查

```bat
cd app
npm run check     :: node --check desktop-main.cjs
```

## 配置

- 端口：固定 `3080`（`dsh web --no-open`）。若端口已被其他 Harness 实例占用，
  桌面进程会弹窗提示并退出 —— 先关闭旧实例再启动。
- 环境变量 `DSH_NODE_EXE`：显式指定启动 Harness 的 `node.exe` 路径（优先级最高），
  例如 `set DSH_NODE_EXE=C:\Program Files\nodejs\node.exe`。
- 日志与用户数据位置均可通过改写 `desktop-main.cjs` 顶部的 `ROOT`/`DSH_HOME` 相关逻辑调整；
  默认 `ROOT` 为 `app` 的上级目录，`DSH_HOME` 为 `%ROOT%\data`。

## 常见问题

- **Electron 下载慢 / 失败**：`npm ci` 会从 GitHub Releases 下载 Electron 二进制，
  可设置镜像后重试：`set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
- **提示端口 3080 被占用**：旧 Harness 实例仍在运行，关闭其窗口/进程后重试。
- **找不到 Node.js**：确认根目录 `runtime\` 下存在 `node-v*-win-x64\node.exe`，
  或 Node 已加入 `PATH`。
- **升级 dsh 核心**：修改 `app/package.json` 中 `@deepseek-ai/dsh` 版本后重新 `npm ci`。

## 数据与隐私

`data/` 下保存凭据与会话数据（如 `.credentials.yaml`）。请定期备份、妥善保管；
在任何情况下都不要把 `data/`、`cache/`、`runtime/`、`logs/` 等目录提交或上传到仓库。

## 许可

[MIT](./LICENSE)
