# RAG Index Consistency Implementation Plan

**Goal:** 资料更新后追赶当前版本，外部向量写入或清理失败仍保留可重试依据。
**Architecture:** 轻量 queue 由 indexing 单一入口拥有；运行中任务使用不可变 payload，后续更新进入下一 queued 任务。索引 source 装配抽到 indexing/source，持久写入/清理抽到 indexing/persistence。知识资料召回校验当前 activeVersionId。
**Tech Stack:** TypeScript、Prisma、Node test、Qdrant。

## Constraints
- 主仓只读，独立 codex/review-fix-rag-index-consistency。
- 不改 schema、不迁移生产数据、不 push/merge/deploy。
- 不使用 UI 检验；代码级回归及 server build。

## Verification

最初3项回归失败：两个入口返回旧 running ID；向量清理失败没有抛错。实现后补充并发入队、过期版本、部分外部写入、发布门禁与恢复测试。最终命令和结果在提交报告中给出。

## Tasks
- [x] 在 server/tests/ragIndexConsistency.test.js 补主进程/worker 共用入队的 running 新请求、queued payload CAS、清理失败保留旧行、部分 upsert 失败保留全部 ID、版本完成投影和召回过滤测试。
- [x] 运行 `node --test server/tests/ragIndexConsistency.test.js` 取得 red。
- [x] 新建 indexing/queue.ts，使 running 不复用、queued 通过 status/payload CAS 合并；主进程仅导入轻量入口。
- [x] source/SourceDocumentAssembler.ts 拥有 DB source 查询和候选构建；RagIndexService 保留编排，少于700行。
- [x] persistence/ChunkReplacement.ts 在向量调用前持久化待写 chunk，所有删除严格先向量后DB，失败抛出，由持久 job 重试。
- [x] source/read版本写入job执行快照，终态投影 CAS current version；检索按活跃知识版本过滤旧 payload。
- [x] 重新 build，重跑新测试及 ragReindexLifecycle/ragProcessBoundary/worker 与检索相关回归。
- [x] 更新 indexing README、wiki、release notes、README 最新日期块，检查 diff，阶段 commit。

## 跟进验证：过期退避任务

- [x] 复现 v1 queued 退避、v2 定制分块发布并收口、v1 重试的完整状态时序。首提交实现会把 v2 投影为 queued。
- [x] 状态投影只计同版本 pending；追赶判断使用已发布分块版本，不信任状态文本。
- [x] 增加状态文字与发布事实不一致的测试，防止错误 succeeded 掩盖缺失索引。
- [x] server build 与 49 项定向回归通过。
