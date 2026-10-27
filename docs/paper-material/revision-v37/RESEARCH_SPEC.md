# ECQ v37 研究规格

日期：2026-10-27。适用版本：`Essay-Book/DS-Hns-H/arxiv/v37/`。

## 1. 本轮范围与输入

用户本轮指令重开 ECQ 实现、直接实验和论文结果更新。对 v37，本文取代旧 `PAPER-RULES-AND-ROUTE.md` 中“ECQ 仅保持 proposal、冻结后默认不接纳新实验”的路线限制。旧档案的代码身份、观察结果和统计单位继续按原记录引用；新增 ECQ 结果使用独立批次。ICSE 的既有稿件保留其当前版本身份。

输入：Essay-Book `3690881cfbaf3b6f1b74a001d20311dd92f399e3`；DS-Hns `4023749389233a424b48320f6d30c160784986bd`；论文 v0.36。历史组件实验 V1 为 630 个处理臂观察，V2 为 120 个；它们作为已有组件证据单列。

## 2. 研究目标

将 ECQ 从形式规格推进为可执行、可迁移的软件资格证据合同 profile：对给定声明，检验状态、运行、gate、工件、证据类型与支持关系，并输出关系级诊断及依据。

主线有三项：

- **可执行语义**：分开表示证据闭合、gate 满足和最终授权。
- **受控比较**：在共同输入上比较 outcome-only、常规 manifest、SHACL profile 与原生 ECQ。
- **跨来源适配**：将 DS-Hns 及两个独立项目的 CI 材料映射到同一模型，并验证映射和判断。

“前 30%”属于内部质量目标。通过固定同类论文样本、证据锚定评分及两次独立审查判断；论文正文只写完成的研究贡献和结果。

## 3. 统一输入与接口

保持六元模型 `Q=(S,R,G,E,T,V)`。合同独立于收到的证据集合；原始记录经适配器转换为规范化输入。

### 3.1 数据类型

| 类型 | 必需内容 |
|---|---|
| `Contract` | `contractId`、`statePolicy`、`runPolicy`、`requiredGates`、`claimGraph`、`requestedClaim`、`admissibleTypes` |
| `StateDescriptor` | `repositoryId`、`commit`、`tree`；合同指定时包括 `configurationDigest`、`dependencyLockDigest` |
| `EvidenceItem` | `id`、`subject`、`runId`、`gateId`、`claimId`、`scope`、`outcome`、`evidenceType`、`artifactRefs` |
| `ArtifactRef` | 包内相对路径、预期对象标识、可信预期 SHA-256；读取状态另行记录 |
| `Obligation` | `obligationId`、`invariant`、`subjectRefs`、依赖事实与合同来源 |
| `RelationResult` | `obligationId`、`invariant`、`status`、`witnessRefs`、`reasonCode` |
| `AuditResult` | `closureStatus`、`gateSatisfaction`、`authorizePass`、`relations`、`methodIdentity` |
| `BaselineResult` | `authorizePass`、支持时填写的 `closureStatus/gateSatisfaction/relations`、`capabilities`、`methodIdentity`；不支持的字段为 `null` |
| `MethodOutput` | `caseId`、`methodId`、`methodRevision`、`attemptId`、`executionStatus`、`exitCode`、`capabilities`、`result`、`timings`、`stdoutPath/stderrPath` |

`RelationResult.status` 为 `ESTABLISHED / VIOLATED / UNRESOLVED`。

`closureStatus`：全成立为 `CLOSED`；存在已证违规为 `VIOLATED`；其余为 `UNRESOLVED`。即使聚合状态为 VIOLATED，仍保留所有未解决关系。

`gateSatisfaction`：`SATISFIED / UNSATISFIED / UNRESOLVED`。

```text
authorizePass = (closureStatus == CLOSED)
                and (gateSatisfaction == SATISFIED)
```

规范化包不含 oracle 标签、变异名称或期望 verdict。实验外层清单存储 `caseId/baseId/sourceGroup/split`；判定器仅收到不透明 case ID、合同、规范化记录及工件。

`MethodOutput.executionStatus` 为 `COMPLETED / RUNTIME_ERROR / TIMEOUT / UNSUPPORTED`。`result` 在成功完成时为 AuditResult 或 BaselineResult，其他情况为 `null`；执行错误不转换为 `authorizePass=false`。四种方法均在 `MethodOutput.capabilities` 明确列出 authorization、closure、gateSatisfaction、relationDiagnostics、witnesses 五项能力；BaselineResult 的能力记录与该声明一致。方法不提供的诊断字段与有语义含义的 UNRESOLVED 分开。B0/B1 共同参加授权比较，完整三轴匹配只对提供三轴输出的方法计算。

关系实例用稳定的 `obligationId` 标识：由义务类别、合同条款 ID 和被检查对象 ID 确定，不依赖数组顺序。两种完整实现分别枚举关系，但使用这一共同标识约定以便比较；允许一项事实同时支持多个关系。

### 3.2 固定接口

```text
normalizeDSHns(record, mappingSpec) -> {bundle, contract, mappingWitnesses}
normalizeActions(record, workflowAtCommit, eventContext, mappingSpec)
  -> {bundle, contract, mappingWitnesses}
enumerateObligations(bundle, contract) -> Obligation[]
resolveArtifact(ref, artifactRoot) -> {status: FOUND|MISSING|UNAVAILABLE, bytes?, actualSha256?}
evaluateQualification(bundle, contract, artifactResolver) -> AuditResult
evaluateManifest(bundle, contract, artifactResolver) -> BaselineResult
runShaclProfile(bundle, contract, artifactResolver) -> AuditResult
```

原生 ECQ CLI：`node scripts/ecq/cli.cjs --bundle B --contract C --artifacts A --out R`。正常生成审计结果时进程退出 0，包括 `authorizePass=false` 的结果；无法完成工具运行时退出 2，并保留错误记录。进程退出状态与资格授权分别统计。

## 4. 八项关系的可执行含义

| 义务 | 检查内容 | 关键样例 |
|---|---|---|
| `I_S` 状态 | 证据的状态字段满足合同要求 | 相同 commit、不同配置仍可不匹配 |
| `I_R` 运行 | 证据来自合同允许的运行及复用策略 | 显式授权的跨运行复用可以成立 |
| `I_G` 覆盖 | 每个必需 gate 有相应支持 | 条件 job 是否必需取自 workflow 与事件上下文 |
| `I_V` 范围 | 请求声明由合同声明图中的支持路径覆盖 | 局部 PASS 不能自动取得整体声明范围 |
| `I_E` 引用 | 证据引用解析为指定对象 | 确认缺失的必需工件为引用违规 |
| `I_C` 绑定 | 证据、gate、声明、状态之间的绑定符合合同 | 将正确观测挂到另一声明可构成违规 |
| `I_I` 完整性 | 实际工件字节匹配可信预期摘要 | 缺少字节时该项未解决；摘要不同才是已证不符 |
| `I_T` 类型 | 证据类别及来源满足合同 | 控制性模拟与真实执行按要求区分 |

声明范围使用显式有向支持关系，不采用名称前缀或字符串包含判断。必需关系集合先由合同与输入对象枚举，再逐项判断。适配器保留原始值和映射依据；缺失值作为缺失事实进入模型。

五个共同语义测试：合法完整 FAIL；授权跨运行复用；同 SHA 不同配置；引用缺失伴随完整性未解决；组合修改同时影响多条关系。另检查记录排序与可解析路径表达变化是否保留判定。

## 5. 四种判定方法

| ID | 方法 | 能力与研究角色 |
|---|---|---|
| `B0` | Outcome-only | 聚合输入中的局部 PASS；用于测量被丢弃关系的影响 |
| `B1` | Conventional manifest | 检查状态／运行、必需 gate 集合、引用存在及摘要；在主实验前明确每项规则 |
| `B2` | SHACL profile | 将同一八项合同语义编码为 SHACL Core／SPARQL，由 pySHACL 执行 |
| `ECQ` | Native observer | 直接实现上述语义、关系级输出和诊断见证 |

所有方法接收相同可用事实。共享工件读取和实际摘要计算可以复用；约束判定逻辑各自实现。B2 的 RDF 转换保留所有输入关系，其 UNRESOLVED 适配由独立包装层完成，不读取 ECQ 输出。

pySHACL 的 conformant、non-conformant、运行错误和功能未实现分别计数。B0/B1 未提供的诊断能力列为不支持，并报告覆盖率；共同授权指标仍对所有方法计算。

如果 B2 与 ECQ 判断一致，贡献写为语义可移植和诊断接口一致性。实现开销由成本实验描述。开发时间或维护成本优势需要专门测量，不能由代码行数推断。

## 6. 证据与研究问题

| RQ | 问题 | 必需证据 |
|---|---|---|
| RQ1 | 资格判定能否同时控制错误授权和合法证据误拒绝？ | 锁定挑战集、四方法输出、关系真值 |
| RQ2 | 八项义务如何贡献覆盖，组合错误如何诊断？ | 单目标与组合变异、八次消融、诊断见证 |
| RQ3 | 跨来源规范化是否保持资格语义？ | DS-Hns 案例、两外部项目、映射见证、源记录 |
| RQ4 | 规则检查和工件校验成本如何随规模变化？ | 分离正常化／规则／端到端成本，两环境复测 |

现有 A3/A4 放入支持机制小节或附录，用来解释具体 evidence predicate。主结果表优先给 ECQ 直接实验。历史 W0/W2 继续保持原统计单位。

## 7. 文献与增量比较

必须阅读并逐项填写文献矩阵：

- [PROV-CONSTRAINTS](https://www.w3.org/TR/2013/REC-prov-constraints-20130430/)
- [SHACL 1.0](https://www.w3.org/TR/2017/REC-shacl-20170720/) 与 [pySHACL](https://github.com/RDFLib/pySHACL)
- [in-toto 原论文](https://www.usenix.org/conference/usenixsecurity19/presentation/torres-arias) 与 [验证语义](https://in-toto.readthedocs.io/en/stable/command-line-tools/in-toto-verify.html)
- [SACM 2.3](https://www.omg.org/spec/SACM/2.3/About-SACM)
- [Evidential Tool Bus 2024](https://homes.cs.washington.edu/~mernst/pubs/etoolbus-dasc2024-abstract.html)

矩阵列：判定对象、输入/信任假设、合同与证据分离、gate结果与证据有效性、状态/运行/范围表达、未知与违规区分、诊断粒度、来源适配、实现/数据、实际实验、ECQ增量、精确条款/页码。

能力标签统一为“原生支持／配置可实现／本文扩展／未验证／不适用”。in-toto 的原生 layout 包含步骤、授权执行者及材料/产品规则；SACM 作为表达模型比较，ETB 作为异构工作流比较。运行基线采用 B2，避免为非同类工具构造失真的速度排行。

## 8. 论文写作规格

建议结构：Introduction → Related Work → ECQ Semantics → Implementation and Source Mapping → Evaluation → Discussion → Artifact Availability → Conclusion；历史恢复材料放附录。

贡献必须对应完成的实现、直接实验和跨来源映射。研究范围和主要有效性限制集中在 Discussion 的一个小节；正文其他位置只保留理解结果所需的局部条件。

论文中不加入内部百分位目标、施工状态、反复的“未证明／不保证／不属于”段落。保留有实质意义的样本单位、数据来源、失败结果和测量终点说明。

最终提交材料全部位于 `v37/submit/`。v37 的作者、单位、邮箱、ORCID 沿用已确认稿件；论文结果更新后同步英文摘要、提交表单和中译稿。

