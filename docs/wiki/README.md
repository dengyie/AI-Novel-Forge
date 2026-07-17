# 项目开发 Wiki

本目录用于沉淀长期项目知识，帮助未来开发者和 AI Agent 理解项目为什么这样设计，以及后续应该如何维护。

Wiki 不记录单次提交改了什么，也不替代 release notes。它只记录跨阶段仍然有用的架构规则、工作流边界、运行协议、调试经验和产品设计依据。

## 使用方式

- 先从本页找到相关主题，再进入对应分类页面。
- 如果页面内容来自历史计划、设计文档或检查点，保留来源链接，不搬空原文档。
- 如果一次开发澄清了长期规则，应更新对应 Wiki；如果只是小改动或发布流水账，不写 Wiki。
- 新页面默认使用 [entry-template.md](./entry-template.md) 的结构。

## 目录

### Architecture

- [模块边界与文档治理](./architecture/module-boundaries.md)
- [章节身份与规划边界](./architecture/chapter-identity-and-planning-boundary.md)
- [章节运行时边界](./architecture/chapter-runtime-boundaries.md)
- [配置项归属与可见性规范](./architecture/configuration-conventions.md)
- [Drama Forge 模块边界](./architecture/drama-forge-module-boundary.md)
- [事件副作用边界](./architecture/event-side-effect-boundaries.md)
- [图片生成 Provider](./architecture/image-generation-providers.md)
- [模型选择与厂商默认模型边界](./architecture/model-selection.md)
- [Novel 应用服务层](./architecture/novel-application-services.md)
- [读路径性能边界](./architecture/read-path-performance-boundaries.md)
- [服务架构迁移计划](./architecture/server-architecture-migration-plan.md)
- [World Context Gateway](./architecture/world-context-gateway.md)
- [世界可视化资产](./architecture/world-visualization-assets.md)

### Workflows

- [自动导演 Runtime 与恢复边界](./workflows/auto-director-runtime.md)
- [自动导演候选自动确认](./workflows/auto-director-candidate-auto-confirm.md)
- [自动导演阶段清单](./workflows/auto-director-stage-checklist.md)
- [自动导演世界搭建](./workflows/auto-director-world-setup.md)
- [章节生产链路](./workflows/chapter-production-chain.md)
- [角色资源账本工作流](./workflows/character-resource-ledger.md)
- [拆书工作流](./workflows/book-analysis-workflow.md)
- [图片生成确认与统一运行时](./workflows/image-generation-confirmation-runtime.md)
- [Creative Hub 边界](./workflows/creative-hub-boundary.md)
- [小说有声书边界](./workflows/novel-audiobook-boundary.md)
- [小说封面图生成](./workflows/novel-cover-image-generation.md)
- [小说事实账本](./workflows/novel-fact-ledger.md)
- [小说快照保留](./workflows/novel-snapshot-retention.md)
- [待审核提案自动放行](./workflows/pending-review-auto-promotion.md)
- [质量债归因](./workflows/quality-debt-attribution.md)
- [懒加载章节规划](./workflows/lazy-chapter-planning.md)
- [时间线约束层](./workflows/timeline-constraint-layer.md)
- [短剧工作区](./workflows/short-drama-workspace.md)
- [漫画面板生产提示治理](./workflows/comic-panel-production-prompt-governance.md)
- [漫画场景一致性](./workflows/comic-scene-consistency.md)
- [漫画角色资产管线](./workflows/comic-character-asset-pipeline.md)
- [桌面发布版本号规则](./workflows/desktop-release-versioning.md)

### Prompts

- [Prompt Registry 与结构化输出](./prompts/prompt-registry-and-structured-output.md)
- [小说生成质量护栏](./prompts/novel-generation-quality-guards.md)

### RAG

- [知识库与上下文组装](./rag/knowledge-and-context-assembly.md)

### Debugging

- [重复故障模式与排查路径](./debugging/recurring-failure-modes.md)
- [角色连续性硬事实](./debugging/character-continuity-hard-facts.md)
- [LLM 请求限流器内存泄漏](./debugging/llm-request-limiter-memory-leak.md)
- [日志保留策略](./debugging/log-retention.md)
- [开发踩坑知识沉淀](./debugging/development-knowledge.md)（13 条生产根因与修复教训）

### Product

- [新手优先与整本小说完成原则](./product/beginner-first-novel-completion.md)
- [世界骨架生成](./product/world-skeleton-generation.md)
- [设置就绪](./product/settings-readiness.md)
- [GitHub 介绍站](./product/github-intro-site.md)

### 其他

- [Wiki 条目模板](./entry-template.md)
- [Assistant-UI Store 版本钉扎](./assistant-ui-store-tap-pin.md)（依赖钉扎实证笔记）

## 写作边界

Wiki 应写：

- 长期架构决策和原因。
- 自动导演、章节生产、Creative Hub、Prompt、RAG、任务状态等核心链路的边界。
- 可重复使用的调试结论和排查路径。
- 新手优先、整本完成、低认知负担等产品原则如何影响实现。

Wiki 不应写：

- 单次提交的文件修改清单。
- 临时 TODO。
- 发布说明复制。
- 很快会废弃的实现细节。
- 只描述“本次改了什么”的流水账。

## 与其他 docs 目录的关系

- `docs/wiki/`：稳定知识和原因。
- `docs/plans/`：仍有执行价值的方案和任务拆解。
- `docs/checkpoints/`：阶段性进度、迁移里程碑和审计记录。
- `docs/design/`：系统设计、领域模型和产品机制。
- `docs/releases/`：用户可见更新历史。
- `README.md`：对外入口和最新公开摘要。
