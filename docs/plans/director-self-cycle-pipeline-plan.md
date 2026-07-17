# 自动导演自循环管线：架构与开发文档

> **文档类型**：可执行开发计划  
> **状态**：已评审可开工（2026-07-14）  
> **关联**：
> - [Auto Director Execution Plane Isolation Plan](./auto-director-execution-plane-isolation-plan.md)
> - [Director Mode Module and State Refactor Checklist](./director-mode-module-state-refactor-checklist.md)
> - [Auto Director Runtime Wiki](../wiki/workflows/auto-director-runtime.md)
> - **[Review 后修复方案（完备）](./director-self-cycle-p0-review-fix.md)** — readiness `content:null` thrash、full_book 懒路径 canEnterExecution 等（设计定稿 · 待下令实现）
> - 域：`shared/types/chapterTaskSheetQuality.ts`；编排：`server/src/services/novel/director/automation/*`
> **生产背景**：《源世界》卷一 pxed 生产监管暴露批间停死、合同门禁、recovery 回卷等问题  
> **更新日期**：2026-07-17（关联修复文档；功能 P0 实现仍以 2026-07-14 里程碑为准）

---

## Context

### 问题

生产实测与代码勘察一致表明：当前自动导演是**半自动批处理**，不是**可无人值守自循环**。

监管本应只做：

1. `poll snapshot`  
2. `waiting_approval` → `approve_gate`  
3. 真 stuck / `failed` → `continue` / `forceResume`  

实际却要：手改 `seed.autoExecutionPlan`、清洗 taskSheet 内部 code、invalidate step、防 recovery 把 21–30 盖回 11–20。

### 根因（已核实）

| ID | 根因 | 关键代码 |
|---|---|---|
| **P0-1** | 批完成 → `workflow_completed` 终态返回；`chapter_range` 固定；`mode:book` 只覆盖已存在 chapter 行，不回 outline 补下一窗 | `novelDirectorAutoExecutionRuntime.ts` `autoExecutionLoop` + `recordCompletedCheckpoint`（约 L167–463） |
| **P0-2** | 合同门禁禁内部 code，写入路径只 `trim` 不 strip；layered context 把 payoff code 暴露给生成 LLM，鹦鹉进 taskSheet | `chapterTaskSheetQuality.ts`（`stripInternalQualityCodes` 已存在未接线）；`VolumeChapterSyncService.ts` L122/141 |
| **P0-3** | recovery / takeover 对 plan 与 `executableRange` 优先级使「已完成批 range」盖住「下一未准备窗」 | `novelDirectorTakeoverRuntime.ts` L494–552；`novelDirectorRecovery.ts` |
| **P1** | 空 `model` 绕过 task 路由；`forceResume` 不清理 ghost/idempotency；短章可 defer 静默 approved | `factory`/`modelRouter`；`DirectorNodeRunner`；quality defer 路径 |

### 目标结果

一卷（如 40 章）在 outline 标题就绪后，单次 autopilot 可自动：

`细化窗 → sync → 逐章写/审 → 窗尽续下一窗 → … → 卷末 workflow_completed`

监管交互 ≤ 2 次（真质量门），**禁止**手改 seed / 手洗合同 / 手推批次。

### 非目标

- 不重写整个 director 调度器  
- 不改 LLM provider 适配层（除空 model 语义）  
- 不新增 DB 表（用 checkpoint / seed / ledger）  
- 不在本里程碑做前端大改（只读提示可后置）  
- 不把「跳过质量」当自循环手段（禁止 `skip_quality_repair` 策略化）

---

## Target architecture

### 分层

```text
shared/types/*                    纯域：合同清洗、range/window 纯函数、BatchRollDecision 类型
director/automation/*             自执行循环 + ports + BatchRollRuntime（新）
director/recovery/*               未准备窗、asset-first recovery 决策
director/runtime/*                continue / takeover / node runner（恢复优先级修正）
volume/*                          写入 strip + 门禁前 auto-repair
prompting + chapterLayeredContext writer-facing 上下文 hygiene
```

### 新模块（核心）

**`server/src/services/novel/director/automation/novelDirectorAutoExecutionBatchRollRuntime.ts`**

| 导出 | 职责 |
|---|---|
| `resolveNextAutoExecutionBatchRoll(input)` | **纯**：窗尽时决策 `completed_scope` \| `expand_range` \| `reenter_structured_outline` \| `halt_for_review` |
| `prepareNextAutoExecutionBatch(deps, input)` | **编排**：对 reenter 调 outline 细化 + chapter_sync，返回新 `range` + `autoExecution` |

**`resolveNextUnpreparedWindow`**（放 `novelDirectorStructuredOutlineRecovery.ts` 或 batch-roll 同文件纯函数）  
给定 workspace + 已完成 orders → 下一连续未准备/未同步窗。

### Port 扩展（`novelDirectorAutoExecutionRuntimePorts.ts`）

可选注入（缺省 = 旧行为，灰度安全）：

- `prepareNextAutoExecutionBatch?`
- `runStructuredOutlinePhase?`（或复用现有 pipeline/orchestrator 能力）
- `syncVolumeChapterExecutionContract?`
- 已有 `volumeWorkspaceService` 复用

### 配置开关

`enableBatchRoll`（建议挂 AutoDirector settings，默认 true，可关回退）。

### 目标数据流

```text
autoExecutionLoop
  per-chapter pipeline job (已有 resolveSingleChapterExecutionRange)
  job.succeeded && remainingChapterCount === 0
    → resolveNextAutoExecutionBatchRoll(...)
        completed_scope
          → recordCompletedCheckpoint(workflow_completed); return
        expand_range
          → 更新 range/autoExecution（清 pipelineJobId）；continue autoExecutionLoop
        reenter_structured_outline
          → prepareNextAutoExecutionBatch(...)
          → outline detail + sync（写入路径已 strip）
          → resolveAutoExecutionRuntimeRangeAndState
          → continue autoExecutionLoop
        halt_for_review
          → checkpoint / failed 语义清晰，supervision 处理

防死循环：MAX_CONSECUTIVE_BATCH_ROLLS（建议 8）
```

### 恢复优先级（目标态）

```text
1. 显式 re-scope 请求（带明确 chapter_range 改窗意图）
2. state 窗内仍有 pending → 保持 state range（真 resume）
3. state 窗已完成 且 存在 nextUnpreparedWindow
     → executableRange=null + hasUnpreparedChaptersInRange=true
     → recovery → structured_outline（续窗），禁止回已完成 11–20 重跑
4. 真无下一窗 → workflow_completed / cursor completed
```

纯 continue **不得**用「请求里空 plan / 旧 executableRange」盖掉下一窗。

### 合同路径（目标态）

```text
生成 LLM
  → 写入 VolumeChapterSyncService / plannerPersistence / novelCoreCrud
       sanitizeChapterTaskSheetForPersistence = stripInternalQualityCodes + 空行收敛
  → assertSyncableChapterExecutionContracts
       仅 internal_codes 时 tryAutoRepair 再评估一次
  → writer-facing layered context 用 sanitizeWriterFacingTaskSheet
```

**生成侧**仍保留 prompt 禁令 + 后续可做 payoff context 脱敏（P1 增强，非本 M1 阻塞）。

---

## Milestone 与阶段（最多 5）

### Milestone：导演自循环 P0（监管只重启）

**阶段上限：5**（M1 三阶段 + M2 一阶段 + M3 验收）

| 阶段 | 对应 | 可验证结果 |
|---|---|---|
| **1** | P0-1 批续窗 | remaining=0 时 expand/reenter 而非一律 workflow_completed |
| **2** | P0-2 合同对齐 | 写入无 internal code；门禁不再因 parrot code 硬死 |
| **3** | P0-3 recovery | 11–20 完成后 continue 进 21–30 outline，不回卷 |
| **4** | P1 清坑 | 空 model / forceResume ghost / 短章静默 approve |
| **5** | 验收 | selfCycleAcceptance + 回归绿；文档落盘 docs/plans |

**本轮实现顺序建议**：1 → 2 → 3 作为可交付闭环；4/5 可同 milestone 收尾。  
**不做的 P2/P3**：前端 takeover 大改、全量历史 taskSheet migration UI、执行面进程隔离（已有独立 plan）。

---

## 阶段 1 — 批续窗 Runtime

### 改动清单

| 动作 | 路径 |
|---|---|
| 新建 | `server/src/services/novel/director/automation/novelDirectorAutoExecutionBatchRollRuntime.ts` |
| 改 | `novelDirectorAutoExecutionRuntimePorts.ts` |
| 改 | `novelDirectorAutoExecutionRuntime.ts`（`recordCompletedCheckpoint` 前 4 处：约 L178/260/440/453） |
| 改 | `recovery/novelDirectorStructuredOutlineRecovery.ts`（`resolveNextUnpreparedWindow`） |
| 可选 | shared 类型：`BatchRollDecision` 若需跨包可放 `shared/types/novelDirector.ts` 或 automation 本地 type |
| 测 | `server/tests/novelDirectorAutoExecutionBatchRollRuntime.test.js` |
| 扩 | `novelDirectorAutoExecutionRuntime.test.js` mock deps |

### 算法要点

1. 仅在 **job 成功且 remaining=0**（及无 job 且 remaining=0）分支介入。  
2. `enableBatchRoll===false` 或 port 未注入 → 旧行为 `recordCompletedCheckpoint`。  
3. `expand_range`：下一窗已在 workspace 有完整 detail，只差进执行区 → 扩 range，continue loop。  
4. `reenter_structured_outline`：缺 detail → prepareNext… → detail_bundle + sync → continue。  
5. `halt_for_review`：缺 beat_sheet/chapter_list 等超出本章循环 → 清晰 checkpoint，不静默假成功。  
6. `MAX_CONSECUTIVE_BATCH_ROLLS`；超限 `markTaskFailed` + summary 写明原因。  
7. 续窗保留 `skippedChapterIds` / quality debt（跨窗语义）；清 `pipelineJobId`。

### 依赖装配

在构造 `NovelDirectorAutoExecutionRuntime` 的 composition root（现有 DirectorService / orchestrator 装配处）注入默认 `prepareNextAutoExecutionBatch` 实现，内部复用：

- `resolveStructuredOutlineRecoveryCursor`
- 现有 structured outline step modules / `runStepModule`（`reuseCompletedStep: false`）
- `VolumeChapterSyncService.sync…`（阶段 2 后带 strip）

---

## 阶段 2 — 合同门禁与生成对齐

### 改动清单

| 动作 | 路径 |
|---|---|
| 改 | `shared/types/chapterTaskSheetQuality.ts`：`sanitizeChapterTaskSheetForPersistence` / `sanitizeWriterFacingTaskSheet`（封装 strip + 空 bullet 收敛） |
| 改 | `VolumeChapterSyncService.ts` L122/141 写入前 sanitize |
| 改 | `ChapterTaskSheetQualityGateService.ts`：`tryAutoRepairTaskSheetCodes`（仅 internal_codes） |
| 改 | `assertSyncable…` 调用链：throw 前 auto-repair 可选写回 |
| 改 | `plannerPersistence.ts`、`novelCoreCrudService.ts` 等 taskSheet 写入点（grep `taskSheet:` 全覆盖） |
| 改 | `chapterLayeredContext.ts` writer-facing 块 sanitize |
| 测 | `chapterTaskSheetQualityStrip.test.js`；扩 volume sync / contract boundary |

### 原则

- **防御纵深**：写入 strip 为主；门禁 auto-repair 兜底；prompt 禁令保留。  
- **不**让 `assessChapterExecutionContractShape` 变成可变副作用函数；repair 在 service 层。  
- payoff context 脱敏（`chapterLayeredContext` 渲染 ledger 时不吐 raw code）作 **P1 增强**，M1 以 strip 保证可进执行。

### 义务过载（`task_sheet_type_overload`）

本阶段：**不**自动砍义务条（避免改剧情合同语义）。  
仅修 internal codes。过载仍 `repairable` 时：后续可加「生成后 LLM rewrite 收束」独立任务；生产可先靠 outline 重试 / 人工，**不**在本阶段用假数据砍 bullet。

---

## 阶段 3 — Recovery / range 不回卷

### 改动清单

| 动作 | 路径 |
|---|---|
| 改 | `novelDirectorTakeoverRuntime.ts` `loadDirectorTakeoverState` executableRange 解析 |
| 改 | `novelDirectorRecovery.ts` `resolveAssetFirstRecoveryFromSnapshot` |
| 改 | 相关 snapshot 字段 `hasUnpreparedChaptersInRange` 计算 |
| 纯函数 | `stateHasPendingInStateRange`、`isExplicitRescopeRequest`（命名可调整） |
| 测 | `novelDirectorTakeoverRuntimeRangePrecedence.test.js`；扩 `novelDirectorRecovery.test.js` |

### 算法（与 §Target 一致）

- **resume**：state 窗内有 pending → 用 state。  
- **roll**：state 窗完成 + nextUnprepared → 不 `buildPreparedRangeFromState`，走 outline / 新窗。  
- **re-scope**：请求显式带新 `chapter_range` 且意图标记（或与 seed 不同且 `continuationMode`/payload 约定）才覆盖。  
- 禁止：seed 已 21–30、state 11–20 completed，continue 仍 executableRange=11–20。

### 与阶段 1 关系

阶段 1 解决「循环内不退出」；阶段 3 解决「循环外 continue 也能进下一窗」。两者都要，缺一则监管仍要手推。

---

## 阶段 4 — P1 清坑

| 项 | 改动方向 | 测试 |
|---|---|---|
| 空 model | `model:""` → 视为未显式，走 task route；或 validation 拒绝 silent flash | factory / autoDirectorValidation |
| forceResume ghost | forceResume ⇒ 执行关键节点 `reuseCompletedStep:false`；可选 clear succeeded step keys；真无工作时 ledger `force_resume_noop` | continue / node runner |
| 短章 | 字数 < target×0.6 且未 rewrite → 不可 skippable auto_continue；进 quality checkpoint | quality debt / autoExecution |

---

## 阶段 5 — 验收与文档

- 新建 `server/tests/selfCycleAcceptance.test.js`（mock LLM）：  
  - A 三窗连跑一次 runFromReady  
  - B 中途缺细化 reenter  
  - C taskSheet 含 code 写入后可 sync  
  - D continue 不回卷  
  - E P1 三项  
- 回归：现有 `novelDirectorAutoExecutionRuntime.test.js` 等 workflow_completed 断言「真完成」仍成立  
- 落盘：`docs/plans/director-self-cycle-pipeline-plan.md`（本文终稿）  
- 可选：`docs/wiki` 补「监管操作面」三命令说明  

---

## 在途生产兼容

| 场景 | 策略 |
|---|---|
| task 已在 11–20 `workflow_completed`，21–30 未准备 | 部署后一次 `continue(forceResume)` → 阶段 3 路径进 outline，**无需手改 seed** |
| DB 内历史脏 taskSheet | 门禁 `tryAutoRepair` 读时兜底；可选幂等脚本 `scripts/stripTaskSheetCodes`（Manual-required 运维） |
| port 未注入 / `enableBatchRoll=false` | 旧行为，灰度回退 |
| pxed 热修 dist | 实现经 main 发版后部署；本 plan 不替代热修流程 |

---

## 关键文件一览（实现时）

**新建**

- `server/src/services/novel/director/automation/novelDirectorAutoExecutionBatchRollRuntime.ts`  
- `server/tests/novelDirectorAutoExecutionBatchRollRuntime.test.js`  
- `server/tests/selfCycleAcceptance.test.js`（阶段 5）  
- `docs/plans/director-self-cycle-pipeline-plan.md`  

**核心修改**

- `.../automation/novelDirectorAutoExecutionRuntime.ts`  
- `.../automation/novelDirectorAutoExecutionRuntimePorts.ts`  
- `.../runtime/novelDirectorTakeoverRuntime.ts`  
- `.../recovery/novelDirectorRecovery.ts`  
- `.../recovery/novelDirectorStructuredOutlineRecovery.ts`  
- `.../volume/VolumeChapterSyncService.ts`  
- `.../volume/ChapterTaskSheetQualityGateService.ts`  
- `shared/types/chapterTaskSheetQuality.ts`  
- writer-facing：`chapterLayeredContext`（及 grep 到的其它 taskSheet 写入点）  

**复用勿重写**

- `stripInternalQualityCodes` / `assessChapterExecutionContractShape`  
- `resolveStructuredOutlineRecoveryCursor` / `buildDirectorAutoExecutionState`  
- `recordCompletedCheckpoint` / `syncAutoExecutionTaskState`  
- `resolveSingleChapterExecutionRange`（仍一章一 job）  

---

## 验收标准（Supervision-only restarts）

1. 卷 40 章、workspace 预细化三窗：单次 `runFromReady` → 终态 `workflow_completed`，无人工 advance。  
2. 中途缺细化：自动 reenter outline + sync + 续跑。  
3. continue/forceResume：不回已完成窗、不 ghost 假进度。  
4. taskSheet 含 `payoff_*` 等：写入后可进执行，不因 parrot code 卡死。  
5. 空 model / 短章 / forceResume noop：行为可测、可观测。  
6. 量化：一卷监管交互 ≤ 2（真质量门）；零手改 seed/合同/批次。  

---

## 风险与开放决策

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | 续窗死循环 | `MAX_CONSECUTIVE_BATCH_ROLLS` + failed 明文 |
| R2 | reenter outline 与 NodeRunner 幂等冲突 | 执行关键 `reuseCompletedStep:false`；idempotency key 含 range/window |
| R3 | strip 误伤自然语言 | 仅 taskSheet/writer-facing；测「推进要求保留」；`prose_*` 模式保持 code 形 |
| R4 | 用户故意重跑已完成窗 | 显式 re-scope 保留；纯 continue 不覆盖 |
| R5 | 义务过载未本阶段自动修 | 文档标明；避免静默删剧情义务 |
| R6 | 与 execution-plane 隔离 plan 交叉 | 本 plan 不把重活拉回 API 主路径；worker 内循环扩展 |

**开放决策（实现前可默认）**

1. **默认 scope**：`mode: volume`（整卷）+ batch-roll，还是保留 `chapter_range` 10 章窗由 roll 自动推进？  
   - **推荐默认**：生产 autopilot 用 **volume 或 book + enableBatchRoll**；`chapter_range` 仍支持但窗尽自动 roll 到下一未准备连续段（不必死 10）。  
2. **re-scope 标记**：新 payload 字段 `rescope: true` vs 启发式「plan 与 seed 不同即 re-scope」？  
   - **推荐**：显式 `rescope`/`autoExecutionPlanIntent: "replace"|"resume"`，启发式仅作兼容。  
3. **短章阈值 0.6**：是否可配置？默认 0.6，settings 可调。  

---

## 实现契约（进入 coding 后遵守）

```text
Milestone：导演自循环 P0（监管只重启）
目标：批续窗 + 合同 strip/repair + recovery 不回卷 + P1 清坑 + 验收
P0/P1：阶段 1–4
不做：前端大改、进程隔离重做、义务条自动剧情删减
Manual-required：pxed 发版部署；可选历史 taskSheet 清洗脚本
阶段上限：5
验收：§验收标准
停止：P0 闭环 + 测试绿 + 文档落盘后停止，不自动开下一 milestone
```

---

## Verification（实现期）

```bash
# 单元 / 集成（仓库根）
pnpm --filter @ai-novel/server test -- novelDirectorAutoExecutionBatchRollRuntime
pnpm --filter @ai-novel/server test -- novelDirectorAutoExecutionRuntime
pnpm --filter @ai-novel/server test -- novelDirectorTakeover
pnpm --filter @ai-novel/server test -- novelDirectorRecovery
pnpm --filter @ai-novel/server test -- chapterTaskSheetQuality
pnpm --filter @ai-novel/server test -- selfCycleAcceptance

# 类型
pnpm --filter @ai-novel/shared build && pnpm --filter @ai-novel/server typecheck
```

生产验证（发版后）：《源世界》task continue 一次，观察 21–30 进入 outline/execution 而非 11–20；合同门禁不再因 internal code 失败。

---

## 文档交付说明

- **权威路径**：本文件 `docs/plans/director-self-cycle-pipeline-plan.md`  
- **索引**：已列入 `docs/README.md` → `docs/plans`  
- **实现顺序**：阶段 1 → 2 → 3 为 P0 闭环；阶段 4/5 同 milestone 收尾；完成后停止，不自动开下一 milestone  
