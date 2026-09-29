# 卷规划边界

- `NovelVolumeService` 是卷规划对外门面，负责组装版本、生成与章节同步能力。
- `ChapterExecutionContractService` 拥有单章合同的复用、AI 生成、形状验证与事务提交。`factRefresh` 是显式刷新输入，成功提交时与已消费事实指纹一起保存。
- `application/VolumeChapterProjectionService` 只负责章节表执行字段与卷文档之间的 hydration / mirror，保留用户冲突强度锚点。它不做 AI 决策，不拥有卷版本策略。
- 持久化经 `volumeWorkspacePersistence`；单章刷新事务先认领章节快照，才允许更新卷版本及章节合同。外部模块通过门面消费，不深引 application 内部。

事实刷新依据与失败行为见 [事实账本 Wiki](../../../../../docs/wiki/workflows/novel-fact-ledger.md)。
