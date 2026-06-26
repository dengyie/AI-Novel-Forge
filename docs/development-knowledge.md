# AI Novel Writing Assistant — 开发踩坑记录

## 1. Circuit Breaker 状态持久化 Bug

**文件**：`server/src/services/novel/director/runtime/novelDirectorContinueRuntime.ts`

**症状**：用户点击"继续"后命令显示成功，但流水线秒退回 `failed`。

**根因**：`continueTask()` 从 `seedPayload.autoExecution` 取出旧状态（含 `circuitBreaker: { status: "open" }`），原封不动传给 `markTaskRunning()` 和 `runFromReady()`。流水线启动后第一行就检查到 `open` 状态，立即 `stopAutoExecutionForCircuitBreaker` 退出。

**修复**：在 `continueTask()` 进入 `auto_execution` 分支时，对 `seedPayload.autoExecution` 做 sanitize，调用 `buildClosedDirectorCircuitBreakerState()` 将 circuit breaker 重置为 `closed`，保留原有计数器和历史信息。所有后续引用点（`markTaskRunning`、`resumeApprovedChapterExecutionNode`、`runFromReady`）统一使用 sanitize 后的对象。

**教训**：Circuit breaker 状态既存在于运行时内存也存在于 DB 种子 payload 里，修改任何一端都要同步。Continue/Retry 路径必须显式清除 breaker。

---

## 2. qualityLoopLedger 类型防御缺失

**文件**：`server/src/services/novel/director/automation/novelDirectorAutoExecution.ts`（558行）、`server/src/services/novel/director/runtime/DirectorQualityLoopBudgetLedgerService.ts`（193行、217行）

**症状**：`((intermediate value) ?? []).filter is not a function`

**根因**：手动修复 DB 时把 `qualityLoopLedger` 设成了空数组 `[]`。JS 里 `[].entries` 返回 `Array.prototype.entries` 函数而非 undefined，所以 `qualityLoopLedger?.entries ?? []` 没触发 fallback，`.filter()` 就崩了。

**数据类型约定**：`qualityLoopLedger` 应该是一个对象 `{ entries: [...] }`，不是数组。但 DB 里可以被篡改为任意 JSON 类型。

**修复**（3 处）：
```ts
const ledger = state.qualityLoopLedger && !Array.isArray(state.qualityLoopLedger)
  ? state.qualityLoopLedger
  : null;
const entries = ledger?.entries ?? [];
```

**教训**：对 JSON 字段使用 `?.` + `??` 模式时，要考虑中间值是函数的情况（`[].entries`、`[].filter` 等），需要加 `!Array.isArray()` 防御。不能假设 DB JSON 字段一定符合 TypeScript 类型定义。

---

## 3. 种子 Payload 内嵌模型名覆盖 DB 路由

**文件**：`server/src/services/novel/director/runtime/novelDirectorHelpers.ts`

**症状**：DB 路由表改了 writer → `deepseek-v4-flash`，但实际还是跑在 `deepseek-v4-pro` 上。

**根因**：任务的 `seedPayloadJson` 里嵌套了 `directorInput.model = "deepseek-v4-pro"`，Continue 时优先用这个字段而不是查 DB 路由表。所有角色（planner、writer、review、repair）全部跑在同一个覆盖模型上。

**修复**：将种子 payload 中 `$.directorInput.model` 设为 NULL，恢复走 DB 路由。

**教训**：
- 修改模型路由后，已有的运行中任务可能 cache 了旧模型选择
- 种子 payload 是持久化的任务上下文，`directorInput` 里的 `model`/`provider` 字段比 DB 路由优先级高
- 排查"怎么设了路由不生效"时，优先查种子 payload

---

## 4. Pipeline Job SkipCompleted 导致的"不存在"错误

**文件**：`server/src/services/novel/novelCorePipelineService.ts`（652行）

**症状**：`任务执行失败：小说或章节不存在`，pipeline job range: `7-7`

**根因**：第 7 章在 job 排队期间变成了 `approved/completed`，job 执行时 `skipCompleted` 过滤掉了它，导致 `chapters.length === 0`，触发了"小说或章节不存在"错误。

**信息**：`skipCompleted` 的过滤规则 — 同时满足 `content 非空`、`generationState` 为 `approved/published` 或 `chapterStatus` 为 `completed` 的章节会被跳过。

**处理**：删除失败的 pipeline job，等待自动导演任务本身重新调度。

---

## 5. 模型路由体系要点

**核心概念**：
- **taskType**（11 种）：`planner`、`writer`、`review`、`light_review`、`critical_review`、`repair`、`replan`、`state_resolution`、`summary`、`fact_extraction`、`chat`
- **别名映射**：`outline_planning` → `planner`、`chapter_drafting` → `writer`、`chapter_review` → `review`、`chapter_repair` → `repair`
- **路由优先级**：种子 payload `directorInput.model` > DB `ModelRouteConfig` 表 > 代码默认值

**修改路由的正确方式**：
1. `ModelRouteConfig` 表写正确的 provider/model/temperature
2. 如果有已运行任务，检查种子 payload 里的 `directorInput` 是否有覆盖
3. 任务 Continues 时会 pick up 最外层 provider/model，但种子里的覆盖会干扰

---

## 6. LLM Debug 日志文件选择 Bug

**文件**：`server/src/routes/llm.ts`（logs/recent 端点）

**症状**：油猴面板的 logs/recent 接口返回的是旧日志文件的数据

**根因**：`fs.readdirSync + .sort()` 按文件名字母序排序取最新文件。日志文件命名 `YYYY-MM-DDTHH-mm-ss-dev.llm.jsonl`，字母序和实际写入时间不一致（例如 `T05-14-30` 在 `T06-30-10` 之后按字母序排在前面，但按修改时间是后来才写入的）。

**修复**：改用 `fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs` 按文件修改时间排序。

---

## 7. Token 上限断路器

**文件**：`server/src/services/novel/director/runtime/DirectorCircuitBreakerService.ts`

**阈值设计**：
- `chapterTotalTokenLimit`：单章累计 token 上限，超过则熔断
- `singleStepTotalTokenLimit`：单步骤 token 上限
- `usageAnomalyOpenAt`：连续异常次数阈值

**触发机制**：
1. `recordUsageAnomalySignal`：检查单步是否超过 `singleStepTotalTokenLimit`
2. `recordChapterUsageBudgetExceededSignal`：检查整章是否超过 `chapterTotalTokenLimit`
3. 两者都在 `novelDirectorAutoExecutionRuntime.ts` 的调度循环中被调用
4. 达到 `usageAnomalyOpenAt` 次后状态变成 `open`，任务进入 `failed`

**调整**：默认 80,000/150,000 → 240,000/250,000。但不是简单改大就够的 — 要看实际 token 消耗和模型延迟是否匹配。

---

## 8. 零值限流与延迟特征

**Provider 限流配置**：SQLite `APIKey` 表中每个 provider 有 `concurrencyLimit` 和 `requestIntervalMs` 字段。值为 0 表示不限流。

**延迟特征**（通过 `llm.jsonl` 日志分析）：
- 延迟和 prompt token 数正相关，不是首字延迟
- 700 token prompt → ~15s
- 7000 token prompt → ~80s
- 14000+ token prompt → 200-290s
- 瓶颈在 CPA 代理端的推理吞吐，不是网络延迟

---

## 9. 项目常用调试技巧

### 查看 AI 底层交互
```bash
# 实时监控
bash scripts/llm-log-viewer live

# 统计概览
bash scripts/llm-log-viewer stats

# 查看延迟
bash scripts/llm-log-viewer filter --limit 10 --compact
```

### 查看任务状态
```sql
-- 导演任务
SELECT id, status, currentStage, lastError, progress FROM NovelWorkflowTask WHERE novelId='...';

-- 检查种子 payload
SELECT json_extract(seedPayloadJson, '$.autoExecution.circuitBreaker.status') FROM NovelWorkflowTask WHERE id='...';

-- 检查模型路由
SELECT taskType, provider, model, temperature FROM ModelRouteConfig;

-- 检查 API Key
SELECT provider, key, model, baseURL, isActive FROM APIKey;
```

### 手动恢复任务
```sql
-- 重置失败任务
UPDATE NovelWorkflowTask SET status='queued', lastError=NULL, finishedAt=NULL WHERE id='...';

-- 清除 circuit breaker
UPDATE NovelWorkflowTask SET seedPayloadJson = json_set(seedPayloadJson, '$.autoExecution.circuitBreaker', JSON('{"status":"closed"}')) WHERE id='...';

-- 清除模型覆盖
UPDATE NovelWorkflowTask SET seedPayloadJson = json_set(seedPayloadJson, '$.directorInput.model', NULL) WHERE id='...';

-- 清除 stale pipeline job
DELETE FROM GenerationJob WHERE id='...';
```

---

## 10. CPA 代理注意事项

- CPA 代理是单一 OpenAI-compatible endpoint `http://127.0.0.1:8317/v1`
- 支持 38 个模型：Claude Opus 4.6/4.7/4.8、Sonnet 4.6、GPT-5.5/5.4、DeepSeek V4-Pro/Flash、Gemini、GLM 等
- `/v1/models` 返回全量列表（约 40 个，含空字节污染需清理）
- 通过 `/v1/chat/completions` 统一路由，不同模型名转发到不同后端
- 延迟主要取决于 prompt token 数和后端模型推理速度
