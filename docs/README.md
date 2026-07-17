# Docs 管理约定

`docs/` 用来承接根目录之外的设计文档、阶段检查点、模块计划和历史归档，避免方案文档继续散落在仓库根目录。

## 根目录保留规则

根目录只保留下面几类文件：

- 项目入口与对外说明：`README.md`
- 路线图与执行主清单：`TASK.md`
- 协作与工程约束：`AGENTS.md`
- Monorepo 与工具链配置：`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`.env.example`

其余设计稿、阶段总结、模块计划、历史规格，统一进入 `docs/` 对应子目录。

## 目录划分

### `docs/checkpoints`

用于记录阶段性检查点、架构迁移里程碑、进度审计和对照说明。

- [Chapter Editor V2 Progress](./checkpoints/chapter-editor-v2-progress.md)
- [LLM Schema Refactor Checkpoint](./checkpoints/llm-schema-refactor-checkpoint.md)
- [LLM Structured DeepSeek CPA Review](./checkpoints/llm-structured-deepseek-cpa-review.md)
- [Prompt Governance Audit 2026-05-08](./checkpoints/prompt-governance-audit-2026-05-08.md)
- [Windows Desktop Installer Manual Checklist](./checkpoints/windows-desktop-installer-manual-checklist.md)

### `docs/plans`

用于放仍有执行价值的模块计划、工作拆解和产品推进方案。**已落地计划已清理**，本目录只保留当前推进中的 ACTIVE 计划。

- [Director Self-Cycle P0 Review Fix](./plans/director-self-cycle-p0-review-fix.md)
- [Character System Upgrade](./plans/character-system-upgrade-plan.md)
- [Character Resource Ledger](./plans/character-resource-ledger-plan.md)
- [Book Analysis Expansion](./plans/book-analysis-expansion-plan.md)
- [Auto Director Creation Redesign](./plans/auto-director-creation-redesign-plan.md)
- [Drama Production Pipeline v3](./plans/drama-production-pipeline-v3.md)
- [Novel to Short-Drama Adaptation](./plans/novel-to-shortdrama-adaptation-plan.md)
- [Imitation Writing and Chain Hardening](./plans/imitation-writing-and-chain-hardening-plan.md)
- [Assistant UI Plan](./plans/assistant-ui-plan.md)
- [AI Comic Adaptation](./plans/ai-comic-adaptation-plan.md)
- [AI Comic Product Design](./plans/ai-comic-product-design.md)
- [Codebase Audit Remediation Plan](./plans/codebase-audit-remediation-plan.md)（C1 文件规模/C2 配置泄漏/C3 director 根收敛/C4 routes 迁移/C5-C7 文档失真 + 6 项合规防回归 + 待审）

#### 有声书 / 音色库工作流（main 上活跃）

基线 `1b7078b`，Milestone A/B/C/Harden/D 已交付，E/F/G 在轨。详见 [SoT 摘要](./plans/audiobook-sitewide-voice-library-research.md) 与 [运营与 AI 规划 D–G](./plans/audiobook-voice-library-ops-and-ai-plan.md)。

- [全站音色库 + AI 规划调研（SoT 摘要）](./plans/audiobook-sitewide-voice-library-research.md)
- [音色库运营与 AI 规划 D–G](./plans/audiobook-voice-library-ops-and-ai-plan.md)（active · D 库管理台 · E 人耳 approve · F setStatus 门禁 · G LLM redesign）
- [Audiobook Segment Delivery Style](./plans/audiobook-segment-delivery-style-plan.md)
- [Audiobook Character Voice Differentiation](./plans/audiobook-character-voice-differentiation-plan.md)
- [Audiobook Mimo TTS Multi Backend](./plans/audiobook-mimo-tts-multi-backend-plan.md)
- [Audiobook Workbench UX Optimization](./plans/audiobook-workbench-ux-optimization-plan.md)
- [Audiobook Workbench Voice Readiness](./plans/audiobook-workbench-voice-readiness-plan.md)
- [Audiobook Voice-Diff Ops Hardening](./plans/audiobook-voice-diff-ops-hardening-plan.md)
- [Audiobook Listen Usability P0](./plans/audiobook-listen-usability-p0-plan.md)
- [Audiobook Design Prompt Quality](./plans/audiobook-design-prompt-quality-plan.md)
- [Character Voice Preview Asset](./plans/character-voice-preview-asset-plan.md)

### `docs/design`

用于放系统设计、模块接口、产品机制和领域建模说明。

- [产品 UI 总体设计系统](./design/product-ui-design-system.md)
- [Style Engine v1](./design/style-engine-v1.md)
- [Style Engine Prompt Compiler v1](./design/style-engine-prompt-compiler-v1.md)
- [Style Engine Boundary and PRD v2](./design/style-engine-boundary-prd-v2.md)
- [Visualization Stack](./design/visualization-stack.md)
- [World Management v2](./design/world-management-v2.md)
- [World Story Interface v1](./design/world-story-interface-v1.md)
- [Anti-AI Humanizer Integration v1](./design/anti-ai-humanizer-integration-v1.md)

### `docs/architecture`

承接横切架构说明与工程约定（不改变根目录对外入口）。

- [Backend testing](./architecture/testing.md)：后端 `node:test` 脚本的运行方式与目录约定。

### `docs/wiki`

用于沉淀长期项目知识，帮助未来开发者和 AI Agent 理解关键架构决策、工作流边界、运行协议、调试经验和产品设计依据。

Wiki 不替代计划、检查点或发布说明：

- `docs/wiki` 记录稳定规则和原因。
- `docs/plans` 记录仍有执行价值的方案和工作拆解。
- `docs/checkpoints` 记录阶段性状态、迁移里程碑和审计对照。
- `docs/design` 记录模块设计、领域建模和产品机制。
- `docs/releases` 记录用户可见变化。

完整索引见 [Wiki Index](./wiki/README.md)（按 architecture / workflows / product / prompts / rag / debugging 分组）。

### `docs/releases`

用于放完整的用户可见版本更新说明与发布历史；根 `README.md` 只保留最新一次更新，本目录负责承接完整历史。

- [Release Notes](./releases/release-notes.md)

### `docs/archive`

用于放历史初始化方案、已不再作为主执行依据但仍需要保留的资料。

- [Project Init Spec](./archive/project-init-spec.md) —— 2024 项目初始化方案
- [Outdated Docs Index](./archive/outdated/README.md) —— 被当前发布事实取代的归档清单

### 其他目录（不纳入 docs 治理，保留备查）

- `docs/public/`：对外介绍与模块手册（落地页素材）。
- `docs/superpowers/`：superpowers 技能生成的执行计划产物。
- `docs/humanizer-reference/`：外部 `blader/humanizer` skill v2.8.2 副本（非本项目自有）。
- `docs/voice-packs/`：音频种子资产（wav + manifest），属资产非文档。

### 开发导航

- [开发文档总入口 DEVELOPMENT.md](./DEVELOPMENT.md) —— 从这进入可导航到任意模块。

## 新文档命名规则

- 统一使用小写英文文件名，单词之间用 `-` 连接。
- 计划类文档优先放到 `docs/plans/`。
- 架构调整、进度校验、迁移检查点优先放到 `docs/checkpoints/`。
- 模块设计、数据模型、交互机制优先放到 `docs/design/`。
- 长期架构规则、工作流边界、调试经验和产品设计依据优先放到 `docs/wiki/`。
- 用户可见版本更新历史优先放到 `docs/releases/`。
- 已废弃、乱码、明显被当前发布事实取代但需要留档的方案放到 `docs/archive/outdated/`。

## 维护约束

- 新增文档时，先判断是否真的需要留在根目录；默认答案应当是“不需要”。
- 新增或修改核心工作流、Prompt、RAG、任务状态、自动导演、章节生产或重要调试结论时，先判断是否产生稳定 Wiki 价值。
- Wiki 页面应解释长期规则和原因，不写成文件修改列表、临时 TODO 或 release notes 复制品。
- 文档迁移后，如根 `README.md` 或其他入口文档里有引用，应同步更新路径。
- `TASK.md` 负责“当前主路线与优先级”，不替代设计文档；设计细节应沉到 `docs/`。
- 根 `README.md` 的更新说明只保留最新一次；完整历史统一维护在 `docs/releases/release-notes.md`。
