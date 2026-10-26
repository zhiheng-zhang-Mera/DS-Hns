# DS-Hns 论文修订与补实验施工书（同领域前 30% 竞争力目标）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or the available equivalent to execute this plan one task at a time. All unfinished tasks remain `- [ ]` until backed by verifiable evidence. Do not claim experiments were run merely because this plan was committed.

**Goal:** 正式投稿前，补足研究创新性论证、外部比较、关键消融、独立重复、真实长时运行与可复现材料，以同领域约前 30% 为内部改进目标。该百分位并非已测得的排名或录用保证。

**Architecture:** 以 `docs/paper-material/` 现有 claim–experiment–artifact 链为证据中枢；先冻结被测版本和预注册协议，再运行可比较实验，更新台账、统计和论文。每一个最终数字必须追溯到原始数据、配置、同一 SHA/tree、时间戳和脚本。

**Tech Stack:** DS-Hns（Node.js/Electron/Windows），Git、现有 qualification runner 和 `node:test`，Markdown/JSON/CSV，可复现统计脚本。

**Spec:** 2026-10-26 用户要求根据此前“论文终审、以同领域前 30% 为目标补实验”的讨论直接提交修订计划。本文件为基于仓库材料的重建施工书，不冒充不可访问的旧版原文。

## A. 研究定位与事实边界

**主线问题：** 长时运行的可扩展桌面 AI Harness 如何通过权限分离、有限恢复、插件隔离和持久检查点，降低失控重启、任务丢失及虚假成功，并留下可审计证据？

研究问题：

- **RQ1（恢复权限）：** 健康监测与重启执行权分离，是否减少错误重启与无限恢复循环？
- **RQ2（故障隔离）：** 统一插件生命周期和独立进程是否降低插件故障对宿主的影响？
- **RQ3（任务连续性）：** checkpoint/resume 是否减少重复副作用、任务丢失和 false-success？
- **RQ4（证据可信度）：** 绑定同一候选 SHA/runId 的不可变证据能否阻止陈旧或交叉结果冒充成功？开销如何？

Phase C 六文件 accepted-patch 批处理计时作为次级工程性能结果，除非另有机制与比较证据，不应宣称模型速度或跨产品性能优势。

### 现有证据（执行前按最新 main 重新审计）

- `03-CONTRIBUTION-CLAIMS.md` / `04-CLAIM-EVIDENCE-MATRIX.md`：C1–C6 是有边界的工程主张；C7（与其他 AI harness 的比较优势）为 `UNSUPPORTED`。
- `05-EXPERIMENT-CATALOG.md`：有资格验证、故障注入、虚拟时间 soak、Phase C 和可见 UI 记录，但工程 PASS 数量不是统计样本数。
- `08-METRICS-CATALOG.md`：曾有同主机 Phase C 约 1.88–1.90x 工程计时，部分仅三次重复，尚不足以外推为稳定跨环境优势。
- `09-THREATS-TO-VALIDITY.md` / `20-DATA-PROVENANCE.md`：真实 Windows reboot `NOT_RUN`、真实 24h 任务连续性未完成，wall-clock 观察仅 `IN_PROGRESS_PARTIAL`；另有三个历史 C 盘写入事件，不能因局部 gate 通过而抹除。
- `07-ABLATION-CANDIDATES.md` 已列出候选消融，但不能将计划候选当作完成的对照实验。
- 必须保持历史生产基线 `63eabc9`、RC2 `4ef9c0d`、工具/文档后续提交与真正被测论文版本的归属分离；实际执行时重新获取当前 SHA。

事实分级：`MEASURED` / `OBSERVED` / `SYNTHETIC` / `NOT_RUN` / `UNSUPPORTED`。不要把虚拟时钟等同真实时长，把替身进程等同生产系统，把测试断言数等同独立样本数。

## B. 前 30% 目标的可执行质量门槛

| 优先 | 当前主要缺口 | 必须交付的改进证据 |
|---|---|---|
| P0 | 新颖性论证薄弱 | 相关工作差异矩阵、核心机制不变量和可反驳 RQ |
| P0 | 无有效跨系统比较 | 语义/环境公平的至少一个外部基线；不可比时撤回 C7 |
| P0 | 缺因果消融 | 至少两项核心消融，最好覆盖恢复权限与 checkpoint/隔离 |
| P0 | 部分只有三次计时 | 预注册任务、配对重复、置信区间和异常值规则 |
| P1 | 真实运行/独立环境不足 | 可安全完成的真实任务、长时观测、第二干净环境 |
| P1 | 证据散落 | 原始数据到论文图表的一键或逐步可重复生成 |
| P1 | 工程式材料堆叠 | 一个清晰主命题、按 RQ 组织结果、透明限制 |

“前 30%”是竞争力改进目标；必须在选定 venue、相关论文样本和稿件审查后重新估计，不可用这些任务勾选率直接计算论文百分位。

## C. 建议文件布局

保留已有 `docs/paper-material/01–20`、`data/*.json` 和 `artifacts/qualification/` 历史，不破坏它们。执行时创建：

- `docs/paper-material/revision-2026-10/SCOPE_AND_RQ.md`：论文源、创新假设、投稿适配与主张边界。
- `docs/paper-material/revision-2026-10/RELATED_WORK_AND_BASELINES.md`：文献差异及公平基线筛选。
- `docs/paper-material/revision-2026-10/PROTOCOL.md`：预注册任务、种子、样本量、判据和停止条件。
- `docs/paper-material/revision-2026-10/EXPERIMENT_LEDGER.md`：每轮 PASS/FAIL/NOT_RUN、SHA/hash 和日志。
- `docs/paper-material/revision-2026-10/RESULTS_AND_CLAIMS.md`：原始数据到统计图表及结论映射。
- `docs/paper-material/revision-2026-10/REVIEW_GATE.md`：独立审稿问题、处理结果和最终投稿决策。
- `scripts/paper-revision/` 与 `tests/paper-revision/`：必要的运行器、统计与证据一致性测试。
- `artifacts/paper-revision/<run-id>/`：可公开、去敏、体积合适的原始数据和 manifest；大数据另存并以 hash 引用。

先定位真正 arXiv 提交版的文稿仓库/分支及 SHA；找不到时标为阻塞项，不凭空生成与原稿不一致的“修订版”。

## D. 实施任务（Agent 按顺序执行）

### Task 1 — 事实冻结与主张审计（P0）

**Files:** 新建 `SCOPE_AND_RQ.md`；只在证据确认后更新现有 claim 台账。

- [ ] 读取最新 main、`PAPER_MATERIAL_INDEX.md`、01–20 文档、机器可读 JSON、最终资格报告和真实论文稿，记录 HEAD/tree、主机、工具链、候选 SHA 与稿件 SHA。
- [ ] 为摘要/贡献/结果中的每项数字建立“主张→代码→实验→原始数据→SHA/hash→图表”映射；缺失则 `UNVERIFIED`，不得猜测。
- [ ] 将 RQ1–RQ4 分别写成可否定的假设、操作性指标、反例和成功/失败标准；区分研究贡献与纯 UI/工程验收。
- [ ] 执行 `node scripts/validate-paper-material.cjs`，保存命令、版本、退出码和日志；如失败，先修引用和资料一致性。
- [ ] 对最新分支中所有已修复与未解决的缺口重新查核，保留历史失败条目，不按旧索引机械宣称当前状态。
- [ ] 列出对论文结果有重大影响的未知项、缺失文件与资源需求。

**验收：** 拟入摘要的结论无孤立数字；仍缺证据的内容明确列为待验证而非已成功。

### Task 2 — 相关工作和公平基线（P0）

**Files:** `RELATED_WORK_AND_BASELINES.md`。

- [ ] 针对目标 venue 筛选不少于 12 篇紧密相关的系统论文/公开技术报告，覆盖 agent runtime、故障恢复、插件/进程隔离、任务连续性及证据完整性；记录引用、机制、测量工作负载、差异和证据强度。
- [ ] 设计 B0：本系统目标机制关闭的安全内部对照；B1：现有简单/旧策略；B2：至少一个语义兼容的外部开源 harness（若无公平可比系统，则标 `NOT_COMPARABLE`、删除跨系统优势主张）。
- [ ] 对每个外部候选记录仓库/commit/tag、许可证、接口、任务范围、可运行性、模型/硬件/超时/重试/插件配置。可选再增加第二个外部系统。
- [ ] 只比较同任务、同成功判定、尽可能相同资源的场景。某系统根本不支持的任务记 N/A，不能充作故障以制造本系统优势。
- [ ] 形成“问题—已有方法—本工作新机制—限制”表。不存在足够新颖性时收窄到经验证的系统工程贡献。

**验收：** 每个声称的比较都具有可复现对照；C7 没有外部实证则继续保持 `UNSUPPORTED`。

### Task 3 — 预注册工作负载、统计与复现协议（P0）

**Files:** `PROTOCOL.md`、数据 schema、实验运行器及单元测试。

- [ ] 实验开始前冻结：工作负载、故障注入时点、种子、对照配置、运行顺序、恢复窗口、成功定义、排除规则、异常值规则、停止条件，提交其 commit SHA。
- [ ] 任务覆盖：无故障对照、插件 crash/timeout、宿主死亡、暂时网络中断、多插件并行、跨会话 checkpoint、重复副作用和 evidence replay。分别标 `REAL/INJECTED/VIRTUAL_TIME/STAND_IN`。
- [ ] 使用同输入同种子的 paired AB/BA 交替，目标每核心场景 20–30 个独立 episode；Phase C 至少 20 个配对计时样本，分冷/热启动与测试顺序。资源不足时标为探索性实验并报告宽 CI，不能虚报样本充分。
- [ ] 单条结果携带 runId、候选 SHA/tree、scenario、seed、对照名、配置 hash、时间戳、原始日志 SHA256、判定和超时状态。
- [ ] 写校验测试：跨 SHA 拼接、重复种子、缺文件、错误时区、伪 PASS、总数不一致必须报错；原始数据与摘要不能互相覆盖伪造。
- [ ] 加入安全/预算控制：故障注入只用可逆 fixture，真实进程可被带外终止，运行费用和最长时间先给出预计。

**验收：** 在正式测量前，fixture 能完整验证采样、解析、统计和证据一致性；实验协议已冻结。

### Task 4 — 核心消融（P0）

**Reference:** `07-ABLATION-CANDIDATES.md`，以复用既有代码边界为先。

- [ ] **A1 权限分离：** 相同健康遥测/重启请求，分离式 restart-control vs 耦合策略，记录误重启、越权、恢复成功及延迟。若策略语义不能保持一致，停止并说明原因。
- [ ] **A2 进程隔离：** 异构插件在相同 crash 日程下，隔离进程 vs 安全的进程内替代，记录宿主存活率、恢复率和资源峰值。
- [ ] **A3 重启预算：** 有限预算 vs 无业务预算但有外部硬上限的安全对照，记录重启循环、拒绝、资源成本；禁止真无限循环。
- [ ] **A4 检查点：** 可逆任务上 checkpoint/resume 开/关，测任务丢失、重复 side-effect、false-success、恢复延迟；不得使用不可逆的外部操作。
- [ ] **A5 证据绑定：** immutable run + SHA vs 受控陈旧证据混入，比较识别率、误接收和校验开销。
- [ ] **A6 Phase C：** 对同六个文件和相同 accepted-patch 判定，分别运行多进程和批处理，保留原 1.2 阈值，测真实 wall-clock ms 和配对比值。
- [ ] 每项记录配置 diff、原始事件与失败样本；至少优先完成两项直接支持主命题的消融（建议 A1+A4 或 A2+A4）。

**验收：** 能解释机制被移除时的因果变化；无改善也保留为负面结果，不靠增改阈值制造优势。

### Task 5 — 基线比较与真实稳健性（P0/P1）

- [ ] 按预注册任务执行内部与可比外部基线，比较完成率、宿主存活、恢复延迟、重复副作用、资源成本；记录不适用场景。
- [ ] 在第二个独立干净 Windows 主机/环境复核核心指标；若无第二主机，保留单机局限，不宣称跨平台。
- [ ] 资源、安全和权限允许时执行真实 wall-clock 长任务（理想 24h），将 provider、task、checkpoint、retry、plugin 事件与时序样本关联；仅采集 host liveness 不能算完整 soak。
- [ ] Windows 真正 reboot 仅在确认安全恢复、D-only 存储、授权与带外控制可用时执行；否则保持 `NOT_RUN` 并删去相关强结论。
- [ ] 重新检查三个历史 C-drive 写入事件；局部 clean-run 的零新增写入不能抹去历史记录。
- [ ] 失败、timeout、删失和异常运行均保留在台账；禁止静默删除不利样本。

**验收：** 至少一个有意义的可重复基线对照；真实任务未完成则从摘要和强可靠性声明中降级。

### Task 6 — 统计分析、图表与主张更新（P0）

**Files:** `RESULTS_AND_CLAIMS.md`、统计脚本、`08-METRICS-CATALOG.md` 及机器可读台账（有证据后再更新）。

| 指标 | 定义 | 备注 |
|---|---|---|
| Task success rate | 满足预注册终态 episode / 有效 episode | 测试 assertion 数不是样本量 |
| Recovery success | 故障后在固定恢复窗口内成功 episode / 注入故障 episode | 超时不能算成功 |
| False-success rate | 校验失败但被标成功 / 被标成功 episode | 分母为零记 N/A |
| Duplicate effect rate | 发生重复可逆副作用 / 涉及副作用 episode | 只用安全 fixture |
| Recovery latency | 故障发生至恢复确认的时间 | 报告 timeout/censor |
| Restart-loop rate | 超出策略预算的 episode / 故障 episode | 受外部硬上限保护 |
| Accepted-patch latency | 相同六文件任务被接受的 wall-clock ms | 不是模型请求延迟 |
| Resource cost | CPU、内存、I/O 峰值与时间积分 | 说明观察器开销 |

- [ ] 比例报告分子/分母及 Wilson 95% CI；计时报告 median、分位数、配对差/倍率和按独立 episode 重采样的 bootstrap 95% CI。
- [ ] 记录样本数、失败数、超时数、排除原因和探索性多重比较；不同 SHA/虚拟 horizon/断言数不可混为独立 n。
- [ ] 由原始数据程序化生成结果表和图；进行分母、总数、CI、单位、数字与正文一致性测试。
- [ ] 新增或修订 `claims.json` / `experiments.json` / `metrics.json` / `artifact-index.json` 只在实际测得后执行，并保留历史记录。

**验收：** 所有论文数字、置信区间和图表可由公开或可获取的原始数据及固定代码重建。

### Task 7 — 正式论文重写与复现包（P1）

- [ ] 摘要以“问题—关键机制—可比较的实验—数字—边界”组织，不把工程测试数量当论文核心结果。
- [ ] 引言提供有记录的具体失败动机；明确提出 2–3 项可辩护贡献，不使用未经验证的 first/best/novel。
- [ ] 方法写清 restart 权限边界、状态机、不变量、插件隔离、检查点持久性和 fail-closed evidence；区分框架机制与实现细节。
- [ ] 评估按 RQ 分节：主表是有意义的对照与消融，附 CI 与失败率；资格验证单列“工程正确性”。
- [ ] 图表候选：架构权限边界、故障→恢复时间线、对照表、消融图、恢复延迟分布、数据/证据谱系图；只保留服务于论点的图。
- [ ] 将 `06-NEGATIVE-RESULTS.md`、`09-THREATS-TO-VALIDITY.md` 的关键内容写入 limitations；如 C7 仍不支持，删去优越性主张。
- [ ] Artifact README 说明锁定环境、依赖/许可证、单任务/全量重跑命令、耗时/费用、字段词典、数据哈希与去敏规则，不附凭据。
- [ ] 检查 LaTeX/Markdown 引用、图表数值、统一术语和语言，保留与实际 arXiv 稿版本的 diff 和修订记录。

**验收：** 每条主要贡献都有研究问题、机制、实验和限制，稿件能独立于工程日志阅读。

### Task 8 — 独立复核与投稿闸门（P1）

- [ ] 三轮逆向检查：领域新颖性、统计严谨性、artifact 可复现性；记录意见为 `BLOCKER/MAJOR/MINOR` 与关闭证据。
- [ ] 最终论文版与 DS-Hns 被测 SHA 绑定，检查版权、许可证、敏感路径、日志匿名化和基线公平。
- [ ] 重新运行 `node scripts/validate-paper-material.cjs` 与新增统计/证据测试，并保留退出码和日志 hash。
- [ ] 任何没完成的真重启、长时任务、第二系统/平台只能作为限制，不得写成通过。
- [ ] 分别给出“可投稿”“需补实验”“更适合工程实践或软件 artifact 类 venue”建议，列出剩余 P0 blocker。

**强制投稿门槛：** 主张与数据一致；RQ 清晰；至少两项重要消融；至少一个公平对照；样本/区间透明；图表可从原始数据重算；负面结果披露。外部基线、第二独立环境和长时真实任务对竞争力有很高价值，但不可行时应收窄结论，而非伪造证据。

## E. 执行次序与 Agent 汇报协议

顺序：`Task 1 → Task 2 → Task 3 → (Task 4 + Task 5) → Task 6 → Task 7 → Task 8`。

每完成一个阶段，Agent 必须汇报：

1. 本轮新增加且已验证的结果（数字、n、CI、commit、artifact）。
2. 失败与尚未运行事项（原样保留）。
3. 尚未关闭的 P0 缺口、对投稿主张的影响。
4. 下一步预计时间、算力/费用和安全前提。

不能因为计划存在就勾选完成；不能不经同意执行风险性主机重启、不可逆副作用、付费服务、删除历史/强推分支。优先研究证据，而不是继续扩建无直接论文贡献的新功能。

### 给执行 Agent 的首轮命令

“请先只读审计 DS-Hns 最新 main 与实际 arXiv 论文源，冻结 SHA，输出 `SCOPE_AND_RQ.md` 和 `RELATED_WORK_AND_BASELINES.md`，精确列出实验 P0 缺口；先完成可追溯性验证与预注册协议，再进行安全的对照/消融实验。不得把历史工程 PASS 当作新研究数据，也不得宣称未执行实验完成。”

---

**Document date:** 2026-10-26  
**Status:** `PLAN_ONLY — EXPERIMENTS_NOT_EXECUTED`  
**Source:** DS-Hns 当前可见 `docs/paper-material/` 证据与先前讨论；执行前重新核对最新 HEAD。  
**Explicit non-claim:** 上传本方案不代表论文已达到前 30%、真实 24h/reboot 已完成或项目具备生产发布资格。
