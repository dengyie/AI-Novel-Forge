# 知识库与上下文组装

## 背景

长篇小说生产需要长期记忆：世界观、角色、拆书结果、知识库文档、写法资产、章节历史和连续性状态都可能影响后续规划与正文。早期如果每个模块各自上传、索引、检索或拼接上下文，会造成重复向量化、检索范围不一致和 prompt 输入不可审计。

知识库和 Context Broker 的目标是让资料成为可复用资产，并让每次 AI 调用明确知道自己使用了哪些上下文、丢弃了哪些上下文、为什么丢弃。

## 决策

知识库文档是长期资料资产，不是一次性上传输入。RAG 检索、绑定资料和上下文组装应通过统一服务和 Context Resolver 处理，Prompt 模板不直接查数据库。

默认检索规则遵循“显式选择优先、绑定资料次之、全局启用文档兜底”，同时保留业务实体自身的内部上下文。若业务调用显式限定 `ownerTypes`，检索服务必须尊重该范围；未包含 `knowledge_document` 时，不得自动混入知识库文档。

## 当前规则

- `知识库` 是向量化资料的独立管理入口，负责文档、版本、索引任务、健康状态和 Embedding/RAG 配置。
- 上传资料应形成 `KnowledgeDocument` 和版本概念；在线检索只针对当前激活版本。
- 归档知识文档是可恢复状态，不删除 `KnowledgeDocumentVersion` 原文；归档会移出默认检索、资料选择和拆书入口，并排队清理已有分块。
- 归档文档恢复启用时必须排队重建索引。只有恢复后的重建任务成功，召回测试和 RAG 检索才应重新使用该文档。
- 小说或世界观存在绑定知识文档时，相关生成链路优先使用绑定文档。
- 用户显式传入 `knowledgeDocumentIds` 时，只检索这些文档。
- 没有显式选择且没有绑定时，可搜索所有启用知识库文档。
- 业务调用显式传入 `ownerTypes` 时，`ownerTypes` 是硬范围。只有未传 `ownerTypes`、显式包含 `knowledge_document`，或显式传入 `knowledgeDocumentIds` 时，知识库文档才参与检索。
- 小说/世界观自身的 RAG 内容仍保留，并与知识库检索结果融合排序。
- 拆书发布文档可以携带结构化预分块 `preChunks`。这些分块必须把 `structuredData` 里的题材、卖点、目标读者、优势、短板、人物功能和章节锚点转成统一 facet，字段名只能使用 `genreTags / sellingPointTags / targetReaders / strengths / weaknesses / characterRole / chapterAnchor`。
- `KnowledgeChunk.metadataJson` 记录 facet 和 anchor 原始结构；`KnowledgeChunk.facetKeys` 记录可过滤的 `|key=value|` 文本；`KnowledgeChunk.chapterAnchor` 记录章节序号字符串。Qdrant payload 与本地 chunk 元数据必须使用同一组 facet 字段名，避免向量过滤和关键词过滤分叉。
- 下游需要按拆书维度精确召回时，应优先调用 `HybridRetrievalService.retrieveByFacet({ query, facets, ...scope })`，而不是在各业务服务里手写 `facetKeys` 过滤条件。facet 命中为空时，检索服务保留无 facet 回退，避免历史 chunk 因缺少 facet 而完全不可召回。
- `HybridRetrievalService.retrieve({ facets })` 应同时把 facet 过滤传给向量检索和关键词检索。老 chunk 没有 facet 时，带 facet 的检索可能为空；此时必须回退到无 facet 过滤的召回，保证旧资料不会被完全屏蔽。
- RAG 召回应按采样率写入 `RagRetrievalTrace`，用于后续诊断召回质量。trace 只保存 query digest、按配置截断的 query preview、检索范围、候选数量、最终 hits 摘要、各阶段耗时和 fallback / reranker 标记；hits 只能保存 chunkId、rank、score、owner，不保存 chunk 正文。
- 召回 trace 的 query 持久化由 `RAG_RETRIEVAL_TRACE_QUERY_PERSIST_MODE` 控制，生产环境可切到 `digest_only` 降低原文泄露风险。采样率与保留周期以 AppSetting 为运行时唯一真源：`rag.retrievalTraceSampleRate`（0–1）与 `rag.retrievalTraceRetentionDays`（1–365），通过前端「知识库 → 设置」面板修改；同名 env 仅在首次启动时把旧部署值种子进 AppSetting，之后一般不再读取。过期数据由 `RagRetrievalTraceRetention` 清理。
- Prompt 模板只声明需要哪些上下文；Context Broker / Resolver 负责读取、预算、过滤、摘要和组装。
- RAG 与上下文组装的失败要在 preview 或 trace 中可解释，不能静默丢 required context。

## 示例

推荐做法：

- 世界观向导允许直传 txt，也允许选择已有知识库文档；创建后把选择写入世界绑定。
- 小说生成时读取小说绑定知识文档、内部世界观和章节历史，再按预算组装上下文块。
- Prompt Preview 展示选中块、丢弃块、缺失 required group 和 resolver error。

禁止做法：

- 每个生成服务单独拼“如果有文档就搜文档，否则搜全局”的规则。
- PromptAsset 的 `render()` 内直接查数据库。
- 上传同一资料后让多个模块各自保存一份不可追踪文本。

## 失败模式

- 检索结果不符合当前小说：检查是否有显式文档筛选或小说/世界绑定覆盖了全局默认。
- 世界观分层生成混入无关小说文档：检查调用方是否只需要 `world` / `world_library_item`，以及 RAG 服务是否错误忽略了显式 `ownerTypes` 范围。
- Prompt 输入过大：检查 Context Broker 的预算、摘要和 dropped block 记录。
- 知识库健康正常但生成没引用资料：检查 resolver 是否接入当前 workflow、prompt 是否声明 context requirement。
- 旧版本内容仍被检索：检查激活版本和 chunk rebuild 是否对齐。
- 归档文档恢复后无法召回：检查恢复动作是否把索引状态置为 `queued`，以及对应重建任务是否成功完成。
- facet 检索完全无结果：先检查发布时的 `preChunks` 是否进入 RAG job payload，再检查 `KnowledgeChunk.facetKeys` 和 Qdrant payload 是否都写入同一 facet 字段；如果是历史 chunk 没有 facet，应确认检索服务触发无 facet 回退。
- 拆书发布后结构化结论召回不准：检查 `bookAnalysis.publish.facets` 的字段映射是否把结构化字段映射到正确 facet，不要在消费方临时发明新的 facet 名。
- 召回质量难以复盘：检查 AppSetting `rag.retrievalTraceSampleRate` 是否为 0、`RagRetrievalTrace` 是否有近期记录、`timingsJson` 是否包含 vector / keyword / fusion / reranker / decay / total 六项，以及 facet 命中为空时 `fallbackTriggered` 是否写为 true。
- trace 中 `rerankerMs` 恒为 0、`rerankerUsed` 恒为 false：这是 reranker 阶段尚未接入前的预留语义，不代表 reranker 失败；接入交叉编码器重排后会回填。
- 历史 trace 数据无限增长：检查服务启动时是否调用了 `ragRetrievalTraceRetention.start()`，以及 AppSetting `rag.retrievalTraceRetentionDays` 是否设置合理。

## 运行时设置与 Worker 生命周期

RAG worker 在启动时读取一份运行时设置快照；设置页保存成功后，主进程必须先串行停止旧 worker，等待退出事件触发 running 任务恢复，再根据最新的 `ragConfig.enabled` 和待处理队列按需启动新 worker。不能只调用轮询唤醒，因为那只会让仍在运行的子进程继续使用旧的 Qdrant、Embedding、分块和并发参数。

设置保存的并发请求共享同一条 refresh 队列。刷新期间旧 worker 仍是唯一权威持有者，禁止在它收到停止信号但尚未退出时 fork 替代 worker；如果停止 deadline 先到，后续启动必须由退出处理和恢复流程接管。

相关回归范围：`RagWorkerManager` refresh/disable/stalled 状态转换、设置路由等待 refresh 后再入队，以及 enabled=false 时不重新拉起 worker。

## 索引版本追赶与发布边界

适用范围：知识资料版本变更、所有 owner 分块重建、向量/关键词召回、RAG 任务状态投影。

同一 owner 的 running 任务持有执行输入；新请求必须持久化排队，不能通过返回 running ID 表示已接收。queued 只在同一资料版本下合并，并使用状态与 payload CAS 处理 worker 领取和多生产者竞态。不同版本保持独立；`sourceVersionId` 绑定自定义 `preChunks` 的来源，过期请求不能覆盖较新资料的预分块。延迟请求入队时必须保留原始 `sourceVersionId`，禁止删除预分块后把旧请求改标为当前版本。worker 若发现请求版本已过期，应跳过写入；仅在当前版本既没有已发布分块、也没有 queued/running 请求时补排追赶，避免通用分块覆盖在途定制分块；当前版本已完成时不再重建覆盖其定制分块。完成依据必须是本地事务发布的分块版本，不能仅信任 `latestIndexStatus` 文本；新版本收口时只计算同版本待处理请求，较旧版本的退避重试不能把它投影回 queued。

`indexedSourceVersionId` 记录本次实际索引版本。文档成功状态必须通过 `activeVersionId` 条件写入；有后续 queued/running 请求时保留待处理状态。归档文档不接受旧 rebuild 的成功投影。

分块跨 DB 与 Qdrant 无法使用单一事务，因此 `KnowledgeChunk.indexedAt` 同时是发布标记：

1. 外部写入前先保存全部新分块 ID，`indexedAt=null`，即使部分向量写入失败也保留清理依据。
2. 向量全部成功后，在本地事务内为新分块设置 `indexedAt`，同时将旧分块置为 null。发布集合切换有原子性。
3. 先删除旧向量，成功后才删除本地旧行。失败必须抛回 worker，进入持久任务的有界重试。达到上限后任务保持失败，可重建恢复；不能吞错宣布完成或删除待清理 ID。
4. 向量和关键词召回都批量检查本地发布标记；知识资料还要匹配当前激活版本并排除归档。外部旧点残留或部分写入点不具备独立可见性。

这样外部清理故障影响的是重试进度，不会让旧资料重新进入写作上下文。不得通过只修 UI 状态、无限重试、清空向量集合或删除本地残留行来掩盖一致性问题。历史上已失去本地 ID 的外部孤儿点会被检索门禁拒绝；生产存量物理清理需要单独核验与备份，不能在请求路径猜测删除。

代码边界：轻量入队与状态投影在 `rag/indexing/`；源读取和候选装配在 `indexing/source/`；发布与清理协议在 `indexing/persistence/`；召回有效性检查在 `rag/retrieval/`。主进程不导入 worker 服务 barrel。

## 相关模块

- `server/src/services/rag/`
- `server/src/services/knowledge/`
- `server/src/services/bookAnalysis/bookAnalysis.publish.facets.ts`
- `server/src/services/novel/runtime/GenerationContextAssembler.ts`
- `server/src/prompting/`
- `client/src/pages/knowledge/`
- `client/src/pages/worlds/`
- `client/src/pages/novels/`

## 来源文档

- [知识库与向量化管理模块改造历史方案](../../archive/outdated/knowledge-module-plan-implemented-reference.md)
- [提示词工作台、上下文装配与统一步骤运行时方案](../../plans/prompt-workbench-context-and-step-runtime-plan.md)
- [README 当前能力说明](../../../README.md)
