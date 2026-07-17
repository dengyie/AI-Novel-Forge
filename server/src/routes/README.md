# `server/src/routes/` — 跨模块胶水与传统入口

## 约定

`routes/` 根目录只保留两类文件：

1. **跨模块胶水路由** — 单文件同时编排多个业务模块（service + module 混合）的薄 HTTP 映射。
   典型：`styleEngine.ts`、`styleEngineExtraction.ts`、`character.ts`、`creativeHub.ts`、
   `knowledge.ts`、`bookAnalysis.ts`、`rag.ts`、`tasks.ts`、`agentRuns.ts`、`writingFormula.ts`。
   这些路由的依赖横跨多个扁平 `services/` 或部分 `modules/`，强行迁入任一模块 `http/` 反而割裂内聚、
   且需大量 `../../../../` 深链 rewire，得不偿失。保留在 `routes/` 根是当前最清晰的归属。
2. **独立小路由** — 不属于小说主链 / 导演 / 导出 / 世界任一强制迁移模块的薄入口
   （`astrology.ts`、`genre.ts`、`storyMode.ts`、`chat.ts`、`images.ts`、`titleLibrary.ts`、`llm.ts`、
   `health.ts`、`agentCatalog.ts`、`promptWorkbench.ts`）。

## 强制迁移范围（由 `tests/routeDirectoryBoundary.test.js` 固定）

按 `docs/wiki/architecture/module-boundaries.md` 规则，**只有**小说主链 / 自动导演 / 小说导出 /
世界设定四类 HTTP 映射必须进模块 `http/` 目录并由 `app.ts` 直接挂载模块入口，且不在 `routes/`
根保留 re-export shim：

| 已迁移业务 | 新位置 | 旧 `routes/` shim |
|---|---|---|
| 小说主链 + 章节等 | `src/modules/novel/http/` | `novel*.ts` 全部删 |
| 自动导演 | `src/services/novel/director/http/` | `novelDirector.ts` / `novelWorkflows.ts` 删 |
| 自动导演 follow-up / channel 回调 | （仍 `routes/` 根，属导演编排但入口薄、保留根） | — |
| 小说导出 | `src/modules/export/http/` | `novelExport.ts` 删 |
| 世界设定 | `src/modules/setup/world/http/` | `world.ts` 删 |

边界测试断言 `app.ts` 不再 `import "./routes/{novel,novelDirector,novelWorkflows,novelExport,world,..."}`，
且对应 `routes/` shim 文件不存在；其余非小说主链 `routes/` 根文件不在锁内。

## `settings/` 子目录与 settings 编排

`routes/settings.ts` 是 settings 总编排（667 行，预算内），子树细分落点：

- `routes/settings/customProviderRoutes.ts` — 自定义 LLM provider 增删改
- `routes/settings/llmSelectionRoutes.ts` — LLM 选择
- `routes/settingsAutoDirector.ts`（根）— 自动导演 settings 关联薄入口

settings 新增细分 handler 优先进 `routes/settings/`，不要继续向根平铺。

## 上限与拆分触发

按 `module-boundaries.md` 扩展前必拆规则，`routes/` 根单文件超过 700 行应在本目录内按 handler
职责拆分。当前最大 `settings.ts` 667 行、`styleEngine.ts` 509 行，均在预算内。
