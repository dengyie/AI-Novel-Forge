# 正文质量至上 · 去 AI 味 · 完整改稿流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「写完即可过审」改成「质量至上的定稿流水线」：确定性拦 他/她 堆叠与其它 AI 味硬信号；Style Review 支持热点段落多候选改写；残留文风债进入 qualityLoop 且关键章可强制风格门；写 ≠ 完成。

**Architecture:** 在既有唯一执行链（`ChapterExecutionStageRunner` → `ChapterContentFinalizationService` → acceptance / `detectProseQuality` → autoReview / autoRepair / qualityLoop）上纵深加固，**不**新建并行质量状态机。L0 机械检测加指代密度码；StyleDetection 补可字面匹配的 pronoun/stack 规则；PostGenerationStyleReview 从「整章 ≤2 轮」扩展为「热点段落 multi-candidate + evaluate-adopt」；残留 `residualReport` / pronoun findings 投影进 qualityLoop，使 `!styleClear` 在开篇/关键章不可 `completed`。深度仿写复用现有 StyleProfile / `from_book_analysis`，本里程碑只做绑定与 prompt 强化，不重做结构仿写（见 `imitation-writing-and-chain-hardening-plan.md`）。

**Tech Stack:** TypeScript monorepo（`server` + `shared`）、现有 `ProseQualityDetector` / StyleEngine / `PostGenerationStyleReviewRunner` / `isLiteraryQualityPass` / qualityLoop、node:test、pnpm filter tests。

## Global Constraints

- **禁止**策略化 `skip_quality_repair`、盲批、无根因 `forceResume` 当质量门。
- **不做**机械字数/松紧硬闸进 isPass（短章可观测 tag 可保留）。
- **不**引入 `writingQualityMode` 三级灰度主架构；抬质量的改动默认开（可有窄 port/policy，缺省 = 新行为）。
- 本里程碑 **不**自动恢复生产写书 / 不重写《源世界》ch1 / 不 `forceResume` 卷一 task。
- Style review **整 runner 抛错**仍可回退原文不炸 finalize；但 **已检测到的 L0 指代硬伤**必须能挡 quality 过审（与 HUD/sot 同级纪律）。
- 修文 adopt 纪律：任何自动改正文 `baseline → candidate → evaluate → adopt|discard`（与 writing-quality P0 一致）。
- 书无关：阈值与规则默认 book-agnostic；可选 novel policy 只收紧不放宽硬门。
- 产品硬原则：监管卡点先查日志/修根因，禁止无脑放行。

**正交计划（不替代）**

| 计划 | 关系 |
|---|---|
| `writing-quality-architecture-plan.md` | 已交付 adopt/isPass/L0 SoT；本计划叠 AI 味与改稿形态 |
| `writing-quality-hardgate-architecture-plan.md` | L0 不可 defer 降级；本计划新码接入同一 classify |
| `director-self-cycle-pipeline-plan.md` | 吞吐/续窗；本计划抬单章正文质量 |
| `imitation-writing-and-chain-hardening-plan.md` | 结构仿写与最后一公里；本计划只做文风仿写绑定强化 |
| `docs/humanizer-reference/SKILL.md` | 人工 humanize 参考；算法侧借鉴 draft→audit→final，不整文件嵌进 runtime |

**取证（生产 ch1 《冷席除名》，本地导出 2026-07-17）**

| 指标 | 值 | 含义 |
|---|---|---|
| 非空白字约 | 2563 | 开篇体量 |
| `他` 出现 | 124 | 指代过密 |
| 句首 `他` | ~68–70 / 187 句 | 主语机械起句 |
| 连续句首 `他` max run | **7** | 堆叠 AI 味核心信号 |
| 何屿 / 他 | 29 / 124 ≈ 0.23 | 专名过稀 |
| settingAlignment | 70 soft fails | 尊严/冷暴力/沈晚小善等关键词软缺口（本里程碑不主修设定对齐） |

结论：现有 L0 有 `prose_period_stutter`（短句碎裂）与 anti-AI「他感到/他知道」，**没有**「句首他密度 / 连续主语堆叠」；Style Review 失败不挡定稿；整章 rewrite 对局部堆叠命中率低。必须加确定性密度门 + 段落级改写。

---

## Milestone 契约（冻结）

```text
Milestone：正文质量至上 · 去 AI 味 · 完整改稿流水线 P0
目标：新生成章默认经「密度 L0 + 热点多候选文风改 + 风格/文学门」后才可质量过审；开篇/关键章风格残留不可 completed
P0/P1 范围：
  - P0-1 指代/主语堆叠确定性 L0 + 测试（含 ch1 热力回归样本）
  - P0-2 StyleDetection/默认 anti-AI 规则字面可检 + 注入 rewrite 议题
  - P0-3 热点段落 multi-candidate style review + adopt 门
  - P0-4 residual / pronoun L0 投影 qualityLoop；开篇/关键章 styleClear 硬门
  - P1-5 仿写绑定强化（style_contract 必现契约测 + 开篇 voice 提示）与验收套件
不做的 P2/P3：
  - 全书 ch1–N 人工/自动重写生产正文
  - 结构主参考产品化（imitation plan Phase2）
  - 前端改稿工作台大改 / 段落 diff UI
  - 新建并行 quality 状态机或 writingQualityMode
  - 自动砍 taskSheet 义务条
Manual-required：发版 pxed；发版后另开监管 resume/rewrite 指令
阶段上限：5
阶段拆分：见 Task 1–5
验收标准：见文末 Acceptance
停止条件：P0/P1 测绿 + 文档落盘 + 原子 commit；不自动开下一 milestone；不写生产书
```

**推荐默认**

| 项 | 值 |
|---|---|
| 句首第三人称代词密度软阈 | ≥ 0.35 句 → finding medium |
| 句首第三人称代词密度硬阈 | ≥ 0.45 或 maxRun≥4 → high/critical，进 non-deferrable |
| 专名/代词比提示 | 主角名计数 / `他|她` < 0.15 且句首他≥0.35 → 附加 medium |
| Style 首轮 risk 阈值 | 保持 35；pronoun L0 独立于 riskScore |
| 热点段落 | 连续句首代词 run≥3 的段落，或 detect 命中 excerpt 所在段 |
| multi-candidate | 每热点 K=2（默认），evaluate 后 adopt 更优；并列取 residual 更低 |
| 开篇关键章 | `chapter.order ≤ 3` 或 policy `styleGateChapters`；`!styleClear` 不得 completed |
| MAX style paragraph rewrite rounds | 1 轮多候选（成本控）；整章二轮策略保留 |

---

## File map（本里程碑）

| 动作 | 路径 | 职责 |
|---|---|---|
| 改 | `server/src/services/novel/runtime/proseQuality/ProseQualityDetector.ts` | 新 issue code + 密度扫描 |
| 改 | `shared` 若有 prose code 联合类型 / qualityLoop signal 映射 | 与 detector 同步 |
| 改 | `server/src/services/styleEngine/defaults.ts` | pronoun stack 可字面 detectPatterns |
| 改 | `server/src/services/styleEngine/StyleDetectionService.ts` | 确定性 pronoun 预检合并进 risk（可选薄封装） |
| 改 | `server/src/services/styleEngine/StyleRewriteService.ts` | 支持段落 scope rewrite API（或新 thin helper） |
| 改 | `server/src/services/novel/runtime/PostGenerationStyleReviewRunner.ts` | 热点 multi-candidate |
| 新建 | `server/src/services/novel/runtime/styleReview/HotspotParagraphRewrite.ts` | 纯函数：切段、选热点、拼回、评优 |
| 改 | `server/src/services/novel/runtime/ChapterContentFinalizationService.ts` | 可选：把 pronoun L0 与 style residual 写入 package |
| 改 | qualityLoop 组装处（pipeline / riskFlags 投影，以现有 `classifyChapterQualityLoopRisk` 入口为准） | `style_pronoun` / residual signals |
| 改 | literary / completed 门（与 hardgate 同路径：`mergeChapterPatch…` / auto-review） | styleClear 条件 |
| 扩测 | `server/tests/proseQualityDetector.test.js` | ch1 样本与阈值边界 |
| 新建测 | `server/tests/hotspotParagraphRewrite.test.js` | 多候选 adopt/discard |
| 扩测 | `server/tests/style-engine.test.js` 或 style review 测 | residual + gate |
| 新建测 | `server/tests/proseQualityAiTasteAcceptance.test.js` | 端到端契约（mock LLM） |
| 改 | `docs/wiki/workflows/chapter-production-chain.md` | 增补定稿步骤（阶段末小改） |
| 本文件 | `docs/plans/2026-07-17-prose-quality-ai-taste-revision-plan.md` | 权威实现计划 |

---

### Task 1: 指代/主语堆叠确定性 L0

**Files:**
- Modify: `server/src/services/novel/runtime/proseQuality/ProseQualityDetector.ts`
- Modify: any exported `ProseQualityIssueCode` re-exports / hardgate non-deferrable sets（搜索 `prose_system_hud` / `hasNonDeferrableProseOrSotDebt`）
- Test: `server/tests/proseQualityDetector.test.js`
- Fixture（测试内联字符串即可）: 从 ch1 热力提炼的「连续句首他」迷你样本 + 干净对照样本

**Interfaces:**
- Produces:
  - `ProseQualityIssueCode` 新增：
    - `"prose_pronoun_subject_stack"` — 连续句首第三人称代词 run
    - `"prose_pronoun_density"` — 全章句首代词占比过高
  - （可选 P1）`"prose_name_pronoun_imbalance"` medium only
  - `export const PROSE_PRONOUN_SUBJECT_STACK_RUN_HARD = 4`
  - `export const PROSE_PRONOUN_SENTENCE_START_DENSITY_HARD = 0.45`
  - `export const PROSE_PRONOUN_SENTENCE_START_DENSITY_SOFT = 0.35`
- Consumes: 现有 `detectProseQuality` / `ProseQualityFinding` 形状；对话行跳过逻辑对齐 `lineLooksLikeDialogue`

- [ ] **Step 1: Write the failing tests**

在 `server/tests/proseQualityDetector.test.js` 追加（名称可微调，断言必须存在）：

```js
const { detectProseQuality } = require("../dist/services/novel/runtime/proseQuality/ProseQualityDetector.js");

test("prose_pronoun_subject_stack: max consecutive 句首他 ≥4 → high/critical finding", () => {
  const body = [
    "他推开门。",
    "他看见空位。",
    "他没有坐。",
    "他转身离开。",
    "风从走廊尽头压过来。",
  ].join("");
  const report = detectProseQuality(body);
  const hit = report.findings.find((f) => f.code === "prose_pronoun_subject_stack");
  assert.ok(hit, "must flag subject stack");
  assert.ok(hit.severity === "high" || hit.severity === "critical");
  assert.equal(report.hasBlockingFindings, true);
});

test("prose_pronoun_density: high 句首他 ratio without long run still flags density", () => {
  // 构造 ≥10 句，句首他占比 ≥0.45，但中间插入打断使 maxRun < 4
  const parts = [];
  for (let i = 0; i < 10; i += 1) {
    parts.push(i % 2 === 0 ? "他点了下头。" : "灯还亮着。");
  }
  const report = detectProseQuality(parts.join(""));
  assert.ok(report.findings.some((f) => f.code === "prose_pronoun_density"));
});

test("dialogue-leading 他 is not counted as narrative subject stack", () => {
  const body = [
    "「他不会来。」赵哥说。",
    "「他凭什么。」黄助教冷笑。",
    "「他算什么东西。」又有人接话。",
    "「他滚了最好。」",
  ].join("\n");
  const report = detectProseQuality(body);
  assert.equal(
    report.findings.some((f) => f.code === "prose_pronoun_subject_stack"),
    false,
  );
});

test("ch1-like heatmap sample: 7× 句首他 run is blocking", () => {
  const body = Array.from({ length: 7 }, () => "他没有反驳。").join("") + "沈晚把杯子放下。";
  const report = detectProseQuality(body);
  assert.ok(report.findings.some((f) => f.code === "prose_pronoun_subject_stack"));
  assert.equal(report.hasBlockingFindings, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/mango/project/claude-project/AI-Novel-Writing-Assistant
pnpm --filter @ai-novel/server test -- proseQualityDetector
```

Expected: FAIL — unknown code / no findings.

- [ ] **Step 3: Minimal implementation**

1. 扩展 `ProseQualityIssueCode` 联合类型。
2. 新增扫描（建议独立 `scanPronounSubjectStack` / `scanPronounDensity`）：
   - 分句：复用或对齐现有 `splitSentences`；**跳过**对话行（`lineLooksLikeDialogue` / 引号主导）。
   - 句首第三人称：`/^\s*[他她它]/u`（叙事句；「它」可计入 density 但 stack 以 他/她 为主，实现时在注释写清）。
   - stack：max consecutive ≥ `PROSE_PRONOUN_SUBJECT_STACK_RUN_HARD` → finding；severity：run≥6 critical，else high。
   - density：句首代词句数 / 有效叙事句数；≥ HARD → high + `hasBlockingFindings`；≥ SOFT 且 < HARD → medium（不单独 block，除非 hardgate 表另列）。
3. 将 **high/critical** 的 `prose_pronoun_subject_stack` 与 hard density 纳入 **non-deferrable** 集合（与 `prose_system_hud` / sot 同一函数），确保 `projectL0Clear` / classify 为 blocking。
4. `fixSuggestion` 中文：要求改用专名、动作主语、环境起句、合并视角，禁止循环换称（主角/少年/男人）。

伪代码锚点：

```ts
// inside detectProseQuality after existing scans
scanPronounSubjectStack(segments, addFinding);
scanPronounDensity(segments, addFinding);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server test -- proseQualityDetector
```

Expected: PASS for new cases; existing stutter/HUD/sot still green.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/novel/runtime/proseQuality/ProseQualityDetector.ts \
  server/tests/proseQualityDetector.test.js \
  # + any non-deferrable map files touched
git commit -m "$(cat <<'EOF'
feat(phase-1): L0 pronoun subject stack and density gates

Detect consecutive sentence-initial 他/她 runs and high pronoun-start
density as blocking prose quality, with dialogue-safe skips.
EOF
)"
```

---

### Task 2: Style 规则可检 + 检测侧合并 pronoun 信号

**Files:**
- Modify: `server/src/services/styleEngine/defaults.ts`（`DEFAULT_ANTI_AI_RULES` / 指代循环）
- Modify: `server/src/services/styleEngine/StyleDetectionService.ts`（确定性预检或 risk 抬升）
- Test: `server/tests/style-engine.test.js` 或 `styleClusteringAndVoice.test.js`

**Interfaces:**
- Produces: 新/强化 rule keys，例如：
  - `forbid-pronoun-subject-stack`（type forbidden，`detectPatterns` 可为空但 **runtime 附加** deterministic scanner 结果）
  - 强化 `指代循环换称` 的 `detectPatterns` 若有稳定字面（慎：避免误伤）
- 约定：`StyleDetectionService.check` 在 LLM 路径之外，把 `detectProseQuality` 的 pronoun findings **映射为 violations**（`canAutoRewrite: true`，suggestion 来自 fixSuggestion），并 `applyClusteredRiskFloor` 同类抬 riskScore，保证 ≥35 能进 rewrite。

- [ ] **Step 1: Failing test**

```js
test("style check maps pronoun subject stack into rewritable violations with elevated risk", async () => {
  const body = Array.from({ length: 5 }, () => "他没有说话。").join("");
  // 使用可注入的 StyleDetectionService 或集成 check；无 style profile 时仍应有 deterministic pronoun violations
  const report = await styleDetectionService.check({ content: body, novelId: "n1", /* minimal */ });
  assert.ok(report.violations.some((v) => /指代|主语|他/.test(v.ruleName + v.excerpt + (v.suggestion || ""))));
  assert.ok(report.riskScore >= 35 || report.violations.some((v) => v.canAutoRewrite));
});
```

（按现有 `check` 签名补齐必填字段；从 `style-engine.test.js` 抄最小 fixture。）

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @ai-novel/server test -- style-engine
```

- [ ] **Step 3: Implement**

1. `defaults.ts`：增加 rule 定义（promptInstruction 明确：连续句勿「他…他…他」；改专名/动作/环境）。
2. `StyleDetectionService`：在 LLM 调用前或合并结果时：

```ts
const prose = detectProseQuality(content);
const pronounViolations = prose.findings
  .filter((f) => f.code === "prose_pronoun_subject_stack" || f.code === "prose_pronoun_density")
  .map(findingToStyleViolation);
// merge + riskScore = max(llmRisk, deterministicFloor)
```

3. **不要**让 elegant-variation 空 patterns 继续假装可检；对「指代循环」若仍无可靠字面，依赖 Task1 确定性码，不在本任务发明脆弱 regex 扫全文。

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(phase-2): map pronoun L0 into style detection rewritable risks
EOF
)"
```

---

### Task 3: 热点段落 multi-candidate Style Review

**Files:**
- Create: `server/src/services/novel/runtime/styleReview/HotspotParagraphRewrite.ts`
- Modify: `server/src/services/novel/runtime/PostGenerationStyleReviewRunner.ts`
- Modify: `server/src/services/styleEngine/StyleRewriteService.ts`（若需 `rewriteParagraph` / `scope` 字段）
- Test: `server/tests/hotspotParagraphRewrite.test.js`
- 扩：既有 PostGenerationStyleReview 相关测（若无则新建 `postGenerationStyleReview.test.js`）

**Interfaces:**

```ts
// HotspotParagraphRewrite.ts
export type ParagraphSlice = { index: number; text: string; start: number; end: number };

export function splitNarrativeParagraphs(content: string): ParagraphSlice[];

export function selectPronounHotspotParagraphs(
  content: string,
  options?: { minRun?: number; maxHotspots?: number },
): ParagraphSlice[]; // default minRun=3, maxHotspots=4

export function stitchParagraphs(
  original: string,
  replacements: Array<{ index: number; text: string }>,
): string;

export function pickBetterStyleCandidate(input: {
  baseline: string;
  candidates: string[];
  score: (text: string) => { riskScore: number; blockingPronoun: boolean; lengthDelta: number };
}): { content: string; adoptedIndex: number | null; reason: string };
// adoptedIndex null = keep baseline
```

`PostGenerationStyleReviewRunner.run` 扩展行为（保持对外 `StyleReviewResult` 字段；可加可选 `hotspotRewrites?: number` 仅测用或 metadata）：

```text
existing whole-chapter path (risk≥35, ≤2 rounds)
        │
        ▼
after final whole-chapter candidate (or if risk<35 but pronoun L0 hotspots exist):
  select hotspots → for each hotspot:
    generate K=2 paragraph rewrites (StyleRewriteService with issuesBlock=local)
    stitch → score with detectProseQuality + style residual risk
    adopt only if !worse (no new L0 hard, pronoun improved or risk↓, length not collapse)
        │
        ▼
residualReport on full stitched content
```

**Adopt 门（段落级，对齐 repairAdopt 精神）**

- discard if：引入 `prose_system_hud` / sot / critical；或 blocking pronoun 未改善且 risk↑；或可见字数 < baseline×0.5（防删段）。
- adopt if：blocking pronoun 消失或 density↓，且 riskScore ≤ baselineRisk + ε。

- [ ] **Step 1: Pure unit tests (no LLM)**

```js
test("selectPronounHotspotParagraphs picks paragraph with run≥3", () => {
  const content = [
    "沈晚看了他一眼。\n\n",
    "他坐下。他端杯。他没喝。\n\n",
    "走廊里有人经过。",
  ].join("");
  const hits = selectPronounHotspotParagraphs(content, { minRun: 3 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /他坐下/);
});

test("pickBetterStyleCandidate discards worse candidate with new HUD", () => {
  const picked = pickBetterStyleCandidate({
    baseline: "他走进教室。",
    candidates: ["【系统】任务完成。他走进教室。", "何屿走进教室。"],
    score: (text) => ({
      riskScore: text.includes("【") ? 90 : text.includes("何屿") ? 10 : 40,
      blockingPronoun: /他走进/.test(text) && !text.includes("何屿"),
      lengthDelta: text.length - 6,
    }),
  });
  assert.match(picked.content, /何屿/);
});

test("stitchParagraphs preserves non-replaced segments", () => {
  // ...
});
```

- [ ] **Step 2: Run — FAIL (module missing)**

```bash
pnpm --filter @ai-novel/server test -- hotspotParagraphRewrite
```

- [ ] **Step 3: Implement pure helpers + wire runner with injectable rewrite**

`StyleRewriteService.rewrite` 已是整段 `content`；段落级直接传 paragraph text + issuesBlock 即可，**不必**改 prompt asset，除非 issues 需要 `scope: paragraph` 提示——若改 prompt，同步 registry 与测试。

Runner 伪逻辑：

```ts
const hotspots = selectPronounHotspotParagraphs(finalContent);
if (hotspots.length > 0) {
  let working = finalContent;
  for (const hot of hotspots) {
    const candidates = await Promise.all(
      [0, 1].map(() => this.rewriteParagraph(input, hot.text, localIssues)),
    );
    const stitchedCandidates = candidates
      .filter(Boolean)
      .map((c) => stitchParagraphs(working, [{ index: hot.index, text: c }]));
    const pick = pickBetterStyleCandidate({ baseline: working, candidates: stitchedCandidates, score: this.scoreText });
    working = pick.content;
  }
  finalContent = working;
  residualReport = await this.detect(input, finalContent).catch(() => residualReport);
}
```

成本：热点上限 4、K=2；policy 可关 `hotspotRewriteEnabled`（默认 true）。

- [ ] **Step 4: Integration test with mocked StyleRewriteService**

断言：连续「他」段经 mock 返回「何屿…」后 residual/prose stack 消失；mock 返回 HUD 时保持 baseline。

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(phase-3): multi-candidate hotspot paragraph style rewrite
EOF
)"
```

---

### Task 4: 完整改稿门 — styleClear + qualityLoop 投影

**Files:**
- Modify: qualityLoop signal 构建路径（定位：`shared/types/chapterQualityLoop.ts` 的 assessment 组装调用方；pipeline auto-review / `ChapterRuntimeCoordinator` 附近——实现时以 `rg prose_quality|literary_score` 为准）
- Modify: completed 门（`mergeChapterPatchForGenerationStateBump` 或 auto-review 写 `chapterStatus=completed` 处）
- Modify: `ChapterContentFinalizationService` / runtime package：暴露 `styleReview.residualReport` 与 pronoun L0 摘要
- Test: 扩 hardgate / qualityLoop 相关测；新建断言 styleClear

**Interfaces:**

```ts
// shared 薄函数，便于单测
export function projectStyleClear(input: {
  residualRiskScore: number | null;
  hasBlockingPronounProse: boolean;
  chapterOrder: number;
  styleGateMaxOrder?: number; // default 3
  residualRiskHard?: number; // default 35 for gated chapters
}): boolean;

// 规则：
// - hasBlockingPronounProse → false
// - chapterOrder ≤ styleGateMaxOrder 且 residualRiskScore ≥ residualRiskHard → false
// - 非关键章：blocking pronoun 仍 false；仅 residual 高 → 可 defer 记债但不 completed
```

qualityLoop：新增 signal kind（名称对齐现有 enum/字符串惯例，实现时读 `chapterQualityLoop.ts`）：

- `style_pronoun` invalid when blocking pronoun
- `style_residual` risk when residual ≥ threshold on gated chapters

`recommendedAction=continue` / `chapterStatus=completed`：**不得**在 `!projectStyleClear` 且关键章时质量过审（与 `!literaryPass` 纪律一致）。导演 `defer_and_continue` 可读可续，但 **不是**质量过审。

- [ ] **Step 1: Failing tests**

```js
test("projectStyleClear false on opening chapter with residual risk 50", () => {
  assert.equal(projectStyleClear({ residualRiskScore: 50, hasBlockingPronounProse: false, chapterOrder: 1 }), false);
});

test("projectStyleClear false when blocking pronoun even mid-book", () => {
  assert.equal(projectStyleClear({ residualRiskScore: 0, hasBlockingPronounProse: true, chapterOrder: 40 }), false);
});

test("projectStyleClear true when mid-book residual only", () => {
  assert.equal(projectStyleClear({ residualRiskScore: 50, hasBlockingPronounProse: false, chapterOrder: 40 }), true);
});

test("A-style: !styleClear cannot quality-over-approve completed on ch1", () => {
  // 复用 hardgate 测风格：构造 qualityLoop + patch merge 或 auto-review pure function
});
```

- [ ] **Step 2: Run FAIL → Step 3 implement → Step 4 PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(phase-4): styleClear gate and qualityLoop projection for AI-taste debt
EOF
)"
```

---

### Task 5: 仿写绑定强化 + 验收套件 + wiki

**Files:**
- Test 扩: `server/tests/chapterLayeredContext.test.js` — `style_contract` 在绑定 StyleProfile 时 **必须出现且非空**（与 imitation plan PR0-A 对齐，本里程碑只收 `style_contract` + 开篇 voice 相关）
- Modify（薄）: writer style 注入若开篇 order≤3 追加固定中文提示块「开篇忌连续句首他/她；优先专名与动作起句」（优先进 `style_contract` 或 anti-AI directive 组装处，**禁止**在 service 内联超长 prompt）
- Create: `server/tests/proseQualityAiTasteAcceptance.test.js`
- Modify: `docs/wiki/workflows/chapter-production-chain.md` — 定稿步骤增加 pronoun L0 + hotspot rewrite + styleClear
- 本计划文首状态改为「实现中/已交付」由执行者更新

**Acceptance suite（mock LLM，不打真网）**

```js
test("acceptance: ch1-like stack draft cannot complete without rewrite path clearing pronoun L0", async () => {
  // finalize with mocked rewrite that fixes 他-stack → styleClear true path
});

test("acceptance: rewrite introducing HUD is discarded; baseline retained; still not styleClear", async () => {
});

test("acceptance: mid-book residual-only does not set non-deferrable L0 but records style_residual debt signal", async () => {
});

test("acceptance: no skip_quality_repair strategy default in continue/follow-up mapping", async () => {
  // 回归 writing-quality A7/A-H10 精神
});
```

- [ ] **Step 1–4:** 写测 → 红 → 薄实现 → 绿

- [ ] **Step 5: typecheck + 定向测**

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server typecheck
pnpm --filter @ai-novel/server test -- proseQualityDetector hotspotParagraphRewrite proseQualityAiTasteAcceptance style-engine
```

- [ ] **Step 6: production-code-quality-review**（执行阶段用 skill 审本里程碑 diff）

- [ ] **Step 7: Commit**

```bash
git commit -m "$(cat <<'EOF'
test(phase-5): AI-taste acceptance suite and style_contract open-chapter hardening
EOF
)"
```

---

## 目标流水线（To-Be）

```text
draft (writer)
    │
    ▼
PostGenerationStyleReview
    ├─ whole-chapter detect/rewrite (≤2, risk≥35)
    └─ hotspot multi-candidate paragraph rewrite (pronoun stacks)
    │
    ▼
detectProseQuality  (+ pronoun stack/density L0)
    │
    ▼
acceptance / literary scores
    │
    ▼
autoReview + qualityLoop signals
    ├─ L0 non-deferrable (HUD/sot/critical/pronoun hard)
    ├─ styleClear (opening/key)
    └─ literary isPass (80/75/75)
    │
    ▼
autoRepair only via adopt|discard（禁止 skip_quality）
    │
    ▼
completed 仅当：l0Clear ∧ styleClear(关键) ∧ literaryPass
else：needs_repair / quality debt / defer_and_continue（非质量过审）
```

**写 ≠ 完成**：定稿状态机以门禁真源为准，不因「已有 content」或 style runner 抛错回退原文而自动 completed。

---

## 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | 密度阈值误伤对话/多角色他指 | 对话跳过；只计句首；测对话样本 |
| R2 | 段落 rewrite 丢义务/改坏剧情 | adopt 门 + length 下限 + L0 regress；不删 mustHit（义务仍走既有 repair） |
| R3 | LLM 成本上升 | maxHotspots=4、K=2、policy 可关；非热点不跑 |
| R4 | style runner 失败仍交烂稿 | pronoun L0 在 detect 侧硬拦，不依赖 rewrite 成功 |
| R5 | 与设定对齐 soft fail 混淆 | 本里程碑不把 settingAlignment 并进 styleClear |
| R6 | 生产未发版旧行为 | port/默认新开；发版 Manual-required |

---

## Acceptance（里程碑完成定义）

1. `detectProseQuality` 对 ch1-like 7× 句首他 **blocking**；对话样本不误杀。  
2. Style path 能把 pronoun finding 变成可改写 violations；热点多候选 discard HUD、adopt 去堆叠。  
3. 开篇 `!styleClear` 不得 `chapterStatus=completed` 质量过审。  
4. 无任何默认 `skip_quality_repair` 策略映射。  
5. `proseQualityAiTasteAcceptance` + 相关单测绿；shared build + server typecheck 通过。  
6. wiki 生产链文档已描述新步骤。  
7. **不**自动恢复 pxed 写书。

---

## 实现期执行口径

- 工作目录：`AI-Novel-Writing-Assistant`
- 每阶段：实现 → 测试 → `production-code-quality-review` → commit → 阶段总结
- 审查不通过最多修 3 轮阻断项
- Milestone 完成后输出《项目交付总结》并停止

## 交付后（Manual-required，非本计划自动执行）

1. 发版部署 pxed  
2. 另令：是否重写开篇窗 / 新开书 / 仅对新章生效  
3. 监管只 poll + 有根因 resume；禁盲批  

---

## Self-review (plan author)

| Spec 支柱 | Task |
|---|---|
| 质量至上 | T4 门禁 + T5 acceptance；adopt 纪律贯穿 T3 |
| 去 AI 味（他他他） | T1 L0 + T2 detect 映射 + T3 热点改 |
| 深入仿写 | T5 style_contract 契约 + 开篇 voice；结构仿写不在范围 |
| Review 多生成段落分析 | T3 multi-candidate hotspot |
| 完整修改流程 | To-Be 流水线 + T4 styleClear + 写≠完成 |
| 热力取证 | 文首表 + T1 ch1-like 样本 |
| 无 placeholder | 阈值/路径/测例已写具体值 |

**类型一致性：** `ProseQualityIssueCode` 新码 → non-deferrable → style violation map → `projectStyleClear` → completed 门，名称在各 Task Interfaces 对齐。

---

## 深入可行性 Review（执行前，2026-07-17）

> **结论：方向正确，可 Inline 执行；不得盲跟原文实现。** 下列 P0/P1 为必改接线，已并入本文件执行口径。

### 总评

| 维度 | 判定 | 说明 |
|---|---|---|
| 问题定义 | ✅ | ch1 热力（句首他 run=7、密度高）与现网缺口（无 pronoun L0、style 失败不挡 completed）对齐 |
| 架构边界 | ✅ | 加深唯一流水线；禁 writingQualityMode / 并行状态机 / skip_quality — 与 hardgate 一致 |
| T1 可行性 | ✅ P0 正确优先 | 纯 detector + non-deferrable 集合；可独立测绿 |
| T2 可行性 | ⚠️ 原文会空转 | `shouldSkipLlm` / 空 contract 短路 → risk 0；必须**无条件** merge pronoun violations |
| T3 可行性 | ✅ | 纯 HotspotParagraphRewrite + mock rewrite；runner 后置热点路径 |
| T4 可行性 | ⚠️ 原文不完整 | 仅 `projectStyleClear` helper **不能**挡 completed；须改写路径 + residual 常算 |
| T5 可行性 | ✅ 薄 | acceptance + style_contract 契约即可 |
| 与 hardgate 兼容 | ⚠️ 需改冻测 | 新码入 `NON_DEFERRABLE_*` 必更新 `isNonDeferrable…covers sot and critical prose only` 与 A-H* |

**总体：有条件通过。** Inline 时 Task1 先落地硬门；T2–T4 按下方 Must-fix 接线，不按脆弱假设实现。

### P0 必改（否则验收失败）

1. **T1 → non-deferrable 真源**  
   - `hasBlockingFindings`（high|critical）≠ qualityLoop `prose_quality invalid` / `l0Clear false`。  
   - hard density / subject stack（high|critical）码 **必须**加入 `NON_DEFERRABLE_PROSE_OR_SOT_ISSUE_CODES`（`shared/types/chapterQualityLoop.ts` L119–127）。  
   - 同步改冻测：`chapterQualityLoop.test.js`「covers sot and critical prose only」；hardgate A-H* 若断言集合封闭性则扩白名单。  
   - soft density（medium）**不**进 non-deferrable（与 negative_flip 纪律一致）。

2. **T2 StyleDetection 短路**  
   - 证据：`StyleDetectionService.check` — 无 contract+antiRules → risk 0；`shouldSkipLlm` → risk 0 + empty violations。  
   - 纯 pronoun 堆叠**没有** forbidden 字面量时永远不进 rewrite。  
   - **Must-fix：** 在 **所有** early-return 之前/之后仍 merge `detectProseQuality` 的 pronoun findings → violations；`riskScore = max(llm|0, deterministicFloor)`，stack/hard density 抬到 ≥35。  
   - 或：T3 已写「risk&lt;35 但 pronoun L0 热点仍跑」——两路都做，纵深防御。

3. **T4 residualReport 无 rewrite 时为 null**  
   - 证据：`PostGenerationStyleReviewRunner` `noRewriteResult` / `autoRewritten ? residualReport : null`。  
   - 开篇烂稿若 risk&lt;35 且未 rewrite，`residualReport=null` → `projectStyleClear` 若只看 residual 会误 true。  
   - **Must-fix：** 始终保留**交付正文**的 detect 结果（至少 residualRisk 与 pronoun 摘要）；无 rewrite 时 residual = 原文 detect，不得 null 掉可观测质量。

4. **T4 completed 写路径**  
   - 证据：`chapterStatePairAfterLiteraryQualityGate(literaryPass)` **仅** literary；call sites：`ChapterRepairStreamRuntime`、`mergeChapterPatchForGenerationStateBump` A6。  
   - **Must-fix：** 关键章 completed = `literaryPass ∧ styleClear ∧ l0Clear`（或等价：blocking pronoun / 开篇 residual 硬门在同一写路径 AND）。  
   - 禁止只加 pure helper 却不改 auto-review / repair / bump 写库。

### P1 建议（执行中落实，不单开阶段）

5. **T3 adopt 对齐 repairAdopt**：新 HUD/sot/critical → discard；length &lt; 0.5×baseline → discard；pronoun 未改善且 risk↑ → discard。  
6. **对话假阳性**：stack/density 复用 `lineLooksLikeDialogue` + `splitSentences`；对话句不计入句首 run。  
7. **密度 HARD=0.45 / stack RUN=4**：ch1 样本必红；中文网文偶发 2–3 连他不误杀。  
8. **T5** 不重做结构仿写；仅 style_contract 非空 + 开篇 voice 提示块。

### 证据锚点（代码）

| 断言 | 位置 |
|---|---|
| 无 pronoun codes | `ProseQualityDetector.ts` `ProseQualityIssueCode` |
| non-deferrable 封闭集 | `chapterQualityLoop.ts` L119–127 |
| channel-1 invalid 仅 non-deferrable | `buildProseQualitySignal` + A-H6b |
| style skip-LLM | `StyleDetectionService.ts` ~L122–147 |
| residual null on no rewrite | `PostGenerationStyleReviewRunner.ts` ~L132 / L139–149 |
| completed 仅 literaryPass | `chapterLifecycleState.ts` L47–54 / A6 L88–110 |
| 可复用分句/对话 | `splitSentences` / `lineLooksLikeDialogue` |

### 对计划正文的执行补丁（绑定实现）

- **Task1 Step3 强制：** 改 `NON_DEFERRABLE_PROSE_OR_SOT_ISSUE_CODES` 加入 `prose_pronoun_subject_stack`；`prose_pronoun_density` **仅当 severity high|critical** 时由集合包含码名（码固定入集；medium density finding 用同一 code 但 soft 不标 high — 实现上 hard density 用 high，soft 用 medium，集合含 code 即可，invalid 由 severity 路径？）  
  **澄清（实现锁定）：**  
  - channel-1 `invalid` **只看 code ∈ non-deferrable 集合**，不看 severity。  
  - 因此：**soft density 必须用不同 code 或不得把 density code 整码进 non-deferrable。**  
  - **锁定方案：**  
    - `prose_pronoun_subject_stack` → 始终 high/critical → **入 non-deferrable**  
    - `prose_pronoun_density` soft → medium，**不入** non-deferrable  
    - hard density → 用 **同一 code** 但 severity high：若 code 入集则 medium 也会 invalid → **错误**。  
    - **正确做法：** hard density 也发 `prose_pronoun_subject_stack` 不适用；改为 hard density 使用 code **`prose_pronoun_density` 入 non-deferrable**，soft 使用 **`prose_pronoun_density_soft`**（medium only，不入集）**或** soft 不发独立 finding、仅 metrics。  
    - **本里程碑锁定（最简）：** soft density → medium `prose_pronoun_density` **不**入 non-deferrable；hard density → high `prose_pronoun_density` **且** 同步 `hasBlockingFindings`；qualityLoop invalid 对 density **仅**当 severity high 时——**与现 buildProseQualitySignal 冲突**（invalid 只看 code）。  
    - **最终锁定（与 hardgate 一致）：**  
      1. `prose_pronoun_subject_stack` ∈ NON_DEFERRABLE（finding 仅 high/critical）  
      2. hard density finding code = **`prose_pronoun_density`** ∈ NON_DEFERRABLE，**只在 ≥HARD 时发 finding**  
      3. soft band：要么不发 finding，要么发 medium 且 **code 不叫** `prose_pronoun_density` — 用 `prose_pronoun_density_soft` **不入** non-deferrable  
      4. 计划推荐默认表 soft 0.35 保留可观测：实现 `prose_pronoun_density_soft` medium  

- **Task2 Step3 强制：** merge pronoun **早于/覆盖** `shouldSkipLlm` 与 empty-contract return；empty contract 时仍可只返回 pronoun violations。  
- **Task3：** risk&lt;35 但 `selectPronounHotspotParagraphs` 非空仍跑 hotspot path（已有）。  
- **Task4 Step3 强制：**  
  1. runner：无 rewrite 也返回 residual detect（或 finalization 对 finalContent 再 detect）  
  2. `chapterStatePairAfterLiteraryQualityGate` 扩展或新增 `chapterStatePairAfterQualityGates({ literaryPass, styleClear })`，repair/auto-review 全切新 API  
  3. `projectStyleClear`：blocking pronoun → false；order≤3 且 residual≥35 → false  

### 风险再评

| ID | 计划 | Review 加注 |
|---|---|---|
| R1 | 对话误伤 | T1 测已覆盖；实现必须 strip 对话后再计句首 |
| R4 | rewrite 失败仍烂稿 | T1 L0 独立硬拦 — **正确，优先交付** |
| 新 R7 | soft density 误入 non-deferrable → 中等债变硬门 | 见上方 code 拆分锁定 |
| 新 R8 | 只改 helper 不改写路径 → 验收 3 假绿 | T4 Must-fix #4 |

### 执行顺序（不变）

T1 → T2 → T3 → T4 → T5；每阶段测绿 + production-code-quality-review + commit。  
**不**恢复生产写书；**不**新开/重写 ch1。
