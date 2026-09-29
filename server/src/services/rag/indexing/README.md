# RAG 索引编排边界

## Ownership

`indexing/index.ts` 提供公开 reindex scope 展开、入队与文档状态投影，仅依赖 Prisma 和轻量配置。`source/` 与 `persistence/` 拥有 worker 侧源装配和分块发布协议，不得从轻量 barrel 导出运行时重依赖。

## Scope

- `novel` 覆盖小说、Bible、章节、章节摘要、连续性事实、角色和角色时间线。
- `world` 覆盖世界和世界属性库条目。
- `all` 依次覆盖以上业务 owner，并覆盖非归档的 `knowledge_document`。知识文档是否有激活内容由 worker 继续确认；归档文档的旧索引由归档删除流程清理，避免全量重建把归档状态写成成功。

## Queue policy

全量 owner 入队使用固定默认上限 4 的小池，避免一次性为所有 owner 创建待执行数据库写入。调用方仍收到全部成功创建或复用的 job，任何 enqueue 错误仍会向上抛出。

## 版本与发布契约

- `queue.ts` 是主进程和 worker 的唯一入队实现。只合并 queued；running 的更新请求必须持久化后续任务。合并用 `status + payloadJson` CAS；领取竞态时创建独立后续任务。知识资料 payload 的 `sourceVersionId` 绑定产生它的版本；旧生产者不得覆盖当前 queued 自定义分块。
- `source/` 拥有 source DB 查询、预分块校验、候选分块装配，不拥有任务状态或外部向量写入。源版本不匹配时不能把旧 preChunks 与新正文拼接。
- `persistence/` 拥有本地分块与 Qdrant 的发布协议。先以 `indexedAt=null` 保存全部待写 ID；向量全部成功后，在 DB 事务内发布新 ID 并撤下旧 ID；最后向量删除成功才删除本地旧行。
- 外部部分写入失败或清理失败必须抛回 worker，使用持久任务的有界重试；达到上限后可从失败任务/重建入口恢复。旧行与未发布行不得丢弃，它们也是外部清理的持久依据。
- 检索通过 `retrieval/` 批量检查 ID 已发布；知识资料还必须匹配当前 `activeVersionId` 且未归档。Qdrant 中残留的旧点不能进入上下文。
- `documentStatus.ts` 只把实际索引版本完成投影到对应文档版本；版本已变化时补排追赶，待处理后续任务保持 queued/running。

主进程只使用 `indexing/index.ts` 的轻量入口；source 与 persistence 通过各自 facade 由 worker 索引编排调用，不导出到轻量主进程 barrel。
