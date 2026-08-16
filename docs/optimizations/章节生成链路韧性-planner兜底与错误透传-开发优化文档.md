# 章节生成链路韧性开发优化文档 — planner 失败兜底与错误 phase 透传

> 来源：D1/D2/D3 上线后，监控卷一返工重写（ch6《真同意》）暴露的链路韧性缺陷。
> 口径：可用性评估与减 bug，**不评价内容创作**。术语遵循禁「称重」、用可用性评估口径。
> 产品铁律（不可破）：不机械控节奏/字数硬控；写文质量优先、禁 mode/灰度堆砌；监管只监控不代写；卡住先查根因不无脑重试。
> 关联文档：[[卷一返工书写反馈-开发优化文档]]（D1/D2/D3）、[[卷一返工重写监控经验-开发优化文档]]（§4-5 经验原始记录）。
> 所有缺陷条目均标注代码实证位置（`file:line`），可证伪、可复核。

---

## 0. 为什么单独立篇

D1/D2/D3 修的是 **writer 阶段**（生文超时预算、超时分类、质量环持久化）。但 ch6 返工重写暴露：**planner 阶段**（writer 之前）有一个独立的韧性缺口链，且这个缺口在公网被 **CF 524 表象掩盖**，导致运维极易误判为「网络超时」而错过真根因。

本篇聚焦 planner 失败兜底与错误 phase 透传，**不与 D1/D2/D3 重复**（D1 已修 writer 超时；本篇卡点在 writer 之前的 planner）。

---

## 1. 执行链实证（代码逐行）

`POST /api/novels/:novelId/chapters/:chapterId/generate`（`server/src/modules/novel/production/http/novelChapterGeneration.ts:62-89`）执行链：

```
路由 handler
  └─ stepModuleRunner.runStep(chapter_execution, {...})              // StepModuleRunner.ts:40
       ├─ module.inspectReadiness                                     // 前置就绪检查
       ├─ module.buildInput                                           // 构造输入
       ├─ module.validatePreconditions                                // 前置门禁
       └─ module.execute → createChapterStream                       // ChapterStreamGenerationOrchestrator.ts:67
            ├─ await prepareRuntimeChapter(...)                      // :78  ★同步，在返回 stream 之前
            │    └─ assembler.assemble(novelId, chapterId, request)  // :210 GenerationContextAssembler.ts:61
            │         └─ PlannerService.generateChapterPlan          // planner LLM 调用
            │              └─ runStructuredPrompt → invokeStructuredLlmDetailed
            │                   └─ resolveStructuredOutput           // StructuredOutputResolution.ts:88
            │                        ├─ applyPromptPostValidate       // :97  postValidate
            │                        ├─ (失败) semantic-retry 循环   // :95 while
            │                        └─ (仍失败) 抛 post_validate_failed / 无兜底
            ├─ createChapterGenRun (trace)                           // :86
            ├─ chapterWritingGraph.createChapterStream               // :95  ★writer 在这之后（D1 作用域）
            └─ return { stream, onDone }
  └─ streamToSSE(res, stream, onDone)                                 // SSE 流式输出
```

**关键时序事实**：

1. **planner 在 `createChapterStream` 第一行 `await prepareRuntimeChapter` 同步执行**（`ChapterStreamGenerationOrchestrator.ts:78`）。planner 抛错 → `createChapterStream` reject → `module.execute` reject → `runStep` reject → 路由 catch（`novelChapterGeneration.ts:82`）。
2. **planner 抛错时 `streamToSSE` 还没开始调用**（`:81`）。即响应头还没发 `200/text-event-stream`，理论上**可以前置返回结构化错误 JSON**，而不是让请求拖到 CF 524。
3. **planner 失败 → writer 根本不启动**。D1 的 writer 超时预算无从验证——这就是为什么 ch6 第二轮重写「没撞 D1 超时墙，却仍失败」。

---

## 2. 缺陷清单（按依赖与严重度排序）

### E1（最高）planner postValidate 失败无兜底，单次输出畸形即整章 500

**实证**：
- planner chapter plan asset（`server/src/prompting/prompts/planner/plannerPlan.prompts.ts:48-51`）`semanticRetryPolicy = { maxAttempts: 1 }`，**无 `postValidateFailureRecovery` 字段**。
- `resolveStructuredOutput`（`server/src/prompting/validation/StructuredOutputResolution.ts:117-163`）：semantic-retry 用尽后，若 asset 有 `postValidateFailureRecovery` 则走兜底返回；**planner asset 没有，直接抛 `markPromptQualityFailure(error, "post_validate_failed")`**（`:163`）。
- `resolveStructuredSemanticRetryAttempts`（`PromptExecutionPreparation.ts:106-110`）默认 0；planner chapter 显式设 1。即 planner 链路：repair(1, json_schema 自修复) → semantic-retry(1, 业务校验失败重试) → 仍失败 → 500。

**触发场景**（ch6 实录）：gemini-3.7-flash-high 作为 planner 输出畸形 JSON——title 字段塞满模型 hallucination 的元描述复读（`"第6章 真同意：残痕托付与代价即死后的深渊对峙（总第6章）[残痕][托付][12000字][已校对修改完整版第6章结构规划][严禁截断]..."`），objective 字段缺失。postValidate（`plannerPlan.prompts.ts:169`）抛 `Planner output is missing objective`。semantic-retry-1（latencyMs≈9917ms）后仍畸形（rawChars=1072，objective 仍空）。整章 generate 500。

**如实窄化**：
- planner prompt 本身**干净**（只有一条「只输出严格 JSON」，`:85`），**没有**「严禁截断/完整版/终态」诱发复读的措辞。那些复读元描述是 **gemini-flash 自身 hallucination**，不是 prompt 诱发。已修正 `卷一返工重写监控经验-开发优化文档.md` §5 P1(b) 的旧猜测。
- 这**不是确定性失败**：ch6 第一轮重写 planner 恰好成功（生文 13045 字），第二轮起持续畸形。是 planner LLM 在 json_schema 策略下的**偶发稳定性问题**，非必现。
- 第一轮成功、第二轮失败之间唯一的输入变量是新 taskSheet（补了契约约束文本）。但 taskSheet 约束文本被 planner 挪用进 title 复读，是畸形输出的**症状**不是根因——根因是模型在 json_schema 下的输出稳定性。

**修复方向（纯韧性工程，不碰内容创作、不碰 taskSheet 契约语义）**：

1. **给 planner chapter plan asset 加 `postValidateFailureRecovery`**（与其它 structured prompt 对称）。兜底只能用 **promptInput / context 里已有的契约字段**（expectation / taskSheet / chapter 输入）构造一个最小可用的 PlannerOutput，**不能凭空生成**（否则破「监管只监控不代写」——兜底不得替模型发明内容）。具体：objective 从 `promptInput.expectation` 或 taskSheet 章节目标取；title 从 chapter.title 取；mustAdvance/mustPreserve 从 taskSheet「必须推进/必须保留」解析；scenes 置空数组（asset 已支持 `includeScenes=false` 时 scenes 返回空）。这样兜底产出的是「已有契约的结构化投影」，不引入新内容。
2. **semantic-retry 的 retry 消息补充失败字段名**：当前 retry 消息（`StructuredOutputResolution.ts:37`）只说「第 N 次语义重试」，建议补「上次缺失字段：objective」「上次 title 异常长度」等具体失败特征，提高 retry 命中率。注意：这是改 retry 的**输入信息**，不是改模型的创作意图，不破铁律。
3. **不在本项调 `semanticRetryPolicy.maxAttempts`**：次数从 1 提到 N 是治标（让模型多试几次），且增加 wall-clock（每次 ~10s，叠加会加剧 E2 的 CF 524）。兜底（方向 1）是治本——一次畸形不致命，而不是多试几次碰运气。

**测试缺口**（禁 pytest，用 node:test）：
- `postValidateFailureRecovery` 兜底：mock planner LLM 输出畸形 JSON（objective 空），断言兜底产出含 expectation 投影的 PlannerOutput，且 `postValidateFailureRecovered=true`。
- 兜底字段来源：断言 objective 来自 promptInput.expectation、title 来自 chapter.title，不凭空。
- 不破铁律断言：兜底输出不得包含 taskSheet/expectation 之外的创作性字段（scenes 空、participants 空）。

---

### E2（高）planner 失败经 CF 表现为 524，phase 不透传

**实证**：
- 路由 handler（`novelChapterGeneration.ts:62-89`）：planner 在 `runStep` 内同步抛错，路由 catch 走 `forwardBusinessError(error, next)`（`:83`）或 `next(error)`（`:86`）。
- 但 `runStep`（含 planner invoke + repair + semantic-retry，各 ~10s）+ 前置 context 加载（contextBlockIds 含 9 块）总耗时 **>100s**，触发 **CF Tunnel 524**（cloudflared 对 origin 响应的超时）。公网 curl 收到 524 页面（16 字节 `error code: 524`），**根本到不了路由 catch**。
- 运维表象：「generate 524」→ 误判为「CF 网络超时」或「源站慢」→ 盲重试 → 重复 524。真根因（planner postValidate 抛错）埋在 pxed server.err.log，公网侧不可见。

**修复方向**：

1. **planner 失败前置返回结构化错误**：在路由 catch 里，对 planner/postValidate 类错误返回结构化 JSON（如 `{ success:false, error:{ code:"CHAPTER_PLANNER_FAILED", failurePhase:"planner", plannerError:"missing objective", retryable:true } }`），而非让请求拖到 CF 524。代码依据：planner 抛错时 SSE 还没开始写（`streamToSSE` 在 `:81`，planner 在 `:78` 的 await），响应头未发，可返回 JSON。
   - 但注意：**仅当 planner 抛错足够快时**才有效。若 planner invoke 本身跑满 ~20s（repair+retry）+ context 加载 >80s，总耗时仍可能逼近 CF 100s。所以 E2 的完整修复依赖 **E3（planner 阶段尽早流式 phase 信号）** 或 **CF Tunnel 超时调大**。
2. **CF Tunnel origin 超时调大**（运维层，非代码）：cloudflared 对 SSE 长连接的 origin 响应超时。但这只缓解 524 表象，不解 planner 根因；且调大超时会让真挂死（如 D1 未修前的 writer 撞墙）也拖更久。需配合 E1（兜底减少 planner 失败）+ E4（llm 日志健康）综合判断，不单独依赖。
3. **运维侧诊断脚本**：generate 失败时，提供一键诊断（ssh pxed 查 server.err.log 最近 `Planner output is missing` / `post_validate_failed`），避免下次再误判为网络。可落 vault 运维手册。

**测试缺口**：
- 路由层：mock `runStep` 抛 planner 类错误，断言返回结构化 JSON（含 failurePhase=planner），而非 500/524。
- 断言 planner 失败时 SSE 头未发（`streamToSSE` 未被调用）。

---

### E3（中）planner 阶段无 SSE phase 信号，首字节延迟不可观测

**实证**：
- `StructuredPromptExecutor` 有 `safeLiveCall(() => liveSession.phase("requesting" / "assembling" / "validating", ...))`（`StructuredPromptExecutor.ts:59,61,76`），planner 阶段有 phase 信号。
- 但这些 phase 信号是否在 planner **首字节前**就通过 SSE 发给客户端？看链路：planner 在 `createChapterStream`（`:78` await）里同步跑，**stream 对象在 `:107` 才 return**。即 planner 跑完前，`streamToSSE`（`:81`）拿不到 stream，SSE 头未发，phase 信号到不了客户端。
- 后果：planner 跑 20-100s 期间，客户端/CF 看不到任何字节 → CF 100s 超时 → 524。

**修复方向**（较深，非本轮必做，列为 P2）：
1. **planner 阶段也走 SSE**：让 `createChapterStream` 立即返回一个 stream，先吐 planner phase 信号（`{type:"phase", phase:"planner", status:"running"}`），再异步跑 planner，planner 完成后接 writer stream。这样首字节在 planner 开始时就发出，CF 不会 524，客户端也能看到「正在规划章节」。
   - 这是**架构层改动**（createChapterStream 从「同步 prepare + 返回 stream」改为「立即返回 stream + 内部异步 prepare」），影响面大，需独立 plan + TDD 覆盖 abort 语义（planner 期间客户端断连要能 cancel）。
2. **最小版**：仅在 planner 开始前发一个 SSE comment frame（`: planner-started\n\n`），让 CF 收到首字节不超时。不改架构，只补一个 keepalive。注意这不解 planner 失败根因，只防 524 掩盖真根因。

**测试缺口**：取决于选哪个方向，暂不细化。

---

### E4（低-中）llm 日志 append `Unknown system error -122`

**实证**：pxed server.err.log 反复 `[llm.debug] failed to append dedicated llm log: Unknown system error -122, close`（ch6 失败期间高频出现）。

- `errno -122` 在 Linux 通常是 `EDQUOT`（磁盘配额超限）或文件系统相关。llm.jsonl 写入失败，导致 **llm 调用可观测性丢失**——ch6 故障期间 llm.jsonl 最后一条停在 21:14:05（第一轮的 acceptance_assessment），后续 planner 调用都没记上，加剧了 E2 的诊断困难。
- 非本轮根因（planner 畸形输出是根因，-122 是并发的可观测性缺陷），但影响诊断链路，需独立排查。

**修复方向**：
1. 排查 pxed `/personal/pxed/ai-novel/.logs/` 所在分区磁盘配额/ inode 耗尽。
2. llm 日志写入失败时降级到 stderr（而非静默），避免可观测性完全丢失。
3. 若是 fd 耗尽（llm.jsonl 频繁开关），改持久 fd 或轮转。

**测试缺口**：运维层为主，代码层可补「日志写入失败时降级 stderr」的单测。

---

## 3. 产品铁律约束（任何修复方案都不得触碰）

- **不得机械控字数/节奏**：E1 的 planner 兜底只投影已有契约字段，不调字数下限/节奏。
- **不得堆 mode/灰度**：兜底走单一清晰路径（postValidateFailureRecovery），不接受「新增 conservative planner mode 先灰度」式堆砌。
- **监管只监控不代写**：E1 兜底产出的是「已有契约的结构化投影」（expectation/taskSheet/chapter 输入），**不得凭空生成 scenes/participants/objective 的创作性内容**。兜底是「让一次畸形输出不致命，仍能用已有契约进 writer」，不是「替模型规划章节」。
- **禁「称重」**：本篇及后续 PR 描述一律用「可用性评估 / 链路韧性 / 吞吐评估」口径。

---

## 4. 推进顺序建议

1. **E1 先行**（最高价值）：planner 兜底是治本——一次畸形不致命，整章不再 500。补 node:test 覆盖兜底字段来源 + 不破铁律断言。
2. **E2 跟进**：E1 落地后 planner 失败概率大降，E2 的结构化错误透传 handles 剩余失败。两者配合让公网不再 524 掩盖根因。
3. **E3 评估**：若 E1+E2 后 planner 仍偶发长耗时（>100s），再做 E3 架构层 SSE phase 信号。否则 E3 列为长线 backlog。
4. **E4 独立排查**：运维层 + 日志降级，与 E1-E3 解耦，可并行。

---

## 5. 部署纪律

- **先证据后动作**：2026-08-17 用户放权「以后不用我授权，直接部署测试」，但「免请示 ≠ 免验证」。改 pxed .env / 重启 / 写 DB 仍须先取证。
- **推 pxed 前必跑本地构建**：Mac 上 typecheck + client build（曾有 JSX 漏 `>` 闭合只在 build 暴露的教训）。
- **上线路径**：merge `main` → Actions Deploy pxed（`d645d67` 起无审批）；`deploy/<sha>` 仅为可选回放，**禁人肉 SSH 改机器**。
- **TDD 铁律**：每个修复先写失败测试（node:test，禁 pytest），看它红，再写最小实现转绿。

---

## 附：本文档的「可证伪」自查

- 每条缺陷都有 `file:line`，复核者打开即见。
- 执行链（§1）逐行标注 await 顺序，planner 先于 writer、SSE 头在 planner 之后发——这是 E1/E2/E3 所有结论的时序前提，可在 `ChapterStreamGenerationOrchestrator.ts:67-108` 原样复核。
- E1 的「planner prompt 干净、复读是模型 hallucination」已用 grep 实证（prompt 无「严禁截断/完整版」措辞），修正了经验文档旧猜测。
- E1 的兜底方向（投影已有契约字段、不凭空生成）与铁律的边界已显式声明，可被复核者对照「不得代写」逐条检验。
