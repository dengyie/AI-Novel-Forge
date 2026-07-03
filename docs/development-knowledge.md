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

---

## 11. LLM 调用无墙钟超时 → 永久挂死 → 流水线假 running（最深根因）

**文件**：`server/src/llm/invokeTimeout.ts`、`server/src/llm/factory.ts`、`server/src/prompting/core/promptRunner.ts`

**症状**：auto_director 任务反复 stall——`status=running`、心跳新鲜，但章节不推进、DirectorEvent 长时间无新增、resume 救不了，只能硬重启 ts-node-dev 主进程。

**根因**（两层，同一根源）：核心 LLM 调用（`planner.chapter.plan` 等）不显式传 `timeoutMs`：
1. `runWithEnforcedTimeout` 原本在 `timeoutMs` 为 undefined 时直接裸跑（`if (!timeoutMs && !signal) return input.run(undefined)`），AbortController + Promise.race 墙钟超时**根本没启用**。
2. `runTextPrompt` 根本没套 `runWithEnforcedTimeout`，裸调 `llm.invoke`，只靠 ChatOpenAI/Anthropic 客户端的 HTTP timeout。

**为什么客户端 HTTP timeout 不够**：CPA 某渠道会「响应头已返回 200 但 body 流静默 hang」，SDK 的 timeout 管不到已开始的流式 body → invoke promise 永不 resolve/reject。

**卡死链**：promise 永久挂死 → 不 reject → Phase 4 瞬时重试（`isTransientTransportError`）够不着（没有 error 可判断）→ director 执行循环卡在 `node_started` 之后 → 但心跳 cron 独立在刷 → 表现为「假 running」。

**诊断特征**：
- task=running + 心跳新鲜，但 DirectorEvent >5min 无新增
- LLM 日志（`.logs/YYYY-MM-DD/*.llm.jsonl`）某条 `event:request` 有 `latencyMs:null`、无对应 response、`timeoutMs:null`
- 章节 `generationState` 停在 planned/writing 不动

**根治**（3 层超时注入）：
1. `factory.ts` 注入 `DEFAULT_LLM_REQUEST_TIMEOUT_MS`（读 `LLM_REQUEST_TIMEOUT_MS` env，默认 300s，范围 30s–900s），客户端 HTTP 层兜底。
2. `runWithEnforcedTimeout` 自身默认兜底 `DEFAULT_ENFORCED_TIMEOUT_MS`，墙钟超时**无条件启用**，不依赖 SDK/fetch 语义。
3. `runTextPrompt` 也套 `runWithEnforcedTimeout`。

墙钟超时到点无条件 `abort + reject`，reject 消息含 "timed out" → 命中 `isTransientTransportError` → Phase 4 重试自动换渠道。这把「永久挂死」变成「300s 后超时重试」，从机制上消除假 running。

**教训**：
- 新增任何 LLM 调用路径，务必最终过 `runWithEnforcedTimeout`（现有默认兜底，但别新开绕过它的裸 `llm.invoke`）。
- 调全局超时用 `LLM_REQUEST_TIMEOUT_MS` env（纯 env，不改源码不触发 respawn）。
- 遇到「假 running」先查 LLM 日志有无 `latencyMs:null` 的挂死 request。

---

## 12. PayoffLedger 跨 key 重复登记 → 误判 overdue → 强制 replan

**文件**：`server/src/services/payoffLedgerShared.ts`、`server/src/services/payoff/PayoffLedgerSyncService.ts`、`server/src/services/novel/runtime/ChapterArtifactDeltaService.ts`

**症状**：某伏笔已在早期章节 `paid_off`，但流水线仍反复报该伏笔 overdue → `PIPELINE_REPLAN_REQUIRED` → 任务 failed。

**根因**：LM 在每轮 reconciliation 里为**同一条剧情**发明新的 `ledgerKey` 变体（措辞不同），每个新 key 都是全新 setup→无窗口→overdue，绕过了已有终态行。

**修复**（两条写路径都要加防御，缺一不可）：
- `PayoffLedgerSyncService.syncLedger`（LM 对账路径）
- `ChapterArtifactDeltaService.applyPayoffDeltas`（章节 delta 路径）

三层守卫：
1. **终态守卫** `isTerminalPayoffStatus`：`paid_off`/`failed` 状态不可被 LM 重开，除非显式动作。stale-marking 循环跳过条件从 `=== "paid_off"` 改为 `isTerminalPayoffStatus`（连 failed 一起豁免）。
2. **跨 key 窗口指纹去重** `resolvePayoffLedgerSyncLedgerKey`：title 匹配只复用未完成行；新增 fallback 用 `targetStart + targetEnd` 相同指纹重映射到终态行，让 LM 的新 key 落回原终态行而非新建。
3. **premature-overdue sanitize** `isPrematureOverduePayoff`：过滤审计伪项、无窗口项、终态重开等误判。

**教训**：payoff 有两条独立写路径，任何守卫都必须同时应用到两边，只改一边会被另一条路径绕过。

---

## 13. 任务中心堆积失败/导演跟进任务的清理

**文件**：`server/src/services/task/TaskRetentionService.ts`

**症状**：任务中心堆一堆 superseded 的失败任务和孤儿导演跟进日志。

**清理策略**（三类 sweep）：
1. **age-based** `selectDeletableTaskIds`：按年龄清扫过期任务。
2. **supersede** `selectSupersededTaskIds` + `selectSupersededGenerationJobIds`：按 novelId 分桶 GenerationJob，当该小说有 active pipeline job **或** active auto_director takeover 时，删除已终态的旧 job。
3. **orphan-log**：删除 `taskId` 不在 `NovelWorkflowTask` 里的孤儿日志行（`autoDirectorFollowUpActionLog` + `autoDirectorFollowUpNotificationLog`）。

`deleteWorkflowTasks` 级联删除现包含两张导演跟进日志表的 `deleteMany`，避免删任务后残留孤儿日志。

**教训**：删任务时要级联清跟进日志，否则孤儿日志会一直堆在任务中心。
