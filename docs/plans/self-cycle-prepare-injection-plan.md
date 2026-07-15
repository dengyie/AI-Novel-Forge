# 自循环 prepare 注入闭环 — 开发文档

> **文档类型**：可执行开发计划（完备实现契约）  
> **状态**：进开发 · 2026-07-16  
> **关联**：
> - [导演自循环管线](./director-self-cycle-pipeline-plan.md)（权威目标架构）
> - 生产 review 发现 F1：`canPrepareNextBatch: false` + 未注入 `prepareNextAutoExecutionBatch`
> **域归属**：**成文自循环 / 执行合同准备**（非角色卡音色、非 voice-preview）  
> **生产**：pxed · 本 milestone **不**自动恢复卷二写书

---

## 0. 执行契约（冻结）

```text
Milestone：自循环 prepare 注入闭环（F1）
目标：窗尽 reenter 时真跑 outline 细化 + chapter_sync，返回新 range/state 并继续 loop；监管只 poll/approve/forceResume
P0/P1 范围：
  P0-1 实现 prepareNextAutoExecutionBatch（surgical detail+sync，不跑完整 outline phase 的 batch_ready 暂停副作用）
  P0-2 扩展 prepare 入参传入 request；runtime 调用点透传
  P0-3 NovelDirectorService：canPrepareNextBatch=true + 注入 prepare
  P1-1 单测：decision reenter + prepare 注入路径；缺 prepare 仍 halt
  P1-2 production-code-quality-review + 原子 commit
不做的 P2/P3：
  - 角色卡音色 / character voice-preview 任何改动
  - 卷二 41–80 生产写书恢复
  - F3 失败码结构化大改、F4 strip 表驱动重构
  - 前端 takeover UI
  - 盲目调用 runDirectorStructuredOutlinePhase（会 recordCheckpoint chapter_batch_ready 并暂停）
Manual-required：
  - pxed 发版部署
  - 发版后 continue + forceResume 观测续窗（不在本 milestone 内执行）
阶段上限：3
阶段拆分：
  1 完备文档 + 类型/端口扩展（request）
  2 prepare 实现 + composition root 接线
  3 测试 + 审查 + 提交
验收标准：
  - reenter + canPrepare true → kind 保持 reenter_structured_outline（非 halt）
  - prepare 注入后：下一窗 detail 齐 → 返回 expanded range + autoExecution（pipeline 清零）
  - 未注入 prepare → 现有 halt 行为保持
  - 相关单测绿；typecheck 不回归本改动面
  - 审查无 P0/P1 阻断
停止条件：P0 闭环 + 测试绿 + 交付总结；不自动开下一 milestone；不自动恢复生产写书
```

---

## 1. Context / 根因

### 1.1 已落地 vs 缺口

| 能力 | 状态 |
|---|---|
| `resolveNextAutoExecutionBatchRoll` 纯决策 | ✅ |
| `expand_range` runtime 应用 | ✅ |
| `tryBatchRollOnRangeExhausted` reenter 分支 | ✅ 有 port 即调用 |
| `PrepareNextAutoExecutionBatchInput/Result` 类型 | ✅ 仅类型 |
| **prepare 函数体** | ❌ 缺失 |
| **Service 注入 prepare** | ❌ 注释明确 Phase 1 expand-only |
| **`canPrepareNextBatch`** | ❌ 写死 `false` → reenter 被决策层改写为 halt |
| prepare 入参 **request** | ❌ 类型无；runtime 未传（provider/model/runMode 不可达） |

### 1.2 失败路径（生产）

```text
窗尽 remaining=0
  → resolveBatchRoll：下一窗 unprepared + canPrepareNextBatch=false
  → halt_for_review（原因：未注入 prepare）
  → markTaskFailed + 停止
监管被迫：手推 outline / 手改 seed / 人工开下一批
```

### 1.3 目标路径

```text
窗尽
  → unprepared 且 canPrepare=true
  → reenter_structured_outline
  → prepareNext(request, nextRange)：
       recovery cursor（plan=chapter_range 下一窗）
       beat_sheet / chapter_list（若缺）
       chapter_detail_bundle × N（reuse 语义：cursor 跳过已 canEnterExecution）
       chapter_sync（executionContractChapterRange=nextRange）
       resetDownstream + listChapters
       applyExpandRangeBatchRoll
  → syncAutoExecutionTaskState
  → continue autoExecutionLoop
```

### 1.4 为何不直接 `runDirectorStructuredOutlinePhase`

完整 phase 会：

1. `bootstrapTask` / seed 重写  
2. 结束 `recordCheckpoint(chapter_batch_ready)` → **暂停**等待审批  
3. 返回 `void`，不返回 range/state  

批续窗需要 **无暂停** 的 surgical prepare，由 runtime 在 prepare 返回后 **continue loop**。

---

## 2. 分层与模块边界

```text
shared/types/*                              不改（合同 strip 已在前里程碑）
automation/novelDirectorAutoExecutionBatchRollRuntime.ts
  - 纯决策 / expand / Prepare* 类型（扩展 request）
automation/novelDirectorAutoExecutionBatchPrepare.ts   【新建】
  - prepareNextAutoExecutionBatch(deps, input) 编排
  - 只依赖 volume / context / dynamics / 可选 progress
automation/novelDirectorAutoExecutionRuntime.ts
  - tryBatchRoll：prepare 调用透传 request
automation/novelDirectorAutoExecutionRuntimePorts.ts
  - 类型随 Input 扩展自动对齐
NovelDirectorService.ts
  - composition root：canPrepare=true + inject prepare
phases/novelDirectorStructuredOutlinePhase.ts
  - 不改主流程；可后续抽公共 helper（本阶段复制最小必要逻辑，避免大 refactor）
recovery/novelDirectorStructuredOutlineRecovery.ts
  - 复用 resolveStructuredOutlineRecoveryCursor / hasPrepared*（不改语义）
```

### 职责切分

| 层 | 职责 | 禁止 |
|---|---|---|
| BatchRoll pure | 决策 expand/reenter/halt/complete | IO、LLM |
| BatchPrepare | 下一窗 detail+sync + 返回 range/state | 写 workflow_completed / chapter_batch_ready |
| Runtime | 调度、失败 halt、continue loop | 内联 LLM 生成细节 |
| Service | 装配 deps、开关 | 业务算法 |

---

## 3. 接口契约

### 3.1 类型扩展

```ts
// novelDirectorAutoExecutionBatchRollRuntime.ts
export type PrepareNextAutoExecutionBatchInput = {
  novelId: string;
  taskId: string;
  decision: BatchRollDecision;
  previousState: DirectorAutoExecutionState;
  previousRange: DirectorAutoExecutionRange;
  /** 批续窗 prepare 需要 provider/model/runMode；runtime 必传 */
  request: DirectorConfirmRequest;
};
```

### 3.2 prepare 签名

```ts
export type PrepareNextAutoExecutionBatchDeps = {
  volumeService: Pick<
    NovelVolumeService,
    "getVolumes" | "generateVolumes" | "updateVolumesWithOptions" | "syncVolumeChaptersWithOptions"
  >;
  novelContextService: {
    listChapters: (novelId: string) => Promise<DirectorAutoExecutionChapterRef[]>;
  };
  characterDynamicsService?: {
    rebuildDynamics: (novelId: string, options?: { sourceType?: string }) => Promise<unknown>;
  };
  /** 可选进度；失败不阻断 prepare */
  onProgress?: (label: string, progress: number) => Promise<void>;
};

export async function prepareNextAutoExecutionBatch(
  deps: PrepareNextAutoExecutionBatchDeps,
  input: PrepareNextAutoExecutionBatchInput,
): Promise<PrepareNextAutoExecutionBatchResult>;
```

### 3.3 Runtime 调用

```ts
const prepared = await this.deps.prepareNextAutoExecutionBatch({
  novelId, taskId, decision, previousState, previousRange,
  request: input.request,
});
```

### 3.4 Service 装配

```ts
enableBatchRoll: true,
resolveBatchRoll: async (...) => resolveNextAutoExecutionBatchRoll({
  ...,
  canPrepareNextBatch: true,  // 与 prepare 注入同开
}),
prepareNextAutoExecutionBatch: (input) => prepareNextAutoExecutionBatch({
  volumeService: this.volumeService,
  novelContextService: this.novelContextService,
  characterDynamicsService: this.characterDynamicsService,
  onProgress: async (label, progress) => {
    await this.workflowService.markTaskRunning(input.taskId, {
      stage: "chapter_execution",
      itemKey: "batch_roll_prepare",
      itemLabel: label,
      progress,
    }).catch(() => undefined);
  },
}, input),
```

> 注意：`onProgress` 闭包内的 `input.taskId` 来自 prepare 入参；装配时用 prepare 回调参数，**不要**在构造期捕获错误 taskId。

正确写法：

```ts
prepareNextAutoExecutionBatch: (input) => prepareNextAutoExecutionBatch(
  {
    volumeService: this.volumeService,
    novelContextService: this.novelContextService,
    characterDynamicsService: this.characterDynamicsService,
    onProgress: async (label, progress) => {
      await this.workflowService.markTaskRunning(input.taskId, {
        stage: "chapter_execution",
        itemKey: "batch_roll_prepare",
        itemLabel: label,
        progress,
      }).catch(() => undefined);
    },
  },
  input,
),
```

---

## 4. 算法（prepareNextAutoExecutionBatch）

### 4.1 前置校验

1. `decision.kind === "reenter_structured_outline"` 且 `decision.nextRange` 存在，否则 throw 明文。  
2. `request` 必须存在（runtime 保证）；缺则 throw。  
3. `getVolumes(novelId)` → workspace；无 volumes → throw。

### 4.2 Plan 构造

```ts
const nextRange = decision.nextRange;
const plan = normalizeDirectorAutoExecutionPlan({
  mode: "chapter_range",
  startOrder: nextRange.startOrder,
  endOrder: nextRange.endOrder,
  autoReview: previousState.autoReview ?? true,
  autoRepair: previousState.autoRepair ?? true,
  artifactSyncMode: previousState.artifactSyncMode,
});
```

### 4.3 full_book_autopilot（JIT）

若 `isFullBookAutopilotRunMode(request.runMode)`：

- **不**预生成 task_sheet（与 outline phase 一致）  
- 若 workspace 在 nextRange 内有标题行：直接 `listChapters` + `applyExpandRangeBatchRoll` 返回  
- 若下一窗连标题都没有：throw 明文「懒规划模式仍缺章节标题骨架，无法批续」

### 4.4 标准路径：recovery cursor 循环

复用 `resolveStructuredOutlineRecoveryCursor({ workspace, plan })`：

| step | 动作 |
|---|---|
| `beat_sheet` | `generateVolumes(scope:beat_sheet)` + updateVolumes 快照 |
| `chapter_list` | `generateVolumes(scope:chapter_list)` + 快照 |
| `chapter_detail_bundle` | `generateVolumes(scope:chapter_detail, detailMode, chapterTaskSheetQualityMode)` + update + 单章 `syncVolumeChaptersWithOptions(executionContractChapterRange=该章)` |
| `chapter_sync` / `completed` | break |

防死循环：`cursorKey` 与上一轮相同 → throw（同 outline phase）。

`chapterTaskSheetQualityMode`：

- full_book_autopilot → `"full_book_autopilot"`（本分支在 4.3 已提前返回）  
- 其它 → `"ai_copilot"`

进度：`onProgress?.("批续窗：细化第 n/m 章", …)` 最佳努力。

### 4.5 收尾 sync（整窗）

1. `updateVolumesWithOptions`（contract refined）  
2. `syncVolumeChaptersWithOptions`：`preserveContent:true`, `applyDeletes:false`, `executionContractChapterRange: nextRange`  
3. `characterDynamicsService.rebuildDynamics`（catch warn，不阻断）  
4. 校验 selected chapters 覆盖 nextRange 内订单（缺章 throw）  
5. `resetDirectorDownstreamChapterState(novelId, nextRange)`  
6. `listChapters`  
7. 非 autopilot：抽检 `canEnterExecution` / 合同形状；关键章仍不可执行 → throw 明文  
8. `applyExpandRangeBatchRoll({ previousState, nextRange, chapters })`  
9. **禁止** `recordCheckpoint(chapter_batch_ready)` / `workflow_completed`

### 4.6 保留跨窗债务

`applyExpandRangeBatchRoll` 已 spread `previousState` 进 plan（skipped / quality 字段随 state builder 保留）。若 builder 丢字段，prepare 返回前二次 merge：

```ts
autoExecution = {
  ...expanded.autoExecution,
  skippedChapterIds: previousState.skippedChapterIds,
  // 其它 quality debt 字段按 buildDirectorAutoExecutionState 实际保留情况补 merge
};
```

以 `buildDirectorAutoExecutionState` / `applyExpandRangeBatchRoll` 现实现为准，测试锁定。

---

## 5. 改动清单

| 动作 | 路径 |
|---|---|
| 改 | `automation/novelDirectorAutoExecutionBatchRollRuntime.ts` — Input 加 `request` |
| **新建** | `automation/novelDirectorAutoExecutionBatchPrepare.ts` |
| 改 | `automation/novelDirectorAutoExecutionRuntime.ts` — prepare 透传 `request` |
| 改 | `NovelDirectorService.ts` — `canPrepareNextBatch:true` + inject prepare |
| 扩测 | `tests/novelDirectorAutoExecutionBatchRollRuntime.test.js`（若纯类型） |
| **新建/扩** | `tests/novelDirectorAutoExecutionBatchPrepare.test.js` |
| 扩 | `tests/novelDirectorAutoExecutionRuntime.batchRoll.test.js` — reenter+prepare mock |
| 文档 | 本文；可选在 director-self-cycle-pipeline-plan.md 加「prepare 已注入」状态行 |

---

## 6. 测试计划

### 6.1 Unit — prepare

1. **happy path（mock volumeService）**：unprepared 2 章 → cursor 走 detail → sync → 返回 range=nextWindow  
2. **decision 非法**：expand_range 调 prepare → throw  
3. **cursor 不推进**：mock generate 不改 workspace → throw 防死循环  
4. **autopilot**：不调用 chapter_detail generate；直接 expand  
5. **缺 request**：throw  

### 6.2 Runtime — batch roll

1. reenter + prepare mock 返回新 range → continue 结果含新 range；sync 被调  
2. reenter 无 prepare → halt 语义（现有）  
3. expand 不调用 prepare（现有）

### 6.3 Service 接线（轻量）

可选：构造时检查 deps 形状困难（私有字段）；以 runtime 注入测试 + 源码/注释断言为准。  
集成：不强制起 DB LLM。

### 6.4 回归

```bash
pnpm --filter @ai-novel/server test -- novelDirectorAutoExecutionBatchPrepare
pnpm --filter @ai-novel/server test -- novelDirectorAutoExecutionRuntime.batchRoll
pnpm --filter @ai-novel/server test -- novelDirectorAutoExecutionBatchRollRuntime
pnpm --filter @ai-novel/server test -- selfCycleAcceptance
```

---

## 7. 风险与缓解

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | prepare 中 LLM 失败半窗 | 抛错让 runtime 进 failed；不写假 completed；cursor 可 resume |
| R2 | 与完整 outline phase 逻辑漂移 | 注释交叉引用；关键路径只复制最小集合；后续可抽 shared helper（P2） |
| R3 | markTaskRunning stage 类型窄 | 用 chapter_execution + itemKey batch_roll_prepare；catch 忽略 |
| R4 | autopilot 误预生成 | 4.3 早退 |
| R5 | 死循环 cursor | cursorKey 检测 |
| R6 | 声纹/音色误改 | 本 milestone 文件白名单不含 audiobook/* |
| R7 | 生产未发版 | Manual-required；本会话不 resume 写书 |

---

## 8. 审查门禁（每阶段）

按 `production-code-quality-review`：

- 正确性：reenter 必走 prepare；缺 prepare 不静默 expand  
- 稳健：cursor 死循环、缺章、LLM 失败  
- 架构：prepare 不在 runtime 内联；不在 Service 堆算法  
- 测试：失败路径覆盖  
- 安全：无新外网/密钥面  

阻断 P0/P1 最多修 3 轮。

---

## 9. Commit 约定

```text
docs(phase-1): self-cycle prepare injection plan
feat(phase-2): prepareNextAutoExecutionBatch + service wire
test(phase-3): batch prepare + reenter runtime coverage
```

可合并为 1–2 个原子提交，若文档与实现同会话且测试齐。

---

## 10. 验收勾选

- [ ] 文档落盘（本文）  
- [ ] Input 含 request；runtime 透传  
- [ ] prepare 实现 + 单测  
- [ ] Service `canPrepareNextBatch: true` + inject  
- [ ] 未注入路径仍 halt  
- [ ] review 通过  
- [ ] commit  
- [ ] 《项目交付总结》  
- [ ] **未**触碰 voice-preview / 未自动恢复 vol2  

---

## 11. 术语澄清（职责边界）

用户表述「项目核心是声纹」在本仓库当前代码面 **无** `声纹`/`voiceprint` 模块；与「只关注成文质量」「角色卡音色非本代理职责」对齐后，本 milestone **声纹质量把控**解释为：

> **成文执行链路的高可用自循环与合同准备质量**（批续窗 prepare、不可假成功、分层清晰、可测、可恢复）

若后续单独开「声纹/音色」域，另立 milestone，不与 F1 混装。
