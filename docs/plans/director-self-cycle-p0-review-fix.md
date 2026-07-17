# 导演自循环 P0 — Review 后修复方案（完备文档）

> **文档类型**：修复设计 + 可执行实现计划  
> **状态**：实现中 · 2026-07-17（用户下令：文档优化 + 代码落地）  
> **日期**：2026-07-17  
> **仓库**：`AI-Novel-Writing-Assistant`  
> **权威上游**：
> - 功能里程碑：[`director-self-cycle-pipeline-plan.md`](./director-self-cycle-pipeline-plan.md)
> - 生产级深度 Review（会话内 read-only，2026-07）：BatchRoll / strip / no-rewind / P1 / acceptance + 生文影响
>
> **For agentic workers：**  
> REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按 Task 执行。  
> 本轮范围冻结：Fix-1 merge + Fix-2 lazy gate + 死参清理 + 测绿；**禁止** resume pxed / 开下一 milestone。

**Goal:** 消除批续决策输入与执行表真相分裂（expand thrash），并给 full_book 懒批续补上与非懒路径同构的合同可执行门，辅以 strip 演进与死参清理。

**Architecture:** 纯函数抽「规划行 ⊕ 执行行」合并与「窗内 canEnterExecution 断言」；Service/BatchPrepare 只接线；Runtime 决策语义不动。Port 灰度与 `completed_scope` 真完成语义保持。

**Tech Stack:** TypeScript (server) · shared pure types · `node:test` · 现有 `assessChapterExecutionContractShape` / `isDirectorAutoExecutionChapterProcessed`

## Global Constraints

- **禁止** `skip_quality_repair` 策略化；禁止盲批 / 代写 PUT 当 rewrite worker  
- **禁止** 本修复 milestone 自动恢复 pxed 写书、自动开下一功能 milestone  
- **禁止** 在 argv / 仓库 / vault 拼 Bearer；生产 curl 仅 `-H @.curl_auth_header`  
- **禁止** planHints / 文案拼写「称重」  
- 生产主机仅 **Bohrium pxed + `ainovel.mangoq.ccwu.cc`**（Manual-required 部署）  
- 不重写整个 auto-execution 调度器；不新增 DB 表；不自动砍 overload 义务条  
- 不把全部 review-block 改成 non-skippable（产品语义另案）  
- residual 57/71/74 无单独订单不 rewrite  

---

## 0. 执行契约（实现时冻结）

```text
Milestone：自循环 Review-fix（修缺陷小闭环，非新功能里程碑）
目标：修 P1 readiness 合并 + full_book 懒路径 canEnterExecution 门 + 高价值回归测 + 文档同步
P0：readiness content/exec 合并正确，消灭假 isProcessed → expand thrash
P1：full_book 懒 prepare 与非懒 hard gate 同构；thrash / lazy-gate 测绿
P2：strip 名单演进测；supervisoryCloseable 死参清理（可同提交）
不做的 P2/P3：skippable 全收紧、overload LLM 收束、前端 takeover、历史 migration UI、生产 resume
Manual-required：发版 pxed；continue/forceResume；residual rewrite
阶段上限：2
阶段拆分：
  1) Fix-1 merge 纯函数 + Service 接线 + thrash 测
  2) Fix-2 lazy gate 共享 assert + 测 + strip/死参/文档链
验收标准：§8
停止条件：测绿 + 本文档与 pipeline plan 链接一致 + 阶段审查通过 + 总结停止；不 resume 生产
```

---

## 1. 背景：自循环 P0 已交付什么、Review 又发现什么

### 1.1 已交付（保持，勿 regress）

| 能力 | 位置（要点） |
|---|---|
| 窗尽 BatchRoll 决策 | `novelDirectorAutoExecutionBatchRollRuntime.ts`：`expand_range` / `reenter_structured_outline` / `completed_scope` / `halt_for_review` |
| 连续批续上限 | `DEFAULT_MAX_CONSECUTIVE_BATCH_ROLLS = 8`；Runtime 局部计数 |
| 合同 strip 写入 + 门禁 | `shared/types/chapterTaskSheetQuality.ts`；Volume sync / crud / planner / contract |
| Recovery 不回卷 | `novelDirectorTakeoverRuntime.ts`：显式 rescope → pending → 下一窗 → completed |
| 空 model / forceResume / 短章 hard | orchestrator + `LENGTH_HARD_UNDER_RATIO=0.6` + `NON_SKIPPABLE_LENGTH_MARKERS` |
| QFP avoidRetry → heavy rewrite | `ChapterRepairStreamRuntime` + `qualityFeedback` projection-only |
| 验收纯测 | `server/tests/selfCycleAcceptance.test.js` |

### 1.2 Review 结论（摘要）

架构方向正确（port 注入、纯决策、strip 纵深、content-first processed、禁止 skip_quality）。  
**最高真实缺陷**是装配层：workspace enrich **写死 `content: null`**，与 `isDirectorAutoExecutionChapterProcessed` 的 content 硬前提冲突 → 已写窗仍被当未处理 → expand thrash → 顶 8 次 halt。  
次高：`full_book_autopilot` 懒 prepare **只校验标题**就 expand，跳过非懒路径已有的 `canEnterExecution` hard gate（~L496–545），弱合同进写。  
其余为名单维护、产品语义记录、死参。

**审查推荐（实现前）**：有条件通过；修 readiness + 懒路径 gate 后再信任生产自循环。质量约 7.5/10。

---

## 2. 根因分析（按优先级）

### F1 [P1 / 本修复 P0] Readiness 装配 `content: null` → isProcessed 全假

**现场代码**（`NovelDirectorService.ts` `resolveBatchRoll`，约 L176–206）：

```ts
const workspaceChapters = (workspace.volumes ?? []).flatMap((volume) =>
  (volume.chapters ?? []).map((chapter) => {
    const execRow = chapterByOrder.get(chapter.chapterOrder);
    return {
      id: chapter.chapterId ?? chapter.id,
      order: chapter.chapterOrder,
      title: chapter.title,
      content: null,  // ← 根因
      // … purpose / boundary / taskSheet from workspace …
      generationState: execRow?.generationState ?? null,
      chapterStatus: execRow?.chapterStatus ?? null,
      riskFlags: execRow?.riskFlags ?? null,
    };
  }),
);
// 有 workspace 行时整表覆盖 readiness（丢弃仅有 listChapters 时的 content 真值）
readiness = buildBatchRollReadinessFromChapters(workspaceChapters, readinessOptions);
```

**调用链**：

1. `buildBatchRollReadinessFromChapters` 设 `isProcessed: isDirectorAutoExecutionChapterProcessed(chapter)`  
2. `isDirectorAutoExecutionChapterProcessed`（`novelDirectorAutoExecution.ts` L294+）**先** `hasDirectorAutoExecutionChapterContent`；无 content → **false**  
3. `resolveNextPreparedExecutableWindow` 要求窗内存在 `canEnterExecution && !isProcessed` 才算有 work；否则 look further  
4. 若 workspace 规划字段使 `canEnterExecution=true` 且 content 全 null → 整窗「可执行未处理」→ `expand_range`  
5. expand 后 Runtime `listChapters` 真表 remaining=0 → 再进 batch roll → 连 roll → `consecutiveBatchRolls >= 8` → `halt_for_review`

**为何只回填 generationState/chapterStatus 不够**：processed 以 content 为硬前提；status  alone 不短路 `hasContent`。  
**为何覆盖整表危险**：先用 listChapters 建 readiness 本正确；enrich 时整表替换且 content 置空，等于故意销毁执行真值。

**正确原则（冻结）**：

| 字段族 | 权威源 |
|---|---|
| content, generationState, chapterStatus, riskFlags, id（执行 id） | **仅** `listChapters` / execRow |
| purpose, exclusiveEvent, endingState, nextChapterEntryState, summary, payoffRefs | workspace / VolumeChapterPlan |
| title, conflictLevel, revealLevel, targetWordCount, mustAvoid, taskSheet, sceneCards | workspace 优先，缺则 exec 回落 |

**无 execRow**：content 允许 null，`isProcessed=false` 合理（尚未进执行表）。

---

### F2 [P1] full_book_autopilot prepare 跳过 canEnterExecution

**现场**（`novelDirectorAutoExecutionBatchPrepare.ts` L252–272）：

```ts
if (isFullBookAutopilotRunMode(request.runMode)) {
  if (!workspaceHasTitleInRange(baseWorkspace, nextRange)) {
    throw new Error(`懒规划模式仍缺第 … 章标题骨架，无法批续。`);
  }
  const chapters = await deps.novelContextService.listChapters(novelId);
  return applyExpandRangeBatchRoll({ previousState: withPrior…, nextRange, chapters });
  // 无 assessChapterExecutionContractShape / 无 notExecutableOrders
}
```

**对比非懒路径**（同文件 L496–545）：sync 后 workspace⊕exec 合并字段，`assessChapterExecutionContractShape(..., { qualityMode })`，`!canEnterExecution` → throw 明文。

**设计意图**：JIT 不预跑 chapter_detail LLM，减成本。  
**失效假设**：原「监管在 sync 与写之间看骨架」在无人值守自循环下不成立。

**调用图澄清（冻结，避免误读 throw→reenter）**：

```text
expand_range
  → Runtime 直接 applyExpandRangeBatchRoll（**从不**调 prepare）
reenter_structured_outline
  → Runtime 调 prepareNextAutoExecutionBatch
      full_book 懒路径：title 齐 + canEnter hard gate → expand state
      非懒：outline detail + sync + canEnter hard gate → expand state
prepare throw（含懒 gate fail）
  → Runtime markTaskFailed / halt_for_review（**不是**自动 reenter 另一路径）
```

因此 Fix-2 的 throw **不会**魔法变成 reenter；它只是禁止 silent expand。若生产需要「弱合同→自动 detail 细化」，须另开产品决策把 lazy fail 映射到 `reenter_structured_outline`，**本修复不做**。

**full_book 更严注意**：`qualityMode: "full_book_autopilot"` 的 assess 可能比 `ai_copilot` 更严（骨架/义务形态）。懒路径接线后，原先「标题齐即可进写」的弱合同会显式失败——这是有意收紧，错误文案须点名 order + `canEnterExecution=false`。

**修复原则**：懒路径**仍可不**跑 detail LLM；但 **必须** 用与非懒 hard gate **同构** 的 assess 验证 nextRange 每章 `canEnterExecution`；失败 → throw 明文 → Runtime **fail/halt**；**禁止 silent expand**。

**交叉：Runtime empty-expand（已交付，不替代 F1）**：`novelDirectorAutoExecutionRuntime.ts` 在 `expand_range` 后若 persisted 行数为 0，会 `markTaskFailed` + halt（`batch_roll_empty_expand`）。这只挡住「决策窗有 readiness、DB 无行」；**不能**修 content:null 导致的假 unprocessed thrash。F1 merge 仍是主修。

---

### F3 [P2] Strip 显式名单演进

`INTERNAL_QUALITY_CODE_PATTERN` 故意不用裸 `payoff_*`，以保留合法 writer kind `payoff_touch`（见 `chapterTaskSheetQuality.ts` 注释 L223+）。  
新 internal code 漏登记 → 写入/门禁再次卡门。

**修复**：checklist + 正负例单测；不改通配策略。

---

### F4 [P2] isSkippable 非长度仍可跳

`isSkippableAutoExecutionReviewFailure` 仅把长度 marker 钉为 non-skippable（`novelDirectorAutoExecutionFailure.ts`）。  
prose_ban / repair_exhausted / QFP avoidRetry 等仍可能 soft-skip——**产品既有语义**。

**本修复**：**文档记录，默认不改代码**。未来收紧须单独产品决策（禁止与 skip_quality 混谈）。

---

### F5 [P2/P3] `supervisoryCloseable` 死参

`resolveNextAutoExecutionBatchRoll` 接收 `supervisoryCloseable`，但 halt 仅判 `volumeCompletionKind === "prose_complete_only"`（L237–242）。Service enforce 路径仍注入该字段（L222–237）。

**范围澄清（Fix-4）**：仅从 **batch-roll 决策输入** 删除该参数；**保留** checkpoint / volumeCompletion **投影**侧对 `supervisoryCloseable` 的计算与落盘（监管 UI / 卷完成语义仍可读）。  
**推荐**：**删除**决策函数未读参数与 Service→resolve 注入（方案 B），避免读者以为「supervisoryCloseable=false 会 halt」。  
若后续要把 projection 细粒度接入决策，再显式接线并补测——不在本修复猜。

---

### F6 [P3] halt 也递增 consecutiveBatchRolls

保留：防御配额。文档注明 empty expand / halt 消耗配额，避免误读为「未成功 expand 却触顶 = 无限循环 bug」。

---

### F7 [观察] hasTitle 启发式

`hasTitle: Boolean(title) || Boolean(taskSheet) || canEnterExecution` 可能把「仅有脏 taskSheet」当有标题。  
本修复不改启发式；Fix-2 以 canEnterExecution 为准挡住弱合同。

---

## 3. 修复设计（怎么改）

### Fix-1：`mergeWorkspaceChapterWithExecRow` + Service 接线（必须）

**新建导出**（建议文件：`novelDirectorAutoExecutionBatchRollRuntime.ts` 同文件底部，或 `novelDirectorBatchRollChapterMerge.ts` 若文件已过大——优先同文件以减少 import 漂移）：

```ts
/**
 * 批续 readiness / 合同 assess 共用的「规划 ⊕ 执行」合并。
 * 执行真值（content / generationState / chapterStatus / riskFlags / 执行 id）只信 execRow。
 * 规划边界字段只信 plan（workspace）；标量合同字段 plan 优先、exec 回落。
 */
export type WorkspaceChapterPlanSlice = {
  chapterOrder: number;
  chapterId?: string | null;
  id?: string | null;
  title?: string | null;
  summary?: string | null;
  purpose?: string | null;
  exclusiveEvent?: string | null;
  endingState?: string | null;
  nextChapterEntryState?: string | null;
  conflictLevel?: number | null;
  revealLevel?: number | null;
  targetWordCount?: number | null;
  mustAvoid?: string | null;
  taskSheet?: string | null;
  sceneCards?: unknown;
  volumeId?: string | null;
  payoffRefs?: unknown;
};

export type MergedBatchRollChapter = DirectorAutoExecutionChapterRef & {
  title?: string | null;
  summary?: string | null;
  purpose?: string | null;
  exclusiveEvent?: string | null;
  endingState?: string | null;
  nextChapterEntryState?: string | null;
  volumeId?: string | null;
  payoffRefs?: unknown;
};

export function mergeWorkspaceChapterWithExecRow(
  plan: WorkspaceChapterPlanSlice,
  execRow: DirectorAutoExecutionChapterRef | null | undefined,
): MergedBatchRollChapter {
  const sceneCards =
    typeof plan.sceneCards === "string"
      ? plan.sceneCards
      : plan.sceneCards
        ? JSON.stringify(plan.sceneCards)
        : (execRow?.sceneCards ?? null);

  return {
    id: execRow?.id ?? plan.chapterId ?? plan.id ?? `order:${plan.chapterOrder}`,
    order: plan.chapterOrder,
    // 执行真值 — only from execRow
    content: execRow?.content ?? null,
    generationState: execRow?.generationState ?? null,
    chapterStatus: execRow?.chapterStatus ?? null,
    riskFlags: execRow?.riskFlags ?? null,
    // 规划优先 + exec 回落
    title: plan.title ?? execRow?.title ?? "",
    summary: plan.summary ?? null,
    purpose: plan.purpose ?? null,
    exclusiveEvent: plan.exclusiveEvent ?? null,
    endingState: plan.endingState ?? null,
    nextChapterEntryState: plan.nextChapterEntryState ?? null,
    volumeId: plan.volumeId ?? null,
    payoffRefs: plan.payoffRefs,
    conflictLevel: plan.conflictLevel ?? execRow?.conflictLevel ?? null,
    revealLevel: plan.revealLevel ?? execRow?.revealLevel ?? null,
    targetWordCount: plan.targetWordCount ?? execRow?.targetWordCount ?? null,
    mustAvoid: plan.mustAvoid ?? execRow?.mustAvoid ?? null,
    taskSheet: plan.taskSheet ?? execRow?.taskSheet ?? null,
    sceneCards,
  };
}
```

**Service 改法**（替换 `content: null` 块）：

```ts
const workspaceChapters = (workspace.volumes ?? []).flatMap((volume) =>
  (volume.chapters ?? []).map((chapter) =>
    mergeWorkspaceChapterWithExecRow(
      {
        chapterOrder: chapter.chapterOrder,
        chapterId: chapter.chapterId,
        id: chapter.id,
        title: chapter.title,
        summary: chapter.summary,
        purpose: chapter.purpose,
        exclusiveEvent: chapter.exclusiveEvent,
        endingState: chapter.endingState,
        nextChapterEntryState: chapter.nextChapterEntryState,
        conflictLevel: chapter.conflictLevel,
        revealLevel: chapter.revealLevel,
        targetWordCount: chapter.targetWordCount,
        mustAvoid: chapter.mustAvoid,
        taskSheet: chapter.taskSheet,
        sceneCards: chapter.sceneCards,
        volumeId: chapter.volumeId ?? volume.id,
        payoffRefs: chapter.payoffRefs,
      },
      chapterByOrder.get(chapter.chapterOrder),
    ),
  ),
);
```

**可选加固（非必须）**：对「仅在 listChapters 有、workspace 无」的 order，append exec-only readiness 行，避免卷外散章丢失。当前卷内自循环可不做；若做，须单测。

**验收行为**：

- 下一窗已有正文且 processed → `resolveNextPreparedExecutableWindow` 跳过该窗或 look further  
- 全书 processed 且无 unprepared → `completed_scope` 或 `prose_complete_only` halt  
- **禁止**「21–30 已写完」时连 expand 8 次  

---

### Fix-2：共享 `assertBatchWindowCanEnterExecution` + 懒路径接线（必须）

**抽函数**（建议 `novelDirectorAutoExecutionBatchPrepare.ts` 内 export，或与 merge 同 helpers 文件）：

```ts
export function collectNotExecutableOrdersInBatchWindow(input: {
  novelId: string; // 真 novelId；禁止写死 "batch-prepare"/"batch-roll"（可观测/审计）
  selectedChapterOrders: number[];
  chapterByOrder: Map<number, DirectorAutoExecutionChapterRef>;
  workspaceChapterByOrder: Map<number, WorkspaceChapterPlanSlice>;
  qualityMode: "full_book_autopilot" | "ai_copilot";
}): number[] {
  return input.selectedChapterOrders.filter((order) => {
    const execChapter = input.chapterByOrder.get(order);
    const planChapter = input.workspaceChapterByOrder.get(order);
    if (!execChapter) {
      return true;
    }
    const merged = mergeWorkspaceChapterWithExecRow(
      planChapter ?? {
        chapterOrder: order,
        taskSheet: execChapter.taskSheet,
        sceneCards: execChapter.sceneCards,
        conflictLevel: execChapter.conflictLevel,
        revealLevel: execChapter.revealLevel,
        targetWordCount: execChapter.targetWordCount,
        mustAvoid: execChapter.mustAvoid,
      },
      execChapter,
    );
    return !assessChapterExecutionContractShape({
      novelId: input.novelId,
      volumeId: merged.volumeId ?? undefined,
      chapterId: merged.id,
      chapterOrder: order,
      title: merged.title ?? "",
      summary: merged.summary ?? null,
      purpose: merged.purpose ?? null,
      exclusiveEvent: merged.exclusiveEvent ?? null,
      endingState: merged.endingState ?? null,
      nextChapterEntryState: merged.nextChapterEntryState ?? null,
      conflictLevel: merged.conflictLevel ?? null,
      revealLevel: merged.revealLevel ?? null,
      targetWordCount: merged.targetWordCount ?? null,
      mustAvoid: merged.mustAvoid ?? null,
      payoffRefs: merged.payoffRefs as never,
      taskSheet: merged.taskSheet ?? null,
      sceneCards: merged.sceneCards ?? null,
    }, {
      qualityMode: input.qualityMode,
    }).canEnterExecution;
  });
}

// buildBatchRollReadinessFromChapters 内 assess 的 novelId 允许占位 "batch-roll"
// （纯 readiness，无审计写路径）；prepare hard gate 必须传真实 novelId。
```

**懒路径改造**（L252–272 替换逻辑要点）：

1. 保留 `workspaceHasTitleInRange`  
2. `listChapters`  
3. 建 `chapterByOrder` + `workspaceChapterByOrder`（与非懒同构）  
4. `selectedChapterOrders = rangeInclusive(nextRange)`  
5. `notExecutable = collectNotExecutableOrdersInBatchWindow(...)`  
6. `notExecutable.length > 0` →  
   `throw new Error(\`批续窗懒规划第 ${nextRange.startOrder}-${nextRange.endOrder} 章合同不可执行（第 ${notExecutable.slice(0,5).join("、")} 章 canEnterExecution=false），不能静默 expand。\`)`  
7. 通过后再 `withPriorWindowQualityDebtSummary` + `applyExpandRangeBatchRoll`  
8. **仍不**强制 chapter_detail LLM  

**非懒路径**：L507–539 改为调用同一 `collectNotExecutableOrdersInBatchWindow`，消灭字段映射双份。

**灰度（可选）**：`request.requireExecutableContractOnLazyBatchRoll !== false` 默认 true；仅测试/应急可关。默认 **不要** 暴露为产品开关，避免再开灰度债务。

---

### Fix-3：Strip 演进防护

**注释**（`chapterTaskSheetQuality.ts` 在 `INTERNAL_QUALITY_CODE_PATTERN` 上）：新增 internal code checklist：

1. 加入 pattern 词条（或 prose_/timeline_ 族）  
2. shared/server 单测正例 strip 空  
3. 确认非 writer-facing；`payoff_touch` 永不进 strip  
4. 同步 wiki / 本修复文档「已知名单」表（可选）

**测试**：每个当前显式词条至少一条 strip 测；`payoff_touch` / 自然语言「兑付」保留。

---

### Fix-4：supervisoryCloseable

从 `resolveNextAutoExecutionBatchRoll` 签名删除 `supervisoryCloseable`；Service 不再赋值注入。  
`volumeCompletionKind === "prose_complete_only"` 行为与测保持。

---

### Fix-5：可观测性（小，可同阶段）

在 `resolveBatchRoll` 决策前后（若已有 `logPipelineInfo` 模式）补：

- `nextRange`、`preparedCount`、`processedInPrepared`、`consecutiveBatchRolls`  
- 可选 warn：`consecutiveBatchRolls >= 2` 且本次 expand 后 Runtime 侧 remaining 仍 0（Runtime 侧已有 empty expand halt 则可不重复）

---

## 4. 文件变更清单

| 优先级 | 动作 | 路径 |
|---|---|---|
| P0 | 改 | `server/src/services/novel/director/NovelDirectorService.ts`（resolveBatchRoll merge） |
| P0 | 改/增导 | `server/src/services/novel/director/automation/novelDirectorAutoExecutionBatchRollRuntime.ts`（`mergeWorkspaceChapterWithExecRow`） |
| P0 | 改 | `server/src/services/novel/director/automation/novelDirectorAutoExecutionBatchPrepare.ts`（懒 gate + 抽 collect） |
| P2 | 改 | 同上 Runtime：删除 `supervisoryCloseable` 参数 |
| P2 | 改/测 | `shared/types/chapterTaskSheetQuality.ts` + 既有 quality/strip 测 |
| P0 | 扩测 | `server/tests/novelDirectorAutoExecutionBatchRollRuntime.test.js` |
| P0 | 扩测 | `server/tests/selfCycleAcceptance.test.js` |
| 文档 | 本文件 | `docs/plans/director-self-cycle-p0-review-fix.md` |
| 文档 | 小改 | `docs/plans/director-self-cycle-pipeline-plan.md` 关联链 |

**不改**（防范围膨胀）：`novelDirectorAutoExecutionRuntime.ts` 四点 remaining=0 接入逻辑；QFP；repair stream；takeover 优先级（除非测红暴露回归）。

---

## 5. 测试矩阵

| ID | 用例 | 断言 | 建议位置 |
|---|---|---|---|
| T1 | merge：exec 有 content+completed | `isProcessed === true`，即便 plan 只 enrich purpose | batchRollRuntime.test |
| T2 | thrash guard（双层）：(a) pure readiness 21–30 全 processed → prepared=null + completed_scope；(b) **wiring**：plan 有合同字段 + exec 有 content/approved，经 merge→buildReadiness 后 isProcessed=true，禁止再现 content:null 假 work | 同 T2a 断言 + assert merge 后 isProcessed | batchRollRuntime.test（优先；不启 Prisma） |
| T3 | empty expand | 已有测保持绿 | runtime 既有 |
| T4 | lazy gate fail | titles ok、边界/taskSheet 空 → `collectNotExecutable…` 非空 / prepare throws 文案含 canEnterExecution | prepare 单测或纯函数测 |
| T5 | lazy gate pass | titles+合同字段齐 → notExecutable 空 | 同上 |
| T6 | strip registry | 显式 internal codes strip；`payoff_touch` 保留 | qualityFeedback / taskSheetQuality 既有扩 |
| T7 | no-rewind | 回归绿 | selfCycleAcceptance |
| T8 | under_hard non-skippable | 回归绿 | selfCycleAcceptance |
| T9 | dead param 删除后 | prose_complete_only 仍 halt；typecheck | batchRollRuntime.test |

**原则**：merge / collect 纯函数化 → **不启 Prisma** 即可盖 F1/F2 主路径。

### 示例测（实现时原样或微调）

```js
test("mergeWorkspaceChapterWithExecRow keeps exec content for isProcessed", () => {
  const merged = mergeWorkspaceChapterWithExecRow(
    {
      chapterOrder: 25,
      chapterId: "ws-25",
      title: "标题",
      purpose: "目的",
      exclusiveEvent: "独占事件",
      endingState: "终态",
      nextChapterEntryState: "入口",
      taskSheet: JSON.stringify({ obligations: [{ kind: "payoff_touch", text: "轻触伏笔" }] }),
    },
    {
      id: "ch-25",
      order: 25,
      content: "足够长的正文…",
      // completed 判定：generationState approved|published 或 chapterStatus completed
      generationState: "approved",
      chapterStatus: "completed",
      riskFlags: null,
    },
  );
  assert.equal(merged.content?.includes("正文"), true);
  assert.equal(merged.id, "ch-25"); // 执行 id 优先
  assert.equal(isDirectorAutoExecutionChapterProcessed(merged), true);
  assert.notEqual(merged.content, null);
});

test("wiring: merge+readiness treats plan+exec as processed (anti content:null thrash)", () => {
  const readiness = [];
  for (let order = 21; order <= 30; order += 1) {
    const merged = mergeWorkspaceChapterWithExecRow(
      {
        chapterOrder: order,
        title: `第${order}章`,
        purpose: "推进",
        exclusiveEvent: "事件",
        endingState: "终态",
        nextChapterEntryState: "入口",
        conflictLevel: 2,
        revealLevel: 1,
        targetWordCount: 2800,
        mustAvoid: "无",
        taskSheet: "任务单正文",
        sceneCards: JSON.stringify({ scenes: [{ key: "s1" }] }),
      },
      {
        id: `ch-${order}`,
        order,
        content: `第${order}章正文内容……`,
        generationState: "approved",
        chapterStatus: "completed",
        riskFlags: null,
        conflictLevel: 2,
        revealLevel: 1,
        targetWordCount: 2800,
        mustAvoid: "无",
        taskSheet: "任务单正文",
        sceneCards: "{}",
      },
    );
    assert.equal(isDirectorAutoExecutionChapterProcessed(merged), true);
    readiness.push(...buildBatchRollReadinessFromChapters([merged]));
  }
  assert.equal(resolveNextPreparedExecutableWindow({ afterOrder: 20, readiness }), null);
});

test("prepared window all processed does not report work (anti-thrash)", () => {
  const readiness = [];
  for (let order = 21; order <= 30; order += 1) {
    readiness.push({
      order,
      hasTitle: true,
      canEnterExecution: true,
      isProcessed: true,
    });
  }
  const next = resolveNextPreparedExecutableWindow({ afterOrder: 20, readiness });
  assert.equal(next, null);
  const decision = resolveNextAutoExecutionBatchRoll({
    range: { startOrder: 11, endOrder: 20, totalChapterCount: 10, firstChapterId: null },
    autoExecution: { remainingChapterCount: 0 },
    consecutiveBatchRolls: 0,
    nextPreparedExecutableWindow: next,
    nextUnpreparedWindow: null,
    canPrepareNextBatch: true,
  });
  assert.equal(decision.kind, "completed_scope");
});
```

（`autoExecution` / `range` 字段以实现时类型与工厂 helper 为准；测中应用项目既有 fixture 构造器若存在。）

---

## 6. 实现顺序（TDD）

> 用户下令后执行。每 Task 结束：必要验证 → `production-code-quality-review` → 原子 commit → 短总结。

### Task 1: merge 纯函数 + thrash 单测 + Service 接线

**Files:**

- Modify: `novelDirectorAutoExecutionBatchRollRuntime.ts`  
- Modify: `NovelDirectorService.ts` ~L176–206  
- Test: `server/tests/novelDirectorAutoExecutionBatchRollRuntime.test.js`  
- Test: `server/tests/selfCycleAcceptance.test.js`（T2 可放此）

**Interfaces:**

- Produces: `mergeWorkspaceChapterWithExecRow`, `MergedBatchRollChapter`, `WorkspaceChapterPlanSlice`

- [ ] **Step 1:** 写 T1/T2 失败测（import merge 尚不存在 → FAIL）  
- [ ] **Step 2:** 实现 merge；跑测至 T1 绿  
- [ ] **Step 3:** Service 改用 merge，删除 `content: null`  
- [ ] **Step 4:** T2 + 既有 batchRoll 测绿  

```bash
cd /Users/mango/project/claude-project/AI-Novel-Writing-Assistant
# 若 shared 有改动先 build；本 Task 通常只需 server
pnpm --filter @ai-novel/server exec node --test tests/novelDirectorAutoExecutionBatchRollRuntime.test.js
pnpm --filter @ai-novel/server exec node --test tests/selfCycleAcceptance.test.js
```

- [ ] **Step 5:** Commit  

```bash
git add server/src/services/novel/director/automation/novelDirectorAutoExecutionBatchRollRuntime.ts \
  server/src/services/novel/director/NovelDirectorService.ts \
  server/tests/novelDirectorAutoExecutionBatchRollRuntime.test.js \
  server/tests/selfCycleAcceptance.test.js
git commit -m "$(cat <<'EOF'
fix(self-cycle): merge exec truth into batch-roll readiness

Stop overwriting workspace-enriched readiness with content:null, which
forced isProcessed=false and expand thrash after completed windows.
EOF
)"
```

- [ ] **Step 6:** `production-code-quality-review` 本增量；P0/P1 阻断必修  

---

### Task 2: 懒路径 canEnterExecution + 共享 collect + strip/死参

**Files:**

- Modify: `novelDirectorAutoExecutionBatchPrepare.ts`  
- Modify: `novelDirectorAutoExecutionBatchRollRuntime.ts`（删 supervisoryCloseable）  
- Modify: `NovelDirectorService.ts`（停注入 dead 字段）  
- Modify: `shared/types/chapterTaskSheetQuality.ts`（注释 checklist，必要时）  
- Test: strip 相关既有测 + T4/T5 纯函数测  

**Interfaces:**

- Consumes: `mergeWorkspaceChapterWithExecRow`  
- Produces: `collectNotExecutableOrdersInBatchWindow`

- [ ] **Step 1:** T4/T5 红测  
- [ ] **Step 2:** 实现 collect；懒路径 + 非懒路径共用  
- [ ] **Step 3:** 删 supervisoryCloseable；T9 + prose_complete_only 仍绿  
- [ ] **Step 4:** strip 正负例（若缺口）  
- [ ] **Step 5:**  

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server exec node --test tests/novelDirectorAutoExecutionBatchRollRuntime.test.js
pnpm --filter @ai-novel/server exec node --test tests/selfCycleAcceptance.test.js
# 若有 prepare 专用测一并跑
pnpm --filter @ai-novel/server typecheck
```

- [ ] **Step 6:** Commits（可 1–2 个）  

```bash
git commit -m "$(cat <<'EOF'
fix(self-cycle): gate full_book batch prepare on canEnterExecution

Reuse the non-lazy hard-gate assess path so title-only JIT cannot silent
expand into weak contracts.
EOF
)"

# 可选第二提交
git commit -m "$(cat <<'EOF'
chore(self-cycle): drop unused supervisoryCloseable; harden strip checklist
EOF
)"
```

- [ ] **Step 7:** 审查 → 《阶段总结》→ **Milestone 交付总结** → **停止**（不 resume pxed）

---

## 7. 风险与回滚

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | merge 后 prepared 窗变少，更早 completed_scope | 正确行为；未同步行仍 unprepared→reenter |
| R2 | 懒 gate 过严卡住 autopilot | 错误信息点名 order；可 force 走 detail 环；不 silent skip / 不 skip_quality |
| R3 | 测只盖纯函数未盖 Service | merge 抽纯 + Service 薄接线；审查核对 L183 不再出现 `content: null` |
| R4 | collect 与 assess 字段漏映射 | 与非懒 L519–536 字段表对照清单；单测缺 purpose 等边界 |
| R5 | 回滚 | `enableBatchRoll: false` 或 revert 单 commit；旧 completed 语义仍在 |

---

## 8. 验收标准

- [ ] T1–T9 相关测绿（T7/T8 回归）  
- [ ] `shared` build（若动 shared）+ server 相关 typecheck  
- [ ] 代码中 **不存在** resolveBatchRoll 路径 `content: null` 覆盖 isProcessed  
- [ ] full_book 懒路径在 `!canEnterExecution` 时 **throw**，不 `applyExpandRangeBatchRoll`  
- [ ] production-code-quality-review：**无新 P0**；本修复 P0/P1 关闭  
- [ ] 本文档与 `director-self-cycle-pipeline-plan.md` 互链  
- [ ] **未**部署生产、**未** resume 写书（除非用户另令）

---

## 9. 生文影响（修后预期）

| 面 | 修前 | 修后 |
|---|---|---|
| 已写窗批续 | 假未处理 → 空转 roll、task fail 噪声 | processed 真 → completed_scope / 真下一窗 |
| 懒规划进写 | 标题齐即可 expand | 合同可执行才 expand；弱合同显式失败 |
| Strip / 长度 / QFP / no-rewind | 既有收益 | 保持 |
| 监管交互 | 半自动 + thrash 干扰 | 仍 ≤ 真质量门；禁止 skip_quality 不变 |

---

## 10. 明确不做（Backlog）

| 项 | 原因 |
|---|---|
| 全面 non-skippable review-block | 产品语义，非本缺陷 |
| overload 义务 LLM 收束 | 原 P0 非目标 |
| 历史 taskSheet migration UI | P2/P3 |
| 执行面进程隔离 | 另案 |
| pxed 发版 + continue/forceResume | Manual-required |
| residual 57/71/74 rewrite | 需单独订单 |
| 重写整个 director 调度器 | 范围爆炸 |

---

## 11. Manual-required（修复发版后，非本代码闭环）

1. 合并 main → 部署 **pxed**  
2. 生产 task：`continue` + `forceResume` + 观察 **不回卷**、**不 thrash halt**  
3. 更新 vault 监管笔记（走 `obsidian-doc-router` / `AI-DOC-ROUTER`）  
4. residual 章另单处理  

---

## 12. 与 pipeline 主文档关系

- **主功能设计**：`director-self-cycle-pipeline-plan.md`（阶段 1–5 已实现语义）  
- **本文件**：实现后回归缺陷的 **修复专项**；不替代主文档  
- 主文档头部「关联」应增加本文件链接（实现文档落盘时已建议编辑）  

---

## 13. Self-review（文档自检）

| 检查 | 结果 |
|---|---|
| Review F1–F6 均有对应 Fix / 明确不做 | 是 |
| 无 TBD/「适当处理」占位 | 是（代码块为可粘贴草案，实现时允许类型微调） |
| merge / collect 命名前后一致 | 是 |
| 测试矩阵覆盖 thrash + lazy + 回归 | 是 |
| 停止条件禁止自动 resume / 下一 milestone | 是 |

---

## 14. 实现状态

| 项 | 状态 |
|---|---|
| 用户下令「文档优化 + 落实代码」 | 已接受 · 2026-07-17 |
| Task 1 Fix-1 merge + Service | 已完成 · commit `9f78556`（merge 纯函数 + Service 接线 + thrash 回归） |
| Task 2 Fix-2 lazy gate + 死参 | 已完成 · `collectNotExecutableOrdersInBatchWindow` + lazy/non-lazy 共用 + 删 decision 死参 `supervisoryCloseable` + T4/T5 测绿 |
| 生产 resume / 下一 milestone | **禁止**（Manual-required 另令） |
