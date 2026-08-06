# 方案 C：把修复下沉到管线内（长期架构）

**状态**: 设计文档（v3，已过自我 review） · **日期**: 2026-08-06 · **目标**: 让 novel 管线（而不是失败处理器）本身成为完备的自愈系统

本方案对应《神通者》全书自动成书在 ch8 章节合同质量门禁被判 `replan_window` 时管线不自愈的根因。用户的诉求是"想做好 novel 项目本身"，即**长期架构**：把修复能力作为管线一等公民，而非在失败发生后由导演层事后打补丁。

---

## 1. 现状根因（已用代码验证）

### 1.1 两条不互通且都极浅的修复回环

| 回环 | 位置 | 深度 | 状态 |
|---|---|---|---|
| 本地 3 次带反馈重试 | `volumeGenerationHelpers.ts` L789-906 | 每次失败把 `qualityFeedback` 拼进 guidance 重试 | **活代码**，有效 |
| 导演预算阶梯 | `director/runtime/DirectorQualityLoopBudgetLedgerService.ts` `resolveDirectorQualityLoopBudgetNextAction` | `auto_patch_repair → auto_rewrite_chapter → auto_replan_window → defer_and_continue` | **死代码**：`AutoExecutionFailureHandler.ts` L289-293 把 tier 归一成单一 action |

**深度证据**：
- `volumeGenerationHelpers.ts` L789 `for (let attempt = 0; attempt < 3; attempt += 1)` —— "次数上限 3"是写死本地常量，与预算阶梯 `patchRepair: 2` **完全脱节**。两条回环互不知道对方。
- `AutoExecutionFailureHandler.ts` L238-245：`resolveDirectorQualityLoopBudgetNextAction` 求出的 `plannedBudgetAction` 被归一成单一 `budgetAttemptAction`，无论值是什么都只"记录一次"；L291 `qualityAction` 只有 defer 与 replan 两个可执行出口，`auto_patch`/`auto_rewrite` 永不真正重跑管线。

### 1.2 反馈无法穿透到导演层

- 管线的反馈（门禁判据、失败文案、issue id）被塞进 `job.error` 字符串 + 枚举 marker（`[contract_replan_window]`），导演层只能做**字符串匹配**分类（`novelDirectorAutoExecutionFailure.ts` `isContractReplanWindowFailure`）。
- `ChapterQualityLoopService.recordAssessment`（正文质量）会把 `QualityFeedbackPacket` 写进 `chapter.riskFlags`，但那是正文质量，与任务单规划门禁（`chapterTaskSheetQualityGate`）是两套独立机制，互不联动。
- 结论：**反馈链断裂在 volume 层与 director 层的边界**。管线失败后把整个 job 结算为 failed（带一个字符串），导演才醒来。

### 1.3 依赖方向（review 补充的关键约束）

- director → volume：**单向成立**。`NovelDirectorService.ts`、`novelDirectorPipelineRuntime.ts` 等 import `NovelVolumeService` / `volumeSettingCompletionService`。
- volume → director：**0 处**。volume 从不反向 import director。
- 含义：方案 C 若让 volume 层直接调用 `director/runtime/DirectorQualityLoopBudgetLedgerService`，会构成**循环依赖**。账本必上提为共享纯函数模块（见 §2.2-B）。

---

## 2. 方案 C 架构：修复作为管线的一等公民

### 2.1 分层职责重定

把"导演事后处理失败"重构为"管线本身携带修复预算地执行"，**预算作为第三类一等状态**贯穿：

```
共享层 qualityLoopBudget（纯函数，无副作用）
     ▲            ▲
     │            │  import
volume 层          director 层
（生成/门禁）        （编排/预算查询/熔断/action 调度）
```

关键：**预算阶梯必须能真正驱动"再次进入管线执行"的动作**，而不是只记账然后 defer。且**共享账本不能让 volume 反向依赖 director**。

### 2.2 核心改动清单

#### A. 上提账本为共享纯函数层（P1 修正）

- **新建 `server/src/services/novel/qualityLoopBudget.ts`**，把 `DirectorQualityLoopBudgetLedgerService.ts` 里的：
  - `DIRECTOR_QUALITY_LOOP_BUDGET_LIMITS`（patch/rewrite/replan 上限）
  - `buildDirectorQualityLoopBudgetWindow` / `buildDirectorQualityLoopIssueSignature`
  - `resolveDirectorQualityLoopBudgetNextAction` / `recordDirectorQualityLoopBudgetAttempt` / `findDirectorQualityLoopBudgetEntry`
  —— 迁移到此共享模块（保留导入兼容，`DirectorQualityLoopBudgetLedgerService.ts` re-export 以防目录内引用断链）。
- **依赖方向**：`volume/` 与 `director/` 都只 import `qualityLoopBudget.ts`，不再互倒。杜绝循环依赖。
- 这些本来就是纯函数（仅依赖 `crypto` + 共享类型），上提无副作用。

#### B. 本地重试与修复预算语义解耦（P2 重点）

**不要**把 volume 内 `for attempt<3` 与 director 预算 `patchRepair` 合并成同一个计数器：

- volume 内重试上限应来自 **`RepairOptions`/章节生成质量重试配置**（单次生成内，因门禁反馈追加重试），沿用现有参数，不触碰 director 账本。
- director 预算 `patchRepair` 数的是**跨 pipeline 调度**的修复动作数（每一次"重跑 patch"动作）。
- 二者语义不同域，分开计数。若误共享，单次生成内的反复反馈重试会提前烧掉跨调度的修复预算，导致本可 `auto_patch` 的失败被误判成"预算耗尽"直接落终态。

#### C. patch / rewrite 复用现有 runner，不新增死代码（P3 重点）

- `QualityRepairStageRunner.run`（`server/src/services/novel/production/QualityRepairStageRunner.ts` L62-97）当前只有 `replan_novel` / `repair_chapter_stream` 两种 payload。方案 C **复用**这条编排入口，扩展 payload `mode` 值（`patch_repair` / `rewrite_chapter`），而不是在失败处理器里新写一套 re-enter 逻辑。
- 失败处理器在预算决策为 `auto_patch` / `auto_rewrite` 时：把修复意图传给 `novelProductionOrchestrator.runStage` 的 `quality_repair` 阶段（传扩展后的 payload），由 runner 执行并返回 `nextStage: "chapter_execution"` 续流；流程与 replan 分支既有路径（`resolveAutoExecutionRuntimeRangeAndState` + `syncAutoExecutionTaskState` resume）对齐。
- **实现口径：复用、复用、复用。本方案不产生新 stage 死代码。**

#### D. 结构化反馈替代字符串流（反馈穿透）

- 终态阶段：新增结构化 issue 载体，`isContractReplanWindowFailure`（字符串匹配）保留为向后兼容网关，不强行拆旧。
- 失败构造 error 时带 `issueIds`/`recommendedHandling`；director 直接读结构化 issue 而非解析字符串。

### 2.3 checkpoint / resume 衔接（预算定义）

- 预算存于 `autoExecution.qualityLoopLedger`，随 `buildDirectorSeedPayload` 的 seed 一起 checkpoint（`novelDirectorAutoExecutionCheckpointRuntime.ts` L108-112 把 `autoExecution` 传进 seed）。resume 用 `resolveAutoExecutionRuntimeRangeAndState` 读回。**持久化已成立**。
- 需强：保证"预算 → action → checkpointType"一致：patch/rewrite 耗尽→尝试更高 tier；replan 耗尽→停 `replan_required`。不把「预算耗尽」与「单次生成失败」混淆。

---

## 3. 数据流与状态机

```
[pipeline:generateChapterExecutionContract]
   ├─ attempt 1..maxLocalRetry(RepairOptions.*)      ← 本地重试，数与 director 预算无关
   │     ├─ pass → 写账 → 继续
   │     └─ gate fail → qualityFeedback 追加 → 下 attempt
   ├─ 仍 fail
   ▼ 抛结构化 error（带 issueIds + recommendedHandling）
[pipeline failed → recoverPipelineJob 结算 failed]
   ▼
[director: handleAutoExecutionFailure]
   ├─ 读 共享账本（qualityLoopBudget.ts）
   ├─ resolveDirectorQualityLoopBudgetNextAction
   │    ├─ auto_patch_repair    → 复用 quality_repair stage（patch_repair payload）
   │    ├─ auto_rewrite_chapter → 复用 quality_repair stage（rewrite_chapter payload）
   │    ├─ auto_replan_window   → 复用 quality_repair stage（replan_novel payload）
   │    └─ defer_and_continue   → stopAndPause（终态停等 replan_required）
   └─ 每次 action + notify → checkpoint（seed 含 qualityLoopLedger）→ resume 续跑
```

---

## 4. 实施清单（分阶段）

**Phase 1 — 无死代码 + 方向上提（必须先做，低风险）**
1. 新建 `qualityLoopBudget.ts`，迁移账本纯函数；`DirectorQualityLoopBudgetLedgerService.ts` 改为 re-export 兼容（不破坏现有 import）。
2. volume 里 `for attempt<3` 改用修复质量重试配置上限，**不与导演预算共享计数器**。
3. `AutoExecutionFailureHandler.ts` L238-245 把 `plannedBudgetAction` 真正分叉成 patch / rewrite 两档，不再归一。

**Phase 2 — patch/rewrite 进管线可执行**
4. 扩展 `QualityRepairStageRunner`：新增 `patch_repair` / `rewrite_chapter` payload（复用既有编排入口）。
5. 成功后走 `resolveAutoExecutionRuntimeRangeAndState` + `syncAutoExecutionTaskState` → resume；失败记账 → 升级更高 tier。

**Phase 3 — 结构化 issue 流**
6. 失败 entity 携带结构化 `issueIds`/`recommendedHandling`；`isContractReplanWindowFailure` 保留为兼容网关。
7. 反馈流统一 `rawEventBus` 记录点 / `qualityLoopBudget` 单一账本。

---

## 5. 非目标（明确不做）

- 不动线上数据/DB；pxed 本地脚本仅兜底（遵守部署约束：只在本机 repo 跑 `node --test`，pxed 上永不运行 build/tsc/prisma）。
- 不改变 `defer_and_continue` 的保守语义（它是预算用尽+需人工的判断）。
- 不做"自动跳过失败章节"（那是策略变更，不是修复通道下沉）。

---

## 6. 验证计划（本地 dev repo，已核对真实存在）

```bash
cd /Users/mango/project/claude-project/AI-Novel-Writing-Assistant
node --test server/tests/autoExecutionFailureHandler.test.js
node --test server/tests/contractReplanWindowHandler.test.js
node --test server/tests/contractReplanWindowSelfHealing.test.js
node --test server/tests/directorQualityLoopBudgetLedger.test.js
node --test server/tests/chapterTaskSheetQualityGate.test.js
node --test server/tests/volumeSyncPlan.test.js
```

新增测试目标（Phase 1 提交即测）：
1. 本地重试上限来自修复质量重试配置，而非导演预算（`directorQualityLoopBudgetLedger.test.js` 扩展）。
2. `qualityLoopBudget.ts` 上提后，volume import 它（不再反向 import director），模块加载无循环。
3. 预算决策 `auto_rewrite_chapter` 时失败处理器 re-enter 管线并 `recordBudget`，而非 `markTaskFailed`（`autoExecutionFailureHandler.test.js` 扩展）。
4. checkpoint/resume 后 `qualityLoopLedger` 仍可读回（预算 count 连续）。

> 说明：仅依赖上列**真实存在**的测试文件；不引用未在此仓库创建的测试名。

---

## 7. 结语

方案 C 的本质是把"修复"从导演的事后修补下沉为管线 stage 的一等公民：预算账本成为**共享纯函数层**（volume 与 director 都 import，无循环依赖），patch/rewrite/replan 成为可复用 orchestrator 动作，反馈流改为结构化 issue。这符合"想做好 novel 项目本身" —— 管线具备长期自愈能力，不再依赖失败处理器事后打补丁。

## 自我 review 记录

- **P1（必须）**：账本原放 director/runtime 若被 volume 调用会循环依赖 → 上提 shared `qualityLoopBudget.ts`。
- **P2（必须）**：本地重试 `for attempt<3` 与 director 预算 `patchRepair` 语义不同域，不得合并计数。
- **P3（应该）**：patch/rewrite 复用 `QualityRepairStageRunner`（orchestrator 入口），不新增死代码。
- **P4（nits）**：文档标点、错词、章节编号已订正。