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
