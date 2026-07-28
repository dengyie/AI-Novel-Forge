# 小说生产并发与 Revision 所有权修复设计

## Background

本地 `main` 在 `origin/main..72ac602` 的小说生产加固后仍存在六类问题：服务端无法编译、初稿写入绕过正文 CAS、任务租约接管会吞掉取消、时间线与资产投影缺少正文 revision 所有权、显式 cancelled 导演任务会被 UI 清除，以及 `ChapterArtifactDeltaService` 继续在超长文件中堆积职责。

这些问题的共同根因不是缺少更多兜底，而是写入权限与事实源边界不清：正文、任务意图和章节派生事实分别需要自己的 canonical contract。

## Decision

采用分层生产修复：先恢复构建并关闭正文/取消竞态，再建立统一的章节投影 revision guard，最后修复 UI 选择契约并拆分资产模块。不得用字符串匹配、兼容门面或静默 last-write-wins 掩盖冲突。

## Global Invariants

1. `Chapter.content + Chapter.contentRevision` 是章节正文唯一事实源。
2. 任何 Writer、style rewrite、repair adoption 写正文都必须携带读取正文时的 `expectedContentRevision`。
3. 正文 CAS 未命中必须返回结构化冲突；不得覆盖新正文，也不得继续提交基于旧正文的质量、时间线、事实或资产投影。
4. 用户取消是 GenerationJob 级意图，不属于 lease owner。租约只保护执行者的进度、心跳和终态写入。
5. 异步时间线和资产提取必须携带 `expectedContentRevision`。在任何 canonical side effect 前都必须重新验证当前 revision。
6. 投影 CAS 未命中表示结果已陈旧：标记 checkpoint 为 superseded/failed，停止后续副作用，不把它转换为章节失败或全书 replan。
7. 人工事实、人工时间线与人工状态不得因自动投影 revision 淘汰而删除。
8. cancelled/failed/completed 的显式 `directorTaskId` 必须可检查；只有没有显式 ID 时才自动聚焦最新活跃或需处理任务。
9. 修复不得绕开 Prompt Registry、Context Broker 或统一章节 runtime。
10. 所有行为修改必须 TDD：先看到失败测试，再实现，再运行目标测试与类型检查。

## Architecture

### 1. 正文提交

`ChapterContentCommitService` 作为所有生成型正文写入的唯一提交服务。其输入包含 `novelId`、`chapterId`、`content`、`expectedContentRevision`、`statePatch` 和 `source`。`ChapterArtifactSyncService.saveDraftAndArtifacts` 不再直接更新正文，只委托提交服务；artifact 同步只消费 `CommittedChapterContent`。

Writer 从 `GenerationContextAssembler` 取得初始 revision，并通过 `ChapterWritingGraph`、`ChapterStreamGenerationOrchestrator`、`chapterRuntimePipeline` 原样传到提交点。重试生成在没有成功正文提交前继续使用同一基线 revision。

### 2. 取消与租约

`PipelineJobStateRepository.requestRunningCancellation` 使用 `{ id, status: "running", finishedAt: null }` 的任务状态 CAS，只写取消字段并保留当前 lease owner。调用方必须检查 count；CAS 未命中时重读 canonical row：终态直接返回，仍为 queued/running 时按最新状态重试一次，未知状态返回明确冲突。

执行者仍通过 lease-owned CAS 写心跳、进度和最终结算。取消请求不得复用 lease-owned where builder。

### 3. Projection Guard

新增 `runtime/projections/ChapterProjectionRevisionGuard.ts`，提供：

```ts
export interface ChapterProjectionOwner {
  novelId: string;
  chapterId: string;
  expectedContentRevision: number;
}

export class ChapterProjectionSupersededError extends Error {}

export class ChapterProjectionRevisionGuard {
  assertCurrent(owner: ChapterProjectionOwner): Promise<void>;
}
```

Guard 查询必须同时匹配 novel、chapter、revision。时间线与资产服务在 LLM 之前可做快速检查，但决定是否写 canonical state 的检查必须发生在 LLM 返回之后、第一项副作用之前。每个会独立开启事务的 owned writer 还必须把 `expectedContentRevision` 放入其事务内检查，不能只依赖 orchestrator 的一次预检。

本阶段不扩建完整事件溯源。已有自动事实继续使用 revision-owned rows；时间线和资产 checkpoint 继续用 content hash 做幂等键，但 content hash 不能替代 revision guard。若发现正文已经变化，结果直接 superseded，等待当前 revision 的正常同步重新生成。

### 4. 时间线提交

`ChapterContentFinalizationOrchestrator` 把 committed revision 传给 `ChapterTimelineProjectionService` 和 `ChapterTimelineFinalizationService`。在 `commitChapterTimeline` 前执行 revision guard；guard 失败时不得创建 event/hook、不得改 anchor、不得 resolve 旧 hook。

时间线提交改为 chapter-owned replace：同一章节自动抽取的 event 和该章节自动创建的 hook 应按当前 content hash/revision 幂等替换；人工时间线行保持不变。若现有 schema 无法区分自动 hook，增加最小来源字段，而不是通过标题或文本猜测。

### 5. 资产投影

将 `ChapterArtifactDeltaService` 拆为 `runtime/artifacts/`：

- `ChapterArtifactDeltaOrchestrator.ts`：加载上下文、调用注册 Prompt、协调阶段。
- `ChapterSummaryFactProjection.ts`：摘要、key events、revision-owned facts。
- `ChapterStateSnapshotProjection.ts`：状态快照与提案。
- `ChapterPayoffProjection.ts`：payoff delta。
- `ChapterCharacterProjection.ts`：角色动态与知识状态。
- `ChapterArtifactProjectionGuard.ts`：在每个 canonical writer 前调用统一 revision guard。
- `index.ts`：模块 facade；外部禁止 deep import。

任何 guard 失败都必须停止剩余 writer。已经是人工来源的数据不能清理。RAG enqueue 只能在对应 DB 投影成功后执行。

### 6. UI Canonical Selection

`resolveCanonicalDirectorTask` 是选择规则唯一真源。controller effect 只负责 URL 与 canonical selection 同步，不得另行判定 cancelled。显式加载成功且 ID 匹配的任务始终保留；无显式 ID 时 cancelled 不自动聚焦。

## Error Semantics

- 正文冲突：沿用 `CHAPTER_CONTENT_CONFLICT`，向调用方返回当前 revision。
- 投影陈旧：`ChapterProjectionSupersededError`，记录 debug/warn 和 checkpoint metadata，不改变章节/导演任务终态。
- 取消竞态：返回最终 canonical job；请求不能返回 running 且 `cancelRequestedAt=null`，除非响应为明确冲突错误。
- 构建错误：不得通过 `as any`、宽化为 `Record<string, unknown>` 或关闭 TypeScript 检查解决。

## Test Contract

必须新增或修改以下真实路径测试：

1. Writer 生成期间人工保存，初稿 CAS 失败且人工正文保持不变。
2. 修复稿 CAS 现有测试继续通过。
3. owner A 读取后 owner B 接管，取消仍落在 canonical job，owner B 不被覆盖。
4. 取消与 succeeded 竞态，succeeded 不被覆盖。
5. timeline LLM 返回前正文 revision 变化，不创建 event/hook/anchor。
6. artifact delta LLM 返回前正文 revision 变化，不写 summary/fact/snapshot/payoff/character state/RAG。
7. 显式 cancelled task 在不带 `taskPanel=1` 的 URL 中仍保留。
8. 无显式 ID 时 cancelled task 不自动聚焦。
9. 服务端 build/typecheck 和客户端 typecheck 通过。

## Agent Work Packages

### Package A — Build Contract

只修复三个现有 TypeScript 错误，不改变运行语义。完成后服务端 build 必须通过。

### Package B — Draft CAS

独占正文提交接口、Writer revision 传递及竞态测试。不得触碰 pipeline cancellation、timeline 或 UI。

### Package C — Cancellation

独占 pipeline state/cancellation 目录和取消竞态测试。不得修改章节 runtime。

### Package D — Projection Ownership And Artifact Split

负责 projection guard、timeline revision 传递、artifact 模块拆分及竞态测试。该包在 A/B 之后执行，以复用稳定类型与正文提交契约。

### Package E — UI Selection And Runtime Data Hygiene

负责 director selector/controller 集成测试与 `.data/` ignore。不得修改服务端导演状态模型。

### Package F — Integration Review

不新增功能，只处理合并后的类型/测试集成问题，更新 wiki 中章节生产、投影 revision、取消语义的长期规则，并执行最终验证。

## Merge Order

`A -> B -> C -> D -> E -> F`。每个包独立 commit、独立复审。D 不得与 B 并行修改统一章节 runtime；E 可在 D 之后执行以避免控制器冲突。完成后先合入 `beta` 做集成验证，不直接从修复分支进入 `main`。

## Non-goals

- 不建设完整事件溯源框架。
- 不改变 AI 质量判定或质量债继续规则。
- 不增加关键词/正则业务路由。
- 不清理人工事实或人工时间线。
- 不对无关超长文件做顺手重构。
