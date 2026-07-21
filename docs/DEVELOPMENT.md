# AI-Novel 开发文档总入口

本文件是开发文档的**导航门面**：从这进入，快速到达任意模块的权威文档。
详细治理约定见 [`./README.md`](./README.md)；模块架构总入口见 [`./wiki/README.md`](./wiki/README.md)。

> **本仓 `docs/` 只覆盖工程开发**。私有运维与生产拓扑不在本开源仓库维护。

---

## 一、项目定位

- **形态**：pnpm monorepo（`@ai-novel/*`，AGPL-3.0，Node ≥20.19，pnpm 10.6）
- **职责**：长篇小说自动化生产平台 —— 书级方向 → 卷战略 → 拆章 → 章节生成 → 质量门 → 修复 → 审核，跑成可监管的导演（director）流水线
- **部署**：自托管；通过 `.env` 配置 LLM `*_BASE_URL` / API Key、数据库与存储路径

## 二、快速上手

```bash
# 依赖（Node /opt/node-v20.20.2-linux-x64，pnpm 10.6，npmmirror 镜像）
pnpm install --frozen-lockfile
pnpm --filter @ai-novel/shared build        # shared 必须先 build，server/client 依赖其 dist
pnpm --filter @ai-novel/server prisma:generate
pnpm dev                # concurrently 起 shared/server/client
pnpm typecheck          # shared build + server/client/desktop typecheck
pnpm test               # server 测试（node:test，约 291 个）
pnpm test:client        # client 测试
pnpm test:all           # 全量
pnpm build              # shared + server + client 构建
```

## 三、模块架构

入口 → [`./wiki/README.md`](./wiki/README.md)（按 architecture / workflows / product / prompts / rag / debugging 分组）。

核心子系统：
- `shared/types/*`（60 个类型文件）+ `shared/utils/*`：跨端契约，质量门纯函数在这
- `server/src/services/novel/`：novel 业务心脏（director / volume / quality / chapter / character）
- `server/src/prisma/schema.prisma`：142 个 model
- `client/src/pages/novels/`：概念页与编辑器（React + Vite + Plate）

## 四、当前推进中计划

`docs/plans/`（已落地计划已清理，活跃计划分两组）：

主线推进：

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
- [Codebase Audit Remediation Plan](./plans/codebase-audit-remediation-plan.md)（2026-07-18 全面审查整改：C1 文件规模/C2 RAG 配置泄漏/C3 director 根收敛/C4 routes 迁移/C5-C7 文档失真 + P-A–P-F 合规防回归 + R12/R13/G5/G6 待审）

有声书 / 音色库工作流（main 上，生产 tip **`0b776e6`**：A/B/C/Harden/D/**E/F/G + heardSha** 代码已交付；approve token live；听感/浏览器 UI 仍 Manual）：

- [全站音色库 + AI 规划调研（SoT 摘要）](./plans/audiobook-sitewide-voice-library-research.md)
- [音色库运营与 AI 规划 D–G](./plans/audiobook-voice-library-ops-and-ai-plan.md)（delivered code · D 库管理台 · E 人耳 approve · F setStatus 门禁 · G LLM redesign · §七点四十九）
- [全 AI 音色匹配 + AI 耳升权](./plans/audiobook-ai-voice-match-auto-ear-plan.md)（M1–M4 代码 · Ear v2 / LabelAgent / VoiceBrief / prefer_library_ai / library_ai_fill · **未**生产 cutover）
- [Audiobook Segment Delivery Style](./plans/audiobook-segment-delivery-style-plan.md)
- [Audiobook Character Voice Differentiation](./plans/audiobook-character-voice-differentiation-plan.md)
- [Audiobook Mimo TTS Multi Backend](./plans/audiobook-mimo-tts-multi-backend-plan.md)
- [Audiobook Workbench UX Optimization](./plans/audiobook-workbench-ux-optimization-plan.md)
- [Audiobook Workbench Voice Readiness](./plans/audiobook-workbench-voice-readiness-plan.md)
- [Audiobook Voice-Diff Ops Hardening](./plans/audiobook-voice-diff-ops-hardening-plan.md)
- [Audiobook Listen Usability P0](./plans/audiobook-listen-usability-p0-plan.md)
- [Audiobook Design Prompt Quality](./plans/audiobook-design-prompt-quality-plan.md)
- [Character Voice Preview Asset](./plans/character-voice-preview-asset-plan.md)

## 五、开发踩坑知识

→ [`./wiki/debugging/development-knowledge.md`](./wiki/debugging/development-knowledge.md)（13 条生产根因与修复教训）

其他调试参考：[`./wiki/debugging/`](./wiki/debugging/) 下重复故障模式、LLM 限流泄漏、日志保留、角色连续性硬事实。

## 六、设计稿（PRD）

`docs/design/`（8 份）：

- [产品 UI 设计系统](./design/product-ui-design-system.md)
- [Style Engine v1](./design/style-engine-v1.md)
- [Style Engine Prompt Compiler v1](./design/style-engine-prompt-compiler-v1.md)
- [Style Engine Boundary and PRD v2](./design/style-engine-boundary-prd-v2.md)
- [Visualization Stack](./design/visualization-stack.md)
- [World Management v2](./design/world-management-v2.md)
- [World Story Interface v1](./design/world-story-interface-v1.md)
- [Anti-AI Humanizer Integration v1](./design/anti-ai-humanizer-integration-v1.md)

## 七、历史节点 / 审计

`docs/checkpoints/`（5 份）：

- [Chapter Editor V2 Progress](./checkpoints/chapter-editor-v2-progress.md)
- [LLM Schema Refactor Checkpoint](./checkpoints/llm-schema-refactor-checkpoint.md)
- [LLM Structured DeepSeek CPA Review](./checkpoints/llm-structured-deepseek-cpa-review.md)
- [Prompt Governance Audit 2026-05-08](./checkpoints/prompt-governance-audit-2026-05-08.md)
- [Windows Desktop Installer Manual Checklist](./checkpoints/windows-desktop-installer-manual-checklist.md)

横切工程约定：[`./architecture/testing.md`](./architecture/testing.md)

## 八、已归档（过期 / 历史）

`docs/archive/`：

- [Project Init Spec](./archive/project-init-spec.md) —— 2024 项目初始化方案（历史）
- [Outdated Docs Index](./archive/outdated/README.md) —— 被当前发布事实取代的归档清单

> 有声书 / 音色库计划不在归档区；**D–G 代码已交付**（tip `0b776e6`），见上方「四、当前推进中计划」。后续听感 Manual / QFP / P2 不自动开里程碑。

## 九、运维边界（非本仓）

- 生产部署、备份、监管协议、卷二全卷监管授权 —— **vault**，入口 `00.MOC/AI-DOC-ROUTER.md`
- 仓库 `docs/` 不复制运维事实，改 vault 后在 vault 根跑 `python3 .local/bin/scan-stale-docs`

## 十、其他目录（不纳入 docs 治理）

- `docs/public/`：对外介绍与模块手册（落地页素材，非开发参考）
- `docs/releases/release-notes.md`：用户可见更新历史（1727 行，独立维护）
- `docs/superpowers/`：superpowers 技能生成的执行计划产物
- `docs/humanizer-reference/`：外部 `blader/humanizer` skill v2.8.2 副本（非本项目自有）
- `docs/voice-packs/`：音频种子资产（wav + manifest），非文档

---

## Backlog：文档治理发现的代码不一致（本轮不改代码，仅记录）

| 项 | 现象 | 来源 |
|---|---|---|
| RAG ownerTypes 边界 | `wiki/rag/knowledge-and-context-assembly.md` 称 ownerTypes 为硬范围，已复核 `HybridRetrievalService.retrieve()` 在 ownerTypes 仅含 knowledge_document 时 `baseScope=null` 跳过非知识召回，仅查知识库文档（硬剪枝、不回退全局）——与 wiki 一致（`7070ea0` 复核） | 判活对照 |
| chapter-editor-v2 进度 | `checkpoints/chapter-editor-v2-progress.md` Phase 3/4 进度数据需核实是否仍推进 | 节点审计 |
