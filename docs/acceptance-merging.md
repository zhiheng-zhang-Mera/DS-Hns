# merging 分支验收记录

本文件记录 `merging` 分支的验收结果：先是 `Update-Plan/fixing-merge.md` 稳定化，
随后是「合并其余所有分支到 `merging`、只保留 `main` + `merging`」的集成验证。
供合并 `main` 之前复核。验收脚本：`scripts/acceptance.mjs`、`scripts/sub-worker-acceptance.cjs`。

## 1. 代码 Gate（Gate A）

```powershell
cd app
npm run check     # scripts\check-syntax.cjs，逐文件语法门
npm test          # node --test ..\tests\unit\*.test.js
cd ..
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

| 项目 | 结果 |
| --- | --- |
| `npm run check` | PASS（89 个源文件全部通过，含 `app/sub-worker/`） |
| `npm test` | PASS（629 tests / 629 pass / 0 fail） |
| `scripts\verify.ps1` | PASS（`VERIFY: ALL CHECKS PASSED`，exit 0） |

## 2. 真实 Electron 验收

```powershell
node scripts\acceptance.mjs --root <checkout> --port 3093 --cdp 9333 --skills --github ^
     --report temp\acceptance-report.json
```

| 项目 | 结果 |
| --- | --- |
| 通过 / 总数 | 60 / 60（0 failure） |
| 模块 | core 8/8 · dock 4/4 · theme 39/39 · skills 8/8 · updater 1/1 |
| 结论 | 全部 mandatory gate 通过，0 blocker / 0 P0 / 0 P1 |

另一次带 `--github` 的运行达到 64/65，唯一失败项是验收自身的展开控件竞态
（`the dock expands to full width through its own control` 首帧读到 `{"expanded":false}`），
不是产品缺陷：扩展启动时的展开请求与「被动等一次点击」互相覆盖。修正后验收改为启动即展开
（`DSH_MEGA_DOCK_EXPANDED=1`，让视觉观察面对真实展开的界面），同时仍通过 Dock 自己的控件验证
**折叠 → 展开** 双向行为，并在后续运行中稳定通过（含 `the dock collapses through its own control`
与 `the dock expands to full width through its own control`）。加 `--github` 的运行同时验证了
真实 GitHub 仓库安装（19 个 skill 全部安装并全部删除）。

## 3. Gate B–J 对照

| Gate | 要求 | 验收证据 |
| --- | --- | --- |
| B 基础启动 | HNS 启动、official renderer 加载、Mega Dock 加载、无未捕获异常 | `the harness listens on the alternate port`、`the official harness renderer is attached`、`the dock renderer is attached`、`the official renderer is still a rendered page` |
| C Theme | Dark → Light → Dark 且真实重绘 | `the dock repainted with the new theme`、`the renderer applied a theme payload on the switch`、`a dock panel resolves its background from the new theme` |
| D Snapshot | 正常 integrated mode 下 `visual = true` 且真实生成 PNG | `the theme design observed the UI visually`、`the snapshot PNG snapshot/<page>.png is a real image`（105 KB / 840x1326） |
| E Prompt Theme | observe → create → preview → validate → approve → apply → delete，删除后 Dark 恢复 | `a prompt creates a preview and does not install`、`the generated theme was approved and installed`、`the generated theme can be deleted again`、`the generated theme is listed and Dark is restored` |
| F System Theme Protection | 删除 dark / light 必须失败且 `reason=protected` | `a protected system theme cannot be deleted`、`every protected system theme refuses deletion` |
| G Updater Success | old → target 成功 | `tests/unit/update-runner.test.js` Test A |
| H Updater Failure | install 失败后 old 完整恢复（manifest / lockfile / 安装包 / CLI） | Test B、Test C、Test D（`--save-exact` 真改 manifest 后回滚） |
| I Rollback Failure | 必须暴露 `failed_rollback_failed` | Test E；dock 渲染 `rollback-failed` 状态与「回滚未完成，当前安装可能已损坏」 |
| J Official Renderer Isolation | 主题系统不得对官方渲染器插入 CSS / DOM / preload / 截图 | `the official renderer received no theme stylesheet`、`... no theme tokens`、`... no theme dataset` |

## 4. Warnings（不阻塞）

| Warning | 说明 |
| --- | --- |
| `GitHub network test skipped (--github)` | 未加 `--github` 的网络安装测试被跳过；加 `--github` 的运行已验证真实仓库安装 19 个 skill 并全部删除 |
| `the native directory picker could not be automated…` | Windows 目录选择框无法在本机被 SendKeys 驱动时的降级路径；install 仍通过 source channel 完成并落盘，`the local skill is installed either way` 通过 |
| `AI model adapter disabled` | 本轮不启用 AI 设计层，规则解释器独立完成设计；`theme-model-adapter` 单测覆盖启用后的失败回退 |

## 5. 复现与报告

- 报告 JSON 字段：`commit`、`branch`、`passed`、`failed`、`warnings`、`modules`、`updater`、`checks`、`notes`。
- 证据文件：`data/theme-workspace/snapshot/ui-map.json` 与同目录 PNG（运行期产物，不提交）。
- 更新日志：`logs/mega-update.log`；更新结果状态：`data/state/mega-update.json`。

## 6. 分支集成验证（合并其余分支到 merging）

`fe54634` 之后把 `Sub-worker`（`origin/Sub-worker`，含 `feat(sub-worker)` 与
`feat(multi-sub)` 两个提交）合并进 `merging`；`UI-theme`、`auto-update`、`skills`
在内容上已被 `merging` 包含（`git merge-base --is-ancestor` 成立），因此无需再次合并。

合并冲突共 5 处，全部按「两个功能都必须保留」解决：

| 文件 | 冲突 | 解决 |
| --- | --- | --- |
| `app/package.json` | `check` 脚本两套 | 保留 `scripts/check-syntax.cjs`（并把 `sub-worker` 目录纳入扫描） |
| `app/desktop-main.cjs` | 端口解析、`dockReadyCallbacks`/Sub-worker 状态、launch 参数 | 保留更严格的端口 opt-in 与 `DSH_LAUNCH_ARGS`，同时保留 Sub-worker 状态与 IPC 列表 |
| `app/extensions/mega/index.cjs` | 模块状态变量、snapshot 字段、`notifyChanged` 注释、`start()` 尾部 | 两者并存：主题状态 + Sub-worker 状态；`bindSubWorker()` 放在最后（故障隔离） |
| `app/extensions/mega/ui/dock.js` | `renderUpdate`/`renderSubWorker`、Escape 处理 | 两个渲染器都调用；Escape 顺序为 Live View → 设置层 → 主题详情 |
| `tests/unit/sub-worker-default-regression.test.js` | 断言旧的 `const HARNESS_PORT = … : 3080` | 改为断言 `normalizeHarnessPort()` 的 3080 默认值与新的 `DSH_LAUNCH_ARGS` 行 |

合并后修复的三处真实问题（均为「两功能各自正确、合起来才暴露」）：

1. `openSubWorkerLiveView()` 直接读 `dockWindow.webContents` 推送 Live View，绕过了 Dock Adapter，
   导致集成 Dock 收不到 Live View，并使 `verify.ps1` 的「不得直接读取 dockWindow」检查失败；
   现改为 `dockTarget.send('mega:sub-worker-live-view')`。
2. `scripts/verify.ps1` 的端口默认值检查仍断言旧的 `HARNESS_PORT` 写法；已改为断言
   `normalizeHarnessPort()` 的默认返回与 `DSH_LAUNCH_ARGS`。
3. `scripts/sub-worker-acceptance.cjs` 会递归复制 `app/`，遇到 `node_modules` 链接时报
   `EPERM`；现明确跳过 `node_modules` 与 `data`（脚本本来就为 scratch 根建立链接与全新数据目录）。

合并后的验证：

| 项目 | 结果 |
| --- | --- |
| `npm run check` | PASS（89/89 文件） |
| `npm test` | PASS（629 tests / 629 pass / 0 fail） |
| `scripts\verify.ps1` | PASS（exit 0） |
| `scripts\acceptance.mjs`（真实 Electron + CDP） | PASS（60/60：core 8 · dock 4 · theme 39 · skills 8 · updater 1） |
| `scripts\sub-worker-acceptance.cjs all`（真实 Worker + Harness） | PASS（60/60） |

`sub-worker-acceptance.cjs` 的集成合并检查原先只在 `waitFor` 里等「worktree 目录出现」，
而合并文件是在目录出现之后才写入的，因此偶发误报；现改为等待
`e2e-alpha.txt` / `e2e-beta.txt` 真正出现（断言强度不变，仍然是两个文件都必须存在）。

## 7. GitHub CI gate

`.github/workflows/verify.yml` 在 push / pull_request 到 `main`、`merging` 时运行
`npm run check` 与 `npm test`。Runner 目前只选 `windows-latest`：

- DS-Hns 是 Windows 桌面产品，测试会真实执行 `.cmd` 启动器、安装器 PowerShell 脚本、
  `taskkill.exe` 退出路径、PowerShell 硬件探测与 Windows 路径语义；
- 在未实际跑通一次 Linux 全量测试之前，把 `ubuntu-latest` 放进矩阵只会产生
  「没验证过的绿灯」，所以先不声明。

`app/extensions/mega/updater/update-runner.js` 的子进程 PATH 由硬编码 `;` 改为
`path.delimiter`，Windows 行为逐字节不变，非 Windows 环境（测试/CI）也能正确解析工具。

