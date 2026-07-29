# 章节资产投影模块边界

## 职责

- `ChapterArtifactDeltaOrchestrator` 负责通过 Prompt Registry 调用章节资产 delta Prompt，并按固定顺序协调各投影。
- `ChapterSummaryFactProjection` 负责章节摘要、关键事件和 revision-owned 自动事实。
- `ChapterStateSnapshotProjection` 负责状态快照入口；具体 canonical state 写入仍归状态模块。
- `ChapterPayoffProjection` 负责本章 payoff delta，不负责条件性全量对账。
- `ChapterCharacterProjection` 负责候选角色、阵营、关系阶段和角色信息边界。
- 外部调用只使用 `ChapterArtifactDeltaService` facade；模块内部通过本目录 `index.ts` 汇总边界。

## Revision 所有权

- `Chapter.contentRevision` 是投影写权限，不是普通缓存字段。
- Prompt 返回后必须先确认 owner 仍是当前 revision；每个独立事务还必须以 conditional no-op `UPDATE Chapter ... WHERE contentRevision = expected` 取得事务期写锁。
- writer 必须顺序执行。任一 writer 抛出 `ChapterProjectionSupersededError` 后，不得启动剩余 writer，也不得排入 RAG。
- RAG 只在摘要、事实、状态、资源、payoff、角色和知识状态全部完成并通过最终 revision 检查后排队。
- superseded 是章节局部降级完成：由 background checkpoint 记录失败/原因，不改变章节、pipeline 或自动导演的全局终态。

## 禁止事项

- 不得用 content hash 代替 revision 写所有权。
- 不得从 service、route 或导演分支 deep import 单个投影并绕开 orchestrator。
- 不得把人工事实或人工来源资产纳入自动 revision 清理。
- 不得把本目录重新堆成通用 `helpers` / `utils`；新职责必须进入明确的投影或编排模块。
