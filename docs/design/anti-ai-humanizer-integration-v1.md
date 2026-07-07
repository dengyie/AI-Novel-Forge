# 去 AI 味 · Humanizer 适配移植（v1）

## 背景与目标

参考 GitHub `blader/humanizer`（纯 prompt-only 的 Claude Code skill，基于 Wikipedia "Signs of AI writing" 的 33 条英文/博客语域模式），把它的**结构性去 AI 味方法**适配移植进本项目已有的 style-engine 服务链路（deepseek 等 LLM 驱动）。

不照搬 33 条英文规则（wiki/博客语域，中文网文不适用），而是抽取 humanizer 的四个可迁移方法，落到我们已有的五环链路上：

1. **双轮自审改写**（draft → "还有什么像 AI" → final）
2. **聚类检测**（单点从宽、成簇从严）
3. **Voice Calibration**（改写不只删 AI 味，还对齐目标文风）
4. **false-positive 护栏**（不误伤正常表达）

现状诊断：本项目机制五环健全（prompt 约束 → 字面量快扫 → LLM 深检 → 自动改写 → 质量闭环），但此前：
- 改写是**单轮**（detect→rewrite 一次结束，无二次自审）；
- 字面量快扫**无聚类**（命中 1 个 forbidden 就触发 LLM，或整章各套一种 tell 却各 1 次而漏检）；
- 已提取的 StyleProfile language/rhythm rules **在改写阶段没用上**；
- 中文网文语域的通用 AI tell 规则库偏薄（仅 12 条，多为原则级）。

## humanizer 模式 → 本项目映射表

| humanizer 模式 | 本项目落点 | 形式 |
|---|---|---|
| draft→audit→final 双轮循环 | `PostGenerationStyleReviewRunner.run()` | 首轮 rewrite 后 re-detect，残留 riskScore≥阈值才二轮 |
| "clusters not isolated tells" | `StyleDetectionService.computeAntiAiClustering()` | 命中 ≥3 个不同规则判成簇，兜底 riskScore |
| Voice Calibration | `StyleRewriteService.buildVoiceProfileText()` + `styleRewritePrompt` | 从 profile 的 language/rhythm/narrative rules 抽摘要，改写对齐 |
| What NOT to flag（false positive） | `styleDetectionPrompt` SystemMessage | 误判护栏 + 人味保留指引 |
| #31 staccato/punchline | `risk-freeze-frame-ending`（新规则） | 段尾定格式收尾 |
| #8 copula/比喻 | `risk-simile-overuse`（新规则） | 比喻过密且工整 |
| #10 rule of three | `risk-rule-of-three`（新规则） | 强行三段排比 |
| #11 synonym cycling | `risk-elegant-variation`（新规则） | 指代循环换称 |
| #27 authority tropes | `risk-authority-trope`（新规则） | 权威腔空转 |
| #9 negative parallelism | `risk-negative-parallelism`（新规则） | 负向排比堆砌 |
| #14 em dash（中文降级） | `risk-punctuation-driven-emotion`（新规则） | 破折号/省略号驱动情绪 |
| （中文网文实测通用 tell） | `risk-breath-driven-transition`、`risk-weak-adverb-mushroom` | 深吸一口气 / 微微缓缓泛滥 |

**未移植**（英文/博客专属，中文网文无意义）：boldface、emoji、title-case、curly quotes、chatbot artifacts、knowledge-cutoff disclaimer、inline-header list 等。em dash 从 humanizer 的 hard-forbidden 降级为 `risk`（中文破折号/省略号是正常修辞，不硬禁）。

## 三大机制实现

### 1. 双轮自审改写（`PostGenerationStyleReviewRunner`）

```
首轮 detect → riskScore ≥ FIRST_ROUND_REWRITE_THRESHOLD(35) 且有可改写项 → 首轮 rewrite
  → （policy.secondRoundEnabled）对首轮产物 re-detect
    → 残留 riskScore ≥ secondRoundThreshold(默认 50) 且有可改写项 → 二轮 rewrite
硬上限两轮，防无限循环、控成本。
```

- 首轮阈值 35（沿用原逻辑），二轮阈值默认 50（更高，只在仍明显 AI 时才追加）。
- 二轮的 issues 来自对首轮产物的重新检测（humanizer 的 "还有什么像 AI" 自审）。
- `rewriteOnce()` 私有方法供两轮复用，失败或空产物返回 null 回退。

### 2. 聚类检测（`StyleDetectionService`）

抽两个导出纯函数（便于单测）：

- `computeAntiAiClustering(content, rules)`：统计命中的不同规则数（含 forbidden + risk）。forbidden 命中任意 1 个即走 LLM；命中 ≥`CLUSTERING_THRESHOLD`(3) 个不同规则判成簇；forbidden 有字面量但 0 命中且未成簇 → 短路跳过 LLM 省成本。
- `applyClusteredRiskFloor(llmRiskScore, isClustered)`：成簇时把 LLM 输出的 riskScore 抬到 `CLUSTERED_RISK_FLOOR`(45)，防 LLM 低估导致漏放，堵住"整章各套一种 tell"漏检。

### 3. Voice Calibration（`StyleRewriteService`）

- `buildVoiceProfileText(profile)`：从 profile 的 `languageRules`（语域/句式变化/粗粝度）、`rhythmRules`（节奏/推进速度/段落密度）、`narrativeRules`（叙事/收尾方式）抽可读摘要。profile 为 null 或规则全空 → 返回 undefined，改写回退纯去 AI 味行为（不报错）。
- `styleRewritePrompt` 新增可选 `voiceProfileText`：有则在 HumanMessage 注入"目标文风"块，指令改写对齐这套句式/节奏/语域，而非仅删痕迹。

## 规则库扩充

`server/src/services/styleEngine/defaults.ts` 的 `DEFAULT_ANTI_AI_RULES` 新增 9 条通用中文网文 AI tell 规则，全部 `globalBaselineEnabled=true`（全小说生效）、`risk` 级（不硬拦只告警，配合聚类判定 + false-positive 护栏避免误伤）。另扩展 `forbid-explicit-psychology` 的 detectPatterns，补全知旁白句式（他知道/她知道/他清楚/他心里清楚/他心想）。

**字面量 vs 语义规则**：只有能精准字面量匹配的特定套词才配 `detectPatterns`（如"深吸一口气"）；语义结构模式（负向排比、权威腔）的 detectPatterns 留空，纯靠 LLM 语义识别——否则高频词（"不是""而是"）会用 `String.includes()` 几乎必然命中，污染聚类计数。

**生效范围决策**：通用 tell 走 globalBaseline（全书生效）；**小说专属套词**（如某本书的"琥珀色眼睛"）仍留 per-novel StyleProfile，不升 globalBaseline，避免误伤他书合法描写。

## Policy Flag（成本控制）

双轮自审增加 LLM 调用/延迟。渠道慢或要控成本时可用环境变量关闭第二轮，退回单轮：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `HUMANIZER_SECOND_ROUND_ENABLED` | `true` | `false`/`0` 关闭第二轮，退回单轮 |
| `HUMANIZER_SECOND_ROUND_THRESHOLD` | `50` | 首轮产物残留 riskScore 达此值才进第二轮（0-100） |

聚类阈值（`CLUSTERING_THRESHOLD=3`）和兜底下限（`CLUSTERED_RISK_FLOOR=45`）是代码常量，如需灰度可后续提为配置。

## 测试

- `tests/postGenerationStyleReview.test.js`（6）：双轮控制流——低分不改写、单轮收敛、追加二轮、gate 关退单轮、硬上限两轮、policy 关直接返回。mutation 验证有效性。
- `tests/styleClusteringAndVoice.test.js`（13）：聚类判定（含"整章各套一种 tell"漏检回归）、聚类兜底、Voice Calibration 摘要（null/全空/缺字段回退）。
- `tests/humanizerPipeline.integration.test.js`（3）：端到端双轮 riskScore 递降、单轮收敛、聚类捕捉多类痕迹。
- 现有 `tests/style-engine.test.js`（17）回归全绿。

运行：`cd server && node --test tests/postGenerationStyleReview.test.js tests/styleClusteringAndVoice.test.js tests/humanizerPipeline.integration.test.js`（先 `pnpm exec tsc -p tsconfig.json` 构建 dist）。

## Manual-required

- **真 LLM 端到端抽检**：集成测试用 mock LLM 覆盖控制流；真 deepseek 调用的实际去 AI 味效果验证依赖 `.env` 的 provider key，需在配好 LLM 的环境跑真样本人工对比套词频次与可读性。
- **PG 部署**：本次无 schema 改动（新规则走 `defaults.ts` seed，无新表新列），无迁移缺口。新规则在 SQLite 桌面模式和 PG 都通过 seed（`missing_only` 幂等）落库。

## 关键文件

- `server/src/services/styleEngine/defaults.ts` — 规则库（9 新规则 + forbid-explicit-psychology 扩展）
- `server/src/services/styleEngine/StyleDetectionService.ts` — 聚类评分纯函数 + check() 接入
- `server/src/services/styleEngine/StyleRewriteService.ts` — Voice Calibration 摘要 + 接入
- `server/src/services/novel/runtime/PostGenerationStyleReviewRunner.ts` — 双轮自审 loop
- `server/src/services/novel/runtime/PostGenerationStyleReviewPolicyResolver.ts` — secondRound policy
- `server/src/prompting/prompts/style/style.prompts.ts` — detection 聚类/护栏指引 + rewrite 自审/voice
