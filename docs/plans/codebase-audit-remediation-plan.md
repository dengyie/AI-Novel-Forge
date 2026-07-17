# 代码审查整改计划

> **来源**：`afbfd44` 合并主线后对 server/client/shared 的全面审查,见 plan 文件 `witty-hatching-whisper.md` 的完整审查报告。
> **任务**：把审查发现的 7 条合规违规(C1–C7)+ 6 条合规项(P-A–P-F)+ 6 项待深挖,落成可执行整改清单。每条给位置 / 根因 / 修复步骤 / 验证 / 风险。
> **状态**：`status: active` · 2026-07-18 · `分阶段推进,不一次开全部`
> **执行纪律**：本计划对应"已审已定性"。整改候选阶段如下,P1 必做,P2 可单个 milestone 内并行或独立微 commit,**P3 与 Backlog 进 backlog,不自动晋升**。修复内循环每阶段 ≤3 次,验收用 `pnpm typecheck && pnpm test --filter @ai-novel/server`。

### 推进状态（2026-07-18 更新）

| 阶段 | 状态 | 提交 | 说明 |
|---|---|---|---|
| 阶段 1 (C2) | ✅ 完成 | `eb185f7` | retrievalTrace 4 步迁完 + rag.ts 12 键 env 泄漏清零（见下方 C2 章节，超出原 14 键子集的纯常量清理由此一并落地）。typecheck + 5 项 RAG/boundary 测试绿。 |
| 阶段 2 (C5+C6+C7) | ✅ 完成 | `b57b0b0` `ac7f348` | 三处文档失真微提交；C6 复核为「无违规 / wiki 已正确」，HybridRetrievalService 加意图注释锁定硬剪枝语义。 |
| 阶段 3 (C3+C4) | ✅ 完成（实质合规 + 契约锁定） | `0f39825` | **未执行 `git mv`**：C3 三 shim 已符合 L31，3 个 historic 根文件受 `directorDirectoryBoundary.test.js` 精确文件名固定；C4 6 候选不在 wiki 强制迁移范围（styleEngine 等），均 <700 行预算内。改为 director/README.md + routes/README.md 契约锁定语义（含迁移前提：需同步更新测试断言）。 |
| 阶段 4 (C1) | ⏸️ 暂停 — Manual-required | — | **本阶段不开**：`novelAudiobookRoutes.ts` (1519 行) 与 `audiobookVoicePlanner.ts` (1494 行) 均在 audiobook E/F/G 在轨工作流（owner: dengyie，近 14 日 62 commits 横跨 phase-A/B/EFG/review）。按计划本节既定纪律（见下「关键纪律」与本阶段首句），拆分时点必须与 audiobook 责任人对齐，属 Manual-required。本会话不强行机械重构以免与在轨提交冲突。验证入口见下「C1 验证」。 |


## 阶段拆分

| 阶段 | 范围 | 风险 | 建议时机 |
|---|---|---|---|
| **阶段 1** | C2 配置泄漏修复(独立、低风险、纯 server 配置层) | 低 | 立即可开,P1 阻塞性质量债 |
| **阶段 2** | C5 + C7 + C6 三处文档失真纯文档微提交 | 极低 | 随阶段 1 顺手清,或独立 docs commit |
| **阶段 3** | C3 director 根目录收敛 + C4 routes 残余迁移 | 中(动 server 模块边界) | 需对齐 runtime/director 责任人 |
| **阶段 4** | C1 文件规模收缩(25 个 >700 行,优先 runtime/director 核心产出链) | 中-高(核心链路重构) | audiobook `novelAudiobookRoutes.ts` 必须在 E/F/G 节点间或之后立即拆 |
| **待审与 backlog** | R12/R13/G1–G6 调研入口 + 两项 ⚠️ 已澄清(见末节) | — | 不在本计划内自动执行 |

---

## 阶段 1：C2 配置泄漏修复（P1,低风险）

### 现状与根因

| 位置 | 现象 |
|---|---|
| `server/src/config/rag.ts:104,108,109,114,117-124,126,127` | `EMBEDDING_BATCH_SIZE` / `RAG_EMBEDDING_MAX_RETRIES` / `RAG_EMBEDDING_RETRY_BASE_MS` / `QDRANT_UPSERT_MAX_BYTES` / `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP` / `RAG_VECTOR_CANDIDATES` / `RAG_KEYWORD_CANDIDATES` / `RAG_FINAL_TOP_K` / `RAG_WORKER_POLL_MS` / `RAG_WORKER_MAX_ATTEMPTS` / `RAG_WORKER_RETRY_BASE_MS` / `RAG_RETRIEVAL_TRACE_SAMPLE_RATE` / `RAG_RETRIEVAL_TRACE_RETENTION_DAYS` 共 ~14 个调优参数 `asInt(process.env.X, …)` 直读 env |
| `server/src/services/settings/ragSettingKeys.ts:7,9,10` | **`RAG_EMBEDDING_BATCH_SIZE_KEY`、`RAG_EMBEDDING_MAX_RETRIES_KEY`、`RAG_EMBEDDING_RETRY_BASE_MS_KEY` 的 KEY 已定义** |
| `server/src/config/rag.ts:105` 注释 + `RagSettingsService.ts:165,294,371` | `EMBEDDING_CONCURRENCY` 已正确迁 AppSetting 的完整范式参考 |

**根因升级**：审查报告原文判 "约 18 个全新未做",复核后修正为——**`EMBEDDING_BATCH_SIZE / MAX_RETRIES / RETRY_BASE_MS` 三项 KEY 已声明但在 `config/rag.ts` 仍未切到 AppSetting,属"迁移做了一半";其余 ~11 项 KEY 未声明、env 直读属"完全未做"**。修复成本相应降低。

违反规则：`docs/wiki/architecture/configuration-conventions.md:53-57` 业务调优参数(并发/批大小/采样率/阈值/retry/退避)禁止走 env,必须 AppSetting。该 wiki L11-18 自陈事故模式——"用户感不到、长跑 dev server 滞留、多实例 env 分裂"——会持续制造生产感知与实际行为分裂。

### 修复步骤(每项按 embeddingConcurrency 范式四步)

按 `docs/wiki/architecture/configuration-conventions.md:36-43` 的"新增配置项必做四步":

1. **后端 KEY 常量**:在 `server/src/services/settings/ragSettingKeys.ts` 声明 `RAG_*_SETTING_KEYS` 数组(已声明的 3 个跳过)。
2. **后端加载/保存**:`RagSettingsService.ts` 在 type / `applyRuntimeSettings` / `getDefaultSettings` / `get*Settings` / `save*Settings` / `upsert` 列表**五处**都加字段(`RagSettingsService.ts:46/61/192/294/371` 是 `embeddingConcurrency` 的对应模板)。**关键**:`ragConfig` 内存对象保留字段但禁止 `process.env` 直读;`config/rag.ts` 改成纯默认值常量(如 `embeddingBatchSize: 64`)。
3. **后端路由 schema**:`server/src/routes/settings.ts` 的 RAG zod schema 加字段,PUT handler 透传到 service。
4. **前端 UI**(三处):`client/src/api/settings.ts`(`*Status` 类型 + `save*Settings` payload + `Pick<>` 返回)、对应 Page.tsx(`useState` 初值 + load `useEffect` + save `onSuccess` + mutate handler)、对应 `*SettingsCard.tsx` 加 `<Input>` 控件配文字说明。

**逐项清单**(按可独立上线先后排):

| 序 | env key | AppSetting key 建议 | 备注 |
|---|---|---|---|
| C2-1 | `EMBEDDING_BATCH_SIZE` | `rag.embeddingBatchSize` | KEY(:7)已声明,只需切 config + 补 service 五处 + zod + 客户端 |
| C2-2 | `RAG_EMBEDDING_MAX_RETRIES` | `rag.embeddingMaxRetries` | KEY(:9)已声明,同上 |
| C2-3 | `RAG_EMBEDDING_RETRY_BASE_MS` | `rag.embeddingRetryBaseMs` | KEY(:10)已声明,同上 |
| C2-4 | `RAG_CHUNK_SIZE` | `rag.chunkSize` | 全四步都要做 |
| C2-5 | `RAG_CHUNK_OVERLAP` | `rag.chunkOverlap` | 全四步 |
| C2-6 | `RAG_VECTOR_CANDIDATES` | `rag.vectorCandidates` | 全四步 |
| C2-7 | `RAG_KEYWORD_CANDIDATES` | `rag.keywordCandidates` | 全四步 |
| C2-8 | `RAG_FINAL_TOP_K` | `rag.finalTopK` | 全四步 |
| C2-9 | `RAG_WORKER_POLL_MS` | `rag.workerPollMs` | "仅启动期需"边界模糊,但 wiki 明列"业务调优"含 worker polling → 入面板 |
| C2-10 | `RAG_WORKER_MAX_ATTEMPTS` | `rag.workerMaxAttempts` | retry 次数,wiki 明列禁止 env |
| C2-11 | `RAG_WORKER_RETRY_BASE_MS` | `rag.workerRetryBaseMs` | 退避时间,同上 |
| C2-12 | `RAG_RETRIEVAL_TRACE_SAMPLE_RATE` | `rag.retrievalTraceSampleRate` | 采样率,同上 |
| C2-13 | `RAG_RETRIEVAL_TRACE_RETENTION_DAYS` | `rag.retrievalTraceRetentionDays` | 调优相关,入面板 |
| C2-14 | `QDRANT_UPSERT_MAX_BYTES` | `rag.qdrantUpsertMaxBytes` | 已存在 `RagCompatibilityBootstrapService.ts:121` 兼容回写路径,迁 AppSetting 后保留 env 作为首次启动兜底 |

**taskRetention 三项**(`config/taskRetention.ts:12-18` `TASK_RETENTION_KEEP_PER_NOVEL / SUCCEEDED_DAYS / FAILED_DAYS / SUPERSEDED_MIN_AGE_MS`)同期或单独小 milestone 处理——它们更像运维保留策略,可走 settings 面板"任务保留"分区;wiki 未禁止 task-retention 走 env,但属"用户在为什么慢时可能想调"的边界,L57 倾向迁面板,可作为 P2 进入阶段 1 子项或留 backlog。

### 验证

- `grep -n "process.env\." server/src/config/rag.ts server/src/config/taskRetention.ts` 应只剩 `DATABASE_URL / PORT / NODE_ENV / QDRANT_COLLECTION / QDRANT_URL / OPENAI_API_KEY / EMBEDDING_PROVIDER / EMBEDDING_MODEL / SILICONFLOW_EMBEDDING_MODEL / *_TIMEOUT_MS` 等 deploy/credential 类(c2-1..14 全部消失)。
- `pnpm typecheck` 绿。
- `pnpm test --filter @ai-novel/server` 绿(`server/tests/rag*` / `RagSettingsService` 相关单测若断言 env 读取,需同步改测。
- 启动 dev server 后在设置面板改 `embeddingBatchSize` → 确认写 `AppSetting` 表 + `ragConfig` 内存对象刷新,无需重启。

### 风险

| ID | 风险 | 缓解 |
|---|---|---|
| C2-R1 | 五处 service 字段漏加一处,导致保存不往返 | 以 `embeddingConcurrency` 的 `RagSettingsService.ts:46/61/192/294/371` 为模板逐处对照;单测 `RagSettingsService` round-trip |
| C2-R2 | 客户端 Card 默认值与 server `getDefaultSettings` 不一致 | 默认值抽到 `shared/utils/ragDefaults.ts` 或同步常量,client/server 共用 |
| C2-R3 | 迁移期老 env 仍存在,与面板值打架 | wiki L100-104 模式:`AppSetting` 命中优先,env 仅首次启动兜底;`RagCompatibilityBootstrapService` 已是这套机制 |
| C2-R4 | zod min/max 上限与 server `asInt` clamp 不一致,两侧分歧 | 两边用同一组上限常量(放 `shared/`),两侧 import |

---

## 阶段 2：C5 + C6 + C7 文档失真微提交（P2/P3,极低风险）

### C5 — `module-boundaries.md` 悬空来源链

**现状**:对 `docs/wiki/architecture/module-boundaries.md:89-90` 仍引 `../plans/auto-director-execution-plane-isolation-plan.md` 与 `../plans/director-mode-module-state-refactor-checklist.md`,两文件已在文档聚拢轮(`afbfd44`)prune,链接断。

**修复**（替换片段中的 `./` / `../../` / `../../../` 均相对 `docs/wiki/architecture/module-boundaries.md`，不是相对本 plan；落地时直接覆写该文件的「来源文档」段）：

````markdown
## 来源文档

- [Docs 管理约定](../../README.md)
- [Novel Director 子系统](../../../server/src/services/novel/director/README.md)
- [Novel 应用能力层边界](./novel-application-services.md)
- [章节 Runtime 边界](./chapter-runtime-boundaries.md)
- [事件副作用边界](./event-side-effect-boundaries.md)

> 历史:本规则最初成文于 `auto-director-execution-plane-isolation-plan` 与 `director-mode-module-state-refactor-checklist`(见 git 历史 `7070ea0`),内容已并入本 wiki,原始 plan 清理。
````

### C6 — `knowledge-and-context-assembly.md` ownerTypes 软边界失真

**现证**:`server/src/services/rag/HybridRetrievalService.ts:263` 当 `ownerTypes` 指定但结果为空(`filteredBaseOwnerTypes.length === 0`)时回退全局 `baseScope`——软边界。wiki 写硬范围。

**修复方向二选一**(在进入修复前先与 RAG 责任人定方向):

- 方案 A(改文档更安全):wiki 改写为"ownerTypes 为软优先级:命中则用指定范围,指定范围空时回退全局,用于跨租户/跨 novel 知识时避免硬剪枝过死"。同步标 `HybridRetrievalService.ts:263` 的回退行为为有意为之,加注释说明。
- 方案 B(改代码):若产品决定 ownerTypes 应硬剪枝则改 `retrieve()` 不回退,改前需评估现有跨 novel 知识召回是否会断。
- **推荐方案 A**(除非有产品诉求要硬剪枝)。无论哪条,**wik 与代码必须一致**。

### C7 — 失效 backlog 撤销

**现证**:DEVELOPMENT.md backlog 表 `B2` 条目记"`novels.ts` 直接 import `@/prompting/ContextBroker`"——`server/src/routes/novels.ts` 已不存在,文件已迁 `server/src/modules/novel/http/novel.ts`,新位置及 `services/novel/application/` 均无 `prompting`/`ContextBroker` 直引。**违规已自愈**。

**修复**:删 `docs/DEVELOPMENT.md` Backlog 表中 `server.api → server.prompting 违规` 一行,或改写为"已自愈(`afbfd44` 聚拢复核确认),保留为历史注记"。

### 验证

- C5:三层门面链接体检脚本(聚拢轮同款 Python 检查器)对 `module-boundaries.md` 跑一次,0 broken。
- C6:wiki 与 `HybridRetrievalService.ts:263` 行为描述一致(人工对照)。
- C7:`grep -n "ContextBroker\|prompting" server/src/modules/novel/http/ server/src/services/novel/application/` 仍空(二次确认)。

### 风险
极低。纯文档改动,不碰代码。

---

## 阶段 3：C3 director 根目录收敛 + C4 routes 残余迁移（P2,中风险）

### C3 — `services/novel/director/` 根目录收敛

**现状**(`ls server/src/services/novel/director/`):根目录 7 个 `.ts` 文件
- `NovelDirectorService.ts(836行)` — 门面,**合规,保留**
- `DirectorStateStore.ts` / `DirectorStateReader.ts` / `DirectorStateCommitter.ts` —**应进 `state/`(该目录已存在)**
- `novelDirectorConfirmNodeAdapters.ts` — 确认节点适配,应进 `commands/`
- `NovelDirectorIdeaInspirationService.ts` — 创意灵感,应进 `phases/` 或 `commands/`(看其职责归属)
- `novelDirectorPipelineRuntime.ts(695行)` — 应进 `runtime/`

违反规则:`module-boundaries.md:31` "director/ 根目录只保留稳定门面和兼容桥接"。

**修复步骤**:

1. 用 `git mv` 逐个迁移(保留历史):
   ```bash
   git mv server/src/services/novel/director/DirectorStateStore.ts \
          server/src/services/novel/director/state/DirectorStateStore.ts
   # 同理 DirectorStateReader / DirectorStateCommitter → state/
   # novelDirectorConfirmNodeAdapters → commands/confirmNodeAdapters.ts
   # NovelDirectorIdeaInspirationService → phases/  或 commands/
   # novelDirectorPipelineRuntime → runtime/
   ```
2. 全仓修正 import 路径:`grep -rn "services/novel/director/(DirectorState|novelDirectorConfirm|NovelDirectorIdeaInspiration|novelDirectorPipelineRuntime)" server/src`,逐处改 import。
3. 更新 `services/novel/director/README.md` 反映新结构。

**验证**:`ls server/src/services/novel/director/*.ts` 应仅剩 `NovelDirectorService.ts`;`pnpm typecheck` 绿;`pnpm test --filter @ai-novel/server director` 相关绿。

### C4 — `routes/` 残余迁移

**现状**:`server/src/app.ts:29-34` 已正确挂载主链模块 `http/`(novel/drama/comic/export/director)——主链迁移 ✅。但 `server/src/routes/` 仍 23 个文件,其中可迁各模块 `http/`:

| routes/ 文件 | 建议归宿 |
|---|---|
| `styleEngine.ts` / `styleEngineExtraction.ts` | 风格引擎属 `services/styleEngine/`,建 `services/styleEngine/http/` 或并 `modules/styleEngine/http/` |
| `character.ts` | `modules/novel/characters/http/`(已存在) |
| `creativeHub.ts` | `modules/creativeHub/http/`(若有专用模块)否则留 routes |
| `knowledge.ts` | RAG 相关,`modules/rag/http/` 或留 routes(看 RAG 是否有模块目录) |
| `bookAnalysis.ts` | `modules/bookAnalysis/http/`(已存在) |
| `settings.ts` / `settingsAutoDirector.ts` | 可合进 `services/settings/http/` 或留 routes 作横切配置入口 |

违反规则:`module-boundaries.md:32` "routes/ 只保留尚未迁移的传统 HTTP 入口"。

**修复步骤**:`git mv` 迁移 → 修 `app.ts` import 路径 → 修跨仓引用。**逐模块迁,每次一个**,每迁一个跑一遍 typecheck + 对应测试。

**验证**:`server/src/routes/` 文件数下降;每个迁移点 `pnpm typecheck` + 对应模块测试绿。

### 风险
中。动 server 模块边界,import 路径全仓级变更,**需对齐 runtime/director 责任人**;C3 必须在收尾 audiobook E/F/G 之后做(audiobook 在轨,避免与其活跃改动冲突)。建议两子项独立 commit:`fix(director): collapse root to facade, move state/command/runtime`、`chore(routes): migrate styleEngine/character/knowledge/bookAnalysis to module http/`。

---

## 阶段 4：C1 文件规模收缩（P1,中-高风险,核心链路重构）

### 现状

`server/src/services/novel/` + `server/src/modules/` + `server/src/routes/` 下 **25 个文件 >700 行**,违反 `module-boundaries.md:20-21` "单文件接近 600 行评估职责,超过 700 行扩展前必须拆分"。(**复审**:wiki 阈值是扩展前才必须拆,即"该文件下次加新东西时必须先拆",不是"现存就违规"——故 25 个不全是 P0,但其中**正在 active 增长**的 audiobook 路由必拆,P1)。完整清单：

| 文件 | 行数 | 备注 |
|---|---|---|
| `modules/novel/production/http/novelAudiobookRoutes.ts` | 1519 | **37 个 route handler 单文件,audiobook E/F/G 在轨,2026-07-18 仍在改,P1 必拆** |
| `services/novel/director/automation/novelDirectorAutoExecutionRuntime.ts` | 1264 | |
| `services/novel/pipelineExecute.ts` | 1162 | 批执行主路径(P2-1 从 NovelCorePipelineService 拆出,见文件头注释);继续拆 |
| `modules/comic/http/comicRoutes.ts` | 1071 | |
| `services/novel/director/runtime/novelDirectorTakeover.ts` | 1063 | |
| `services/novel/runtime/ChapterArtifactDeltaService.ts` | 966 | |
| `services/novel/director/runtime/DirectorWorkspaceAnalyzer.ts` | 888 | |
| `services/novel/director/commands/DirectorCommandService.ts` | 869 | |
| `services/novel/runtime/proseQuality/ProseQualityDetector.ts` | 861 | 纯函数质门,逻辑密而非杂 |
| `services/novel/characterPrep/CharacterPreparationService.ts` | 845 | |
| `services/novel/director/workflowStepRuntime/directorExecutionStepModules.ts` | 842 | |
| `services/novel/director/NovelDirectorService.ts` | 836 | 门面,看是否能精简委派 |
| `services/novel/volume/volumeGenerationHelpers.ts` | 819 | |
| `services/novel/volume/NovelVolumeService.ts` | 812 | |
| `modules/drama/http/dramaRoutes.ts` | 799 | |
| `services/novel/director/runtime/novelDirectorTakeoverRuntime.ts` | 798 | |
| `services/novel/director/runtime/DirectorEventProjectionService.ts` | 777 | |
| `services/novel/dynamics/CharacterDynamicsMutationService.ts` | 775 | |
| `services/novel/runtime/GenerationContextAssembler.ts` | 768 | |
| `services/novel/runtime/chapterRuntimePipeline.ts` | 736 | |
| `services/novel/novelCorePipelineService.ts` | 730 | |
| `services/novel/novelCoreShared.ts` | 725 | 纯 helper 库,**属合理不拆**(单文件聚合 helper) |
| `services/novel/volume/volumeGenerationOrchestrator.ts` | 716 | |
| `services/novel/runtime/ChapterTimelineFinalizationService.ts` | 701 | |

(600–700 行档另 21 个文件不列入本计划,仅为观察项,触发阈值前不拆)

### P1 必拆项

**C1-a `novelAudiobookRoutes.ts` 1519 行拆分**:

按 37 个 route handler 的功能域分组,拆出 `modules/novel/production/http/audiobook/` 子目录,每子文件一组 handler:

| 子文件 | 包含 handler(按现有 route 路径分组) |
|---|---|
| `audiobook/bootstrap.routes.ts` | workspace bootstrap / overview |
| `audiobook/voicePlan.routes.ts` | voicePlan suggest / apply |
| `audiobook/preview.routes.ts` | character voice preview / generate / asset |
| `audiobook/readiness.routes.ts` | readiness prepare / summary / job errors |
| `audiobook/segment.routes.ts` | segment delivery + 听起来自然度相关 |
| `audiobook/mimo.routes.ts` | MIMO TTS multi-backend 相关 |
| `audiobook/workspace.routes.ts` | 其余 workspace 状态 |
| `audiobook/index.ts` | 单一 router 聚合,导入子文件,导出 `audiobookRouter` |

`app.ts` 改 import 指向 `audiobook/index.ts`。每个子文件 ≤300 行,**handler 不复制业务逻辑**——业务逻辑仍留在 `services/audiobook/*`,路由文件只做 HTTP 入参校验 + 调 service + 错误响应。

**关键纪律**:audiobook 在轨,拆分须**与 audiobook E/F/G 责任人对齐时点**,避免与 `791c64d`(今日 fix-phase-EFG)类提交冲突。建议在 E/F/G 阶段间或下一节点起步时拆。

### P2 可拆项(下次该文件再扩展前必拆)

按 wiki "扩展前必须拆"语义,以下文件下次加逻辑前必须先拆分:

- `novelDirectorAutoExecutionRuntime.ts`(1264) — 拆 automation phases / scheduling
- `pipelineExecute.ts`(1162) — 按 stage 拆章节准备 / 生成 / 质量评估 / 持久化
- `NovelDirectorService.ts`(836) — 门面委派;若委派链集中可下沉子服务
- `DirectorCommandService.ts`(869) — 按命令组拆(generate / refine / accept / patch)
- `directorExecutionStepModules.ts`(842) — 按 step 拆模块
- `ChapterArtifactDeltaService.ts`(966) — 按 delta 类型拆
- `DirectorWorkspaceAnalyzer.ts`(888) — 按分析维度拆

`novelCoreShared.ts`(725)、`ProseQualityDetector.ts`(861)属**合理单文件**(纯函数集合 / 高内聚质门),wiki 阈值本意"职责杂乱再扩展前拆",纯库不强行拆,只列观察项。

### 验证

- `wc -l` 各拆后子文件 ≤ 300;原大文件已删或剩聚合器。
- `pnpm typecheck && pnpm test --filter @ai-novel/server` 全绿。
- audiobook 端到端:启动 dev server,跑一遍 audiobook workspace bootstrap → voicePlan → preview → readiness,行为不变。

### 风险

| ID | 风险 | 缓解 |
|---|---|---|
| C1-R1 | 拆分动到 active 文件,与在轨 E/F/G 提交冲突 | 拆时点选 E/F/G 节点之间;拆前 `git status` 干净,拆不夹带业务改动 |
| C1-R2 | 拆分引 import 循环 | 子文件只 import service,不互引;聚合 index 单向 |
| C1-R3 | 拆分后 route 路径漂移(app.ts mount 改变 URL) | `index.ts` 聚合后导出同 router,mount 路径不变;回归测试覆盖关键 endpoint |
| C1-R4 | 核心产出链(`ChapterTimelineFinalizationService` / `chapterRuntimePipeline`)拆分引入回归 | 这两项在阶段 4 末尾做,配 regression test (`server/tests/chapterQualityLoop.test.js` 等) |

---

## 合规项(P-A – P-F):保持 + 防回归

审查确认的 6 项合规**不需修复**,但**应在 wiki 写入防回归监控点**,后续乱改时能立刻识别:

| 合规项 | 现状 | 防回归 |
|---|---|---|
| P-A 正文链唯一 | `ChapterRuntimeCoordinator + stage runner` 唯一入口 | grep 监控:任何 `routes/director/creativeHub` 中出现 `generateChapterBody`/`writeChapter`/`repairBody` 直实现 → 报警 |
| P-B timeline 表只由 `ChapterTimelineFinalizationService` 写 | `runtime/ChapterTimelineFinalizationService.ts:102` owner | grep 监控:timeline 模块外 `new ChapterTimeAnchor`/`StoryTimelineEvent.create` → 报警 |
| P-C NovelService facade 化 | `application/` 真组合根 | grep 监控:routes/workers 直引 `new NovelService` → 报警 |
| P-D EventBus 重活走持久队列 | `events/sideEffects/` job 模式 | review 门:新 handler 不许内联重活 |
| P-E `skip_quality_repair` 死门 | `novelDirectorContinueRuntime.ts:113-132` 等 | `server/tests/directorQualityRepairRisk.test.js` / `directorAutoExecutionQualityDebtGate.test.js` 守门,新增任何"映射为 skip"代码立即失败 |
| P-F embeddingConcurrency 配置范式 | `ragSettingKeys.ts:11` + `RagSettingsService.ts` 五处 | 作为 C2 阶段 1 的标准模板,不重复迁移此键 |

---

## 待深挖项(同等展开,但**不在本计划自动执行**,标记为复审核查)

### D1 ⚠️→已澄清:R2 唯一链疑虑

**原文疑点**:`pipelineExecute.ts(1162)`/`novelCorePipelineService.ts(730)`/`novelCoreShared.ts(725)` 与 `runtime/chapterRuntimePipeline` 并存,疑 legacy 与 runtime 链并存。

**复核结论**:**合规继续,疑虑撤销**。`pipelineExecute.ts` 文件头注释自陈"P2-1 从 NovelCorePipelineService 拆出,只搬不改契约,通过 host 注入避免循环依赖",是批执行主路径,经 stage runner。`novelCoreShared.ts` 是 runtime/repair/director 共用的纯 helper 库(被 `ChapterRuntimeCoordinator.ts:22` 等取 `RepairOptions`/`ReviewOptions`/`logPipelineError`),`novelCorePipelineService` 与 `NovelCoreService` 是 runtime 链上游组合,非 legacy 并存。**P-A 合规成立**,不动。

**但**:`pipelineExecute.ts(1162)` 仍进阶段 4 P2 可拆清单(下次扩展前拆)。

### D2 ⚠️ 客户端配置四步第 4 处未逐核

RAG 迁移范例在 server 侧已验证齐全(`ragSettingKeys` + `RagSettingsService` 五处),**客户端 `client/src/api/settings.ts` 的 `*Status` 类型 + `save*Settings` payload + `Pick<>` 返回三处,以及对应 Page.tsx 的 useState/useEffect/onSuccess/mutate 四处,与 `*SettingsCard.tsx` 的 Input 控件——对每个新迁的 env 键,这三处客户端落点必须同步加字段**。阶段 1 的逐项清单(C2-1..14)每项都隐含这步,client 适配漏做会让面板字段"看着在但保存串不到 server"。

**核实方法**:阶段 1 完成后,对每个新迁键运行客户端回归:改设置面板值 → 看网络请求 PUT payload 是否含该字段 → 看返回是否 round-trip 一致。

### D3 🔍 R9 修复耗尽 degraded finalization 复核

**复核结果**:`runtime/ChapterTimelineFinalizationService.ts:216,240,309,347,498` 有 `finalizeDegraded` 5 个分支;`runtime/ChapterContentFinalizationService.ts:347` 在 `finalizeCurrentContent` 调它——即修复耗尽 / 跳过路径**确实仍走 finalization**(degraded 形态)。`replan_required` 在 `quality/qualityDebtBoard.ts:230,522` 与 `director/recovery/*` 各处保持阻塞语义。

**结论**:R9 合规继续。**未深挖项撤销**。

### D4 🔍 R12 章节快照稳定态消费

`grep stableSnapshot/requireStable/isChapterStable` 空,可能命名不同。**空证据不下结论**。需在下一轮找到 snapshot 消费入口(可能是 `novelCoreSnapshotService.ts` 或 `NovelSnapshotService`,见 `services/novel/novelCoreSnapshotService.ts:3`),核实"回填/同步/抽取/索引刷新只消费稳定快照、不挂热路径"。

**调研入口**(下一轮单开):
```bash
# 找 snapshot 读取点
grep -rn "findChapterSnapshot\|getSnapshot\|snapshot.findUnique\|novelSnapshot" server/src --include="*.ts" | grep -vE "\.test\."
# 看每个读点是否在章节"仍可能修复/重写/回退"状态下被调用
```

### D5 🔍 R13 recover 读路径不写 run_resumed

`grep run_resumed.*publish/emit/create/update` 空——但可能写入点用别的 API(`prisma.eventRecord.create` 等)。**空证据不下结论**。

**调研入口**(下一轮单开):
```bash
# 找 run_resumed 写入点
grep -rn "run_resumed\|runResumed" server/src --include="*.ts" | grep -vE "\.test\."
# 区分哪些是"显式 recover/resume 执行流程"(允许写),哪些是"polling/preview/projection 读路径"(禁止写)
```

### D6 🔍 G1-G6 取证不足

- G1(event 重副作用走队列):架构层已合规(P-D),具体每个 handler 是否真走 `sideEffects/NovelSideEffectJobService` 未逐个核 
- G2(novel snapshot 只读):与 D4 合并调研
- G3(novel fact ledger 只读 / recover 读不写):与 D5 合并调研
- G4(NovelService facade):已合规(P-C)
- G5(read-path performance N+1):**未取样**——下一轮挑 3-4 个 GET handler(`listNovels / listChapters / getChapterDetail / listCharacters`)看 inline 是否有 N+1 prisma 调用
- G6(world context gateway facade):`runtime/ChapterRuntimeCoordinator` 与 generation 链是否经 `worldContext/WorldContextGateway.ts` 取世界上下文,未逐调用点核——`server/src/services/novel/worldContext/WorldContextGateway.ts` 存在,符合抽象,**逐调用点待审**

**D4/D5/G5/G6 复审**列为下一独立轮的审查子目标,不混入本整改计划。

---

## 总验证

每个阶段验收统一门槛:

```bash
cd /Users/mango/project/claude-project/AI-Novel-Writing-Assistant
pnpm --filter @ai-novel/shared build
pnpm typecheck          # shared + server + client + desktop
pnpm test               # server (node:test, ~291)
pnpm test:client        # client
pnpm test:all           # 合并
```

阶段 1/2 增加链接体检脚本(聚拢轮同款;剥离 fenced code,避免把「修复样例」当本文件导航链误报):

```bash
python3 - <<'PY'
import re
from pathlib import Path
gateways = [
    "docs/DEVELOPMENT.md",
    "docs/README.md",
    "docs/wiki/README.md",
    "docs/wiki/architecture/module-boundaries.md",
    "docs/plans/codebase-audit-remediation-plan.md",
]
# 相对链: ./ 与 ../ 都检; 忽略 http(s) 与 # 锚
link_re = re.compile(r'\]\(((?:\./|\.\./)[^)]+)\)')
fence_re = re.compile(r'```.*?```|````.*?````', re.S)
broken = []
for g in gateways:
    path = Path(g)
    if not path.exists():
        broken.append(f"MISSING {g}")
        continue
    text = fence_re.sub("", path.read_text(encoding="utf-8"))
    for m in link_re.finditer(text):
        p = m.group(1).split("#")[0]
        if p and not (path.parent / p).resolve().exists():
            broken.append(f"{g}: -> {m.group(1)}")
print("BROKEN" if broken else "ALL LINKS OK")
for b in broken:
    print(b)
PY
```

阶段 3/4 增加核心链路回归(`server/tests/chapterQualityLoop.test.js`、`literaryQualityPass.test.js`、`styleClearGate.test.js`、`directorQualityRepairRisk.test.js`、`finalizeStyleReviewWiring.test.js`)。

---

## 停止条件

- 阶段 1 通过 + 关键测试绿 → commit `fix(config): migrate RAG tuning params from env to AppSetting (C2)`
- 阶段 2 → commit `docs: fix stale source refs + revoke self-healed backlog (C5/C6/C7)`
- 阶段 3 → commit `refactor(director): collapse root to facade (C3)` + `chore(routes): migrate residual modules to http/ (C4)`
- 阶段 4 → commit `refactor(audiobook): split novelAudiobookRoutes 1519→N (C1-a)` + 后续 P2 拆分逐个 commit
- 任一阶段 3 次修复内循环仍 P1 阻断 → 停 milestone,输出《需人工关注报告》
- **不自动开下一个阶段**(CLAUDE.md 行为禁令:不因 backlog 自动开新阶段、阶段不跨 milestone 扩展)。每阶段完成后等你拍板开下一阶段。

## Backlog(本计划不做,记录待审)

- R12 (D4):snapshot 稳定态消费复核
- R13 (D5):recover 读路径不写 run_resumed复核
- G5:read-path N+1 性能取样
- G6:world context gateway 逐调用点复核
- `chapter-editor-v2-progress.md` Phase 3/4 进度数据是否仍推进(来自聚拢轮 backlog)
