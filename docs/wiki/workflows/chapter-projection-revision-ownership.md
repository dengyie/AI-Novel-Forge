# 章节投影 Revision 所有权

## Background

章节正文提交后会异步生成时间线、摘要、事实、状态快照、角色资源、payoff、角色动态和 RAG 索引。Prompt、事务和后台队列之间存在明显时间窗口：如果用户或另一执行者在窗口内保存了新正文，旧结果不能继续写入 canonical state。

content hash 可以识别相同文本和 checkpoint，但无法区分 `A@7 -> B@8 -> A@9`，也不能在数据库事务中保护写入。因此正文 hash 不是写权限。

## Decision

`Chapter.content + Chapter.contentRevision` 是章节正文唯一事实源；`contentRevision` 同时是章节派生投影的写所有权。

所有章节派生流程携带：

```ts
interface ChapterProjectionOwner {
  novelId: string;
  chapterId: string;
  expectedContentRevision: number;
}
```

Prompt 返回后先做当前 revision 检查。每个独立 canonical writer 事务还必须把 conditional no-op Chapter update 作为第一个数据库动作；普通 `SELECT` 不能提供“检查后到写入前”这段时间的所有权。

## Current Rule

- 时间线、摘要、自动事实、状态快照、state-diff conflict、状态 proposal、canonical version、proposal-version link、资源 stale scan、payoff delta、payoff full reconcile、角色动态和知识边界都受同一 owner 约束。
- 一个投影事务成功，只表示它提交时 revision 仍有效；后续 writer 必须再次检查，不能复用前一个事务的结论。
- writer 按顺序执行。任何 writer superseded 后立即停止剩余 writer；并行启动多个 canonical writer 会破坏“停止剩余副作用”的语义。
- RAG enqueue 位于整条 artifact writer 链之后，并在排队前做最终 revision 检查。中途 superseded 不得留下旧章节/摘要索引任务。
- 条件性 payoff full reconcile 与 artifact delta 使用各自的 revision-owned checkpoint claim。主账本、窗口延期、open-conflict 和失败回写都必须消费相同 owner。
- 自动事实只清理同章旧 revision 和迁移前无 owner 的自动行，人工事实不参与清理。
- superseded checkpoint 记录为本章局部失败/淘汰并允许当前 revision 后续重建；它不是章节质量失败、pipeline 失败或自动导演重规划信号。
- 非章节派生的人工/运维调用可以省略 owner，但统一章节 runtime 和 background 自动链不得利用该兼容入口绕过 owner。

## Direct artifact writers

`runtime/pipeline/ChapterPipelineArtifactSync` 负责流水线最终保留正文的同步，主循环只负责决定正文与质量结果。CRUD、初稿提交、修复采纳和章节流水线共用 `ChapterArtifactSyncService`。调用方必须传提交返回的正文与 revision；不得重新读取当前 revision 后给旧正文补一个新版本号。CRUD 的 CAS 成功快照使用 `expectedContentRevision + 1`，因为之后的重新读取可能已看到下一位写者。

摘要/事实事务和人物时间线事务各自首先执行 `lockCurrentForWrite`。人工保存的摘要过期标记也在同一个 revision-owned 事务中合并，避免旧保存覆盖新元数据。人工保存正文已成功但投影被新保存淘汰时，返回保存成功，由新 revision 负责派生数据。

人物时间线函数只返回待索引记录；整个同步链结束并确认 owner 后统一排队。`novelChapterArtifacts` 的重复持久化路径不再承担写职责，新增写入必须进入上述唯一服务。

人物页的 `syncCharacterTimeline` 批量重建同样消费章节正文。它必须读取每章 revision，在删除前锁定整个来源快照，且仅删除快照中 chapterId 对应的自动时间线；按章节范围宽泛删除会波及读取后并发新增的章节。任何一章被新正文取代时，整个旧重建事务退出，保留新版事件。

## Quality assessment ownership

质量报告与质量闭环评估是独立 writer，分别验证同一个 `expectedContentRevision`。报告提交成功不代表后续评估仍有写权限。评估 CAS 被拒绝时，流水线重新读取当前章节质量债，淘汰旧评估及其全局重规划建议；旧章节质量警告不能冒充当前正文结果。

`ChapterQualityLoopService.recordAssessment` 是质量评估唯一持久化入口。瞬态 SQLite 锁冲突重试该入口，不得在异常分支用无 revision 条件的 update 补写 riskFlags 或 chapterStatus。当前 revision 的非瞬态写入失败可保留本轮内存反馈，但不覆盖数据库元数据；正文已更新或删除则只能淘汰旧结果。

## Repair discard ownership

未采纳候选也会改变修复历史和质量反馈，属于章节派生写入。discard / plateau 与 adopt 必须消费同一个修复启动时的 `baselineContentRevision`。`recordRepairFeedbackDecision` 在事务内先取得 revision 条件写锁，再读取当前历史和 riskFlags，将决策行与反馈一起提交；不能先写历史、再吞掉反馈写入错误。

候选被新正文淘汰时返回未应用结果，不累计新正文的 failedPatchCount、avoidRetry 或重写升级次数。同 revision 的其他元数据也必须基于锁内最新值合并，不能把评估前的历史快照整段覆盖回来。

## Failure Modes

- 只在 Prompt 前检查 revision：Prompt 返回后正文可能已经变化。
- 只在 orchestrator 检查一次：多个独立事务之间仍可升版。
- 在事务里先 `SELECT` 再写：并发正文提交可以发生在读与首个副作用之间。
- 用 `Promise.all` 启动多个 writer：一个 writer 发现 superseded 时，其他 writer 已经开始。
- 摘要写完立即 enqueue RAG：后续状态/payoff writer superseded 后仍遗留旧索引任务。
- payoff full reconcile 只给主事务加锁：窗口延期、conflict 或失败 fallback 仍能写旧结果。
- checkpoint 只有 content hash：恢复为相同文本的新 revision 会错误复用旧投影。

## Related Modules

- `server/src/services/novel/runtime/projections/`
- `server/src/services/novel/runtime/artifacts/`
- `server/src/services/novel/runtime/ChapterArtifactBackgroundSyncService.ts`
- `server/src/services/payoff/PayoffLedgerSyncService.ts`
- `server/src/services/payoff/sync/`
- `server/src/services/state/StateService.ts`
- `server/src/services/novel/state/StateCommitService.ts`

## Source Documents

- `docs/superpowers/specs/2026-07-28-novel-production-concurrency-revision-design.md`
- `docs/superpowers/plans/2026-07-28-novel-production-concurrency-revision.md`
