# 质量反馈总线（QFP）闭环与卷二内容债清单

**分支**：（本文档为纯规划，非代码 milestone）
**状态**：草案 v1 · 待评审
**上游**：
- 现有 `qualityFeedback` projection（`server/src/services/novel/quality/qualityDebtBoard.ts` · `ChapterQualityLoopService.ts` · `avoidRetry`/`terminalAction` 语义已上线）
- 现有 `ChapterRepairStreamRuntime` · `PlannerService` · `ReplanWindowDecisionService`
- 现有卷骨架 worldview-guard（`cc4cf51` merged）→ 生产 HEAD `f13954b`
- 卷二源世界监管（task `cmrnm5kaq0kev0k9ki820qlpr` **succeeded**，production `ab5f345e` cutover · vault §七点三十九）

**不做**：
- 不改任何生产代码（本 milestone 只落 plan）
- 不动 production / cutover / dist
- 不设计具体 DB 迁移（列为 P2）
- 不做 SLO / 用量估算（P2）
- 不做「机械节奏控制」— 节奏归 Novel 项目 AI（`feedback_novel-no-mechanical-pacing`）
- 不做 agent 代写 / PUT 正文 / 盲批（`feedback_agent-monitor-only-no-craft` · `feedback_novel-no-blind-approve`）

## 1. 定位

QFP（Quality Feedback Projection）已经在代码里以「投影」形态存在：`qualityDebtBoard` 从 `ChapterQualityLoopService` 的 `recommendedAction` / `terminalAction` / `avoidRetry` / `failedPatchCount` 投出可读事实，`ChapterRepairStreamRuntime` 消费 `avoidRetry` 决定是否 heavy rewrite，`PlannerService` / `ReplanWindowDecision` 消费 debt 摘要决定 replan window。

问题：这三条消费链彼此**只知道现在**，不知道**为什么此前判成这样**。产物是：

- 写：writer 拿到「本章 debt=blocking, avoidRetry=true」但**看不到**上一次是什么内容触发的、修过什么、哪些反例已经出现。
- 修：`ChapterRepairStreamRuntime` 只知道最新 signature，不知道过去 patch 为何被 discard/plateau_stop，patch 决策依然仰赖 LLM 重推。
- 规划：`ReplanWindowDecisionService` 只看到「窗口内有 N 条 blocking」，看不到 debt 是否已被承认 / 是否要在下一窗口铺伏笔化解。

**本 plan 的定位**：把 QFP 从「投影 (Projection)」升级成「总线 (Bus)」— 一个可追加、可订阅、可回放的事件序列，让写/修/规划各自订阅自己关心的事件类型，不再靠共享可变状态和 LLM 隐式记忆做交接。

## 2. 目标

- 把「谁在什么时候基于什么证据做了什么质量决议」变成一条**只追加**的事件流。
- 让写、修、规划三条链**各自订阅**它需要的事件，反馈从「共享状态里翻」变成「订阅事件流」。
- 让监管（含 Nova 自审 / 人工监管 agent）能**只读回放** QFP，看清一条 blocking debt 的完整生命史，而不是靠日志 grep。
- 保留一切现有语义边界：defer_and_continue、avoidRetry、prose_ban、no-rewind、strip、length 硬门 均**不动语义**，只是把它们的产生和消费搬到总线上。

## 3. 非目标

- 不引入外部消息队列（Kafka / Redis Streams / NATS）— 本 plan 只用现有 SQLite。
- 不改现有 `qualityFeedback` 投影接口 — 投影仍然可用，只是背后从「实时算」变「读事件流」。
- 不做全站质量指标监控大盘（P3）。
- 不做用户可见的「本章质量历史」UI（P2）。
- 不做机械节奏 / 字数曲线 / 高潮位曲线 控制 — 那属于 Novel 项目 AI 的自审范畴（`feedback_novel-no-mechanical-pacing`）。

## 4. 事件流模型（骨架）

> 具体 schema 交由 P0 实现阶段定；此处只钉**事件类别**与**必备字段**。

### 4.1 事件源（Producers）

| 事件源 | 何时发事件 | 现有代码入口 |
|---|---|---|
| ChapterQualityLoopService | 每次 quality loop 结束 · 每次 terminalAction 决议 · 每次 patch adopt/discard/plateau_stop | `services/novel/quality/ChapterQualityLoopService.ts` |
| ChapterRepairStreamRuntime | 每次 repair 尝试起 / 停 · 每次 avoidRetry 触发 heavy rewrite | `services/novel/runtime/repair/ChapterRepairStreamRuntime.ts` |
| PlannerService · ReplanWindowDecisionService | 每次 replan 决策（含 skip / rewrite / defer） | `services/planner/*` |
| Volume Skeleton Critique（worldview-guard） | 每次 skeleton critique 出结论 · 每次 feedback-injected regen | `services/novel/volume/volumeGenerationOrchestrator.ts` + `prompting/prompts/novel/volume/skeletonCritique.prompts.ts` |

### 4.2 事件类别（初稿）

- `quality.loop.decision` — recommendedAction / terminalAction / signature / attempt / exhausted / patchDecision
- `quality.patch.attempt` — patchType / adopted / discardReason / plateauStop
- `quality.blocking.raised` — chapterOrder / signature / firstSeenAt / rootCauseHint
- `quality.blocking.deferred` — chapterOrder / deferReason / bookedForWindow
- `quality.blocking.resolved` — chapterOrder / resolvedBy(patch/manual/replan/skeleton-fix)
- `quality.repair.stream.opened|closed` — mode(patch/heavy-rewrite) / avoidRetry / driver
- `plan.replan.decided` — windowRange / decision / debtSnapshot
- `skeleton.critique.verdict` — volumeId / opponentFace / framing / rewriteRound
- `skeleton.regen.applied` — volumeId / feedbackTags / round

### 4.3 必备字段

- `eventId` (cuid)
- `novelId`
- `chapterId?` / `volumeId?` / `taskId?`
- `producerModule`（模块级来源，非文件行号）
- `producedAt` (ISO)
- `signature?`（与 `qualityLoop.feedback.signature` 一致以便投影 join）
- `payload`（事件类型自定义）
- **不含**：主观质量分（属产品语义）、LLM 原文（占空间，另存 blob 引用）

### 4.4 存储与检索

- 存储：`prisma` 新表 `QualityEvent`（P0 定 schema，本 plan 不落 migration）
- 检索：
  - 按 novelId+time 顺序流（用于回放）
  - 按 chapterId 时间倒序（写/修用）
  - 按 signature（跨章追同因质量债）
- 索引最少：`(novelId, producedAt)` · `(novelId, chapterOrder, producedAt)` · `(signature, producedAt)`

## 5. 三向 handoff 界面

### 5.1 写（Writer）↑ QFP

Writer 生成正文前，从 QFP 订阅：

- `quality.blocking.raised` where chapterOrder == current
- `quality.patch.attempt` where adopted=false（拒绝的反例证据）
- `skeleton.critique.verdict` where volumeId == current 且 rewriteRound=latest

Writer prompt 组装侧新增「反例摘要块」— 只塞入 3-5 条最近事件的**结构化摘要**，不塞入 LLM 原文。避免 prompt 膨胀，保留可追溯。

**边界**：writer 不写回 QFP。写完的正文触发 `quality.loop.decision` 是由 loop service 产生。

### 5.2 修（Repair）↑ QFP

`ChapterRepairStreamRuntime` 决定 patch vs heavy_rewrite 前，从 QFP 订阅：

- 当前章过去 N 条 `quality.patch.attempt`（含 discardReason / plateauStop）
- 同 signature 的 `quality.blocking.deferred` / `resolved`
- 若发现同 signature 已在此前被 `resolvedBy: skeleton-fix`，触发一次 sanity check（是否 skeleton fix 未 propagate 到本章）

**边界**：repair 不越过 `avoidRetry` 硬门；只是让 patch 决策**看得见证据**，不是让它越权做 skip_quality。

### 5.3 规划（Planner）↑ QFP

`ReplanWindowDecisionService` 决定 replan 前，从 QFP 订阅：

- 窗口内 `quality.blocking.raised` 未 resolved 的聚合
- 是否有 `skeleton.regen.applied` 落在窗口起点前后 3 天（避免 skeleton 刚改就重排窗口）
- 相同 signature 是否已跨章出现 ≥3 次（跨章债信号）

**边界**：Planner 决议仍然只输出 `plan.replan.decided` 事件；不直接触发 writer / repair。

## 6. 卷二内容债清单（P1）

**授权来源**：`vol2-full-supervision-mandate` memory（2026-07-15 起监管 41–80 至闭环）· 卷二 task `cmrnm5kaq0kev0k9ki820qlpr` 已 succeeded（vault §七点三十九 · [[Note/AI/AI Novel/源世界/27-生产监管-源世界卷一]]）。

**边界**：以下债**由 Novel 项目 AI 自审自修**，代理只做 poll / 控制面 / 事件观测；**禁止**代写正文 / 盲批 / skip_quality_repair（`feedback_agent-monitor-only-no-craft`）。本清单只是把债编成 QFP 事件订阅项以便可观测。

### 6.1 blocking debt（可见不盲 scrub）

| 章 | 债类 | 信号来源 | QFP 订阅点 |
|---|---|---|---|
| ch57 | blocking · defer_and_continue | qualityDebtBoard + AE `qualityDebt` | `quality.blocking.raised` chapter=57 未 resolved |
| ch71 | blocking · defer_and_continue | 同上 | `quality.blocking.raised` chapter=71 未 resolved |
| ch74 | blocking · draft_repair_exhausted | 同上 | `quality.blocking.raised` chapter=74 未 resolved |

处置原则：等 Novel 自审输出修复稿；代理只 poll `quality.blocking.resolved` 事件确认闭环，不写回。

### 6.2 术语/命名债

| 章 | 债 | 备注 |
|---|---|---|
| ch77 | 「称重」违规 | `banned-term-chengzhong` memory 明令禁用；卷一改名「残痕」时已批 (2026-07-15)，ch77 是**内容侧漏改**。修由 Novel 自审。 |
| ch75 | 「黄振」孤名 | 与设定层未对齐（vault §设定对齐灰度 hard mustAvoid ch39 黄振）。修由 Novel 自审。 |

处置原则：ban clean 由 Novel 生成侧修；代理**不** PUT 正文、**不**手改「称重→可用性评估」— 那属于代写。QFP 侧新增 `quality.term.banned.hit` 事件类别（P0 阶段一起定），便于监管流可视，但依然只读。

### 6.3 patch 未 adopt

已在 QFP 语义内（`quality.patch.attempt` adopted=false），本 plan 不新增语义。Novel 自审如果决定 adopt 某个既有 patch，走既有 approve_gate / manual review 通路，QFP 记录 `quality.blocking.resolved` resolvedBy=manual。

### 6.4 卷二 41–80 approved 现状（sanity）

| 状态 | 数值 | 来源 |
|---|---|---|
| approved | 24 | vault §生产监管 · 2026-07-17 快照 |
| reviewed | 16 | 同上 |
| ch75–80 approved | ✅ | 同上（clen 4015/4455/3422/3452/3122/3524） |
| AE remain | [] | 同上 · job80 succeeded |

结论：**pipeline 侧已闭环**；剩下 6.1–6.3 是**内容侧**未清；本 milestone 不代写。

## 7. 与既存架构的边界

| 边界项 | 现状 | QFP 上线后 |
|---|---|---|
| `avoidRetry` 语义 | ChapterQualityLoopService 决定 | 不变 · 事件化后可回放 |
| `defer_and_continue` | terminalAction 决议 | 不变 · 事件化 · debt 生命周期可查 |
| `prose_ban` / `repair_exhausted` 语义 | 现有 non-skippable / skippable 分类 | 不变 · 事件化 |
| skip_quality | **禁用**（`vol2-full-supervision-mandate`） | 仍禁用 · QFP 不为绕过而生 |
| Nova 自审 | Novel 项目 AI 自主 | 不变 · 事件化便于 Novel 自审读回放 |
| 监管 agent | poll + 控制面 only | 不变 · 事件化让 poll 面变宽 |
| 机械节奏控制 | **不做**（`feedback_novel-no-mechanical-pacing`） | 仍不做 · QFP 不塞节奏字段 |
| production 生产 | `f13954b` RUNNING | 不动 · 本 plan 落文档 · cutover 另令 |

## 8. 阶段（未来 milestone · 参考）

> 本 plan 为纯规划；下列阶段是**未来**若开代码 milestone 时的建议切分，非本轮任务。

- **P0-1** `QualityEvent` schema + prisma migration + producer 埋点（quality loop + repair + planner）— 只写入不消费
- **P0-2** 写/修/规划三条消费链切换到订阅 QFP，投影层保留旧接口（双写观察 1 周）
- **P0-3** 卷二债 6.1/6.2 由 Novel 自审修复完毕后，代理侧只做 `quality.blocking.resolved` 归零验证（**不代写**）
- **P1** skeleton critique 事件接入（volume 层反馈流打通）
- **P2** DB 迁移优化 · SLO · 大盘 · UI 回放视图
- **P3** 跨小说的 signature 相似度检索

## 9. 验收（本 plan · docs-only）

- `docs/plans/quality-feedback-bus-and-vol2-debt-plan.md` 存在且入 main
- 内容覆盖：目标 / 非目标 / 事件流骨架 / 三向 handoff / 卷二债清单 / 边界 / 未来阶段
- 无代码变更
- 一条 docs commit
- 与 vault `[[ainovel 文档索引]]` §19 「质量反馈总线（待开 milestone）」承诺一致

## 10. Manual-required

- 卷二 ch57/71/74 blocking / ch77「称重」/ ch75「黄振」/ patch adopt — **Novel 项目 AI 自审自修**，代理不代写
- 未来若开代码 milestone，`prisma migrate` / cutover 另令；production 需先建 `appSetting` 表（vault §七点二十六）
- 生产 HEAD `f13954b` 不因本 plan 动

## 11. 关键决策

- 保留「投影」接口，不做破坏性替换 — 双写观察，未来再收敛。
- 事件里不塞 LLM 原文，只塞结构化摘要 + blob 引用 — 防 payload 爆炸。
- QFP 不承担节奏控制 — 那属 Novel 自审。
- QFP 不解除 skip_quality — 硬门不动。
- 卷二债由 Novel 自审修，代理侧只做事件订阅可视，**不代写**。

## 12. 交付提交（计划）

- 单 commit：`docs(qfp-plan): 落地质量反馈总线闭环 + 卷二债清单`
