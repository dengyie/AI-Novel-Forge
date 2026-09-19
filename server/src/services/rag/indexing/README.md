# RAG 索引编排边界

## Ownership

`indexing/` 只负责把公开 reindex scope 展开成 owner id，并把 rebuild job 以有界并发写入队列。它只依赖 Prisma 和 RAG owner 类型，不得导入 embedding、Qdrant、worker 或检索服务。

## Scope

- `novel` 覆盖小说、Bible、章节、章节摘要、连续性事实、角色和角色时间线。
- `world` 覆盖世界和世界属性库条目。
- `all` 依次覆盖以上业务 owner，并覆盖非归档的 `knowledge_document`。知识文档是否有激活内容由 worker 继续确认；归档文档的旧索引由归档删除流程清理，避免全量重建把归档状态写成成功。

## Queue policy

全量 owner 入队使用固定默认上限 4 的小池，避免一次性为所有 owner 创建待执行数据库写入。调用方仍收到全部成功创建或复用的 job，任何 enqueue 错误仍会向上抛出。
