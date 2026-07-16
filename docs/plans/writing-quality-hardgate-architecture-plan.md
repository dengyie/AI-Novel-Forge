# 写文质量硬门：开发文档（L0 真拦 · 不可 defer 降级）

> **文档类型**：可执行开发计划（完备设计）  
> **状态**：**实现完成** · 2026-07-17 · 分支 `feat/writing-quality-hardgate` · 阶段 1–3 已交付  
> **仓库**：`AI-Novel-Writing-Assistant`  
> **触发证据**：pxed《源世界》卷二自动化抽查（task `cmrnm5kaq0kev0k9ki820qlpr` · chapter_range 52–80）——高分/litPass 与政策硬伤（废弃术语 / 系统 HUD）共存；`defer_and_continue` 将本应 L0 的问题记成 non_blocking 债；短章 litPass 无观测标签  
> **生产书**（仅作验收夹具与 Manual 词表目标，**不**写死进引擎）：novelId `cmriiu3u300006m9k2jo45w93`  
> **正交计划（不替代）**：  
> - `director-self-cycle-pipeline-plan.md` — 能跑完（BatchRoll / strip / recovery）  
> - `writing-quality-architecture-plan.md` — 修文 adopt/discard · isPass 对齐 · L0 **接线**（词表默认空仍不拦）  
> - `setting-alignment-quality-architecture-plan.md` — 设定对（`settingQualityMode`）；**不管**政策禁词/HUD  
> - wiki `chapter-production-chain.md` — 链路形态  
> **更新日期**：2026-07-17  
> **产品硬原则（不可违背）**：  
> - 不做机械字数 / 松紧硬闸（**字数不进 isPass**）  
> - **禁止**策略化 `skip_quality_repair` / 盲批 / 无根因 `forceResume`  
> - **无** `writingQualityMode` 三级开关；默认抬升硬门，不为灰度叠 mode  
> - blocking 真源仍只认 `riskFlags.qualityLoop` + `classifyChapterQualityLoopRisk*`（**禁止**第二套 processed 规则）  
> - 监管代理 **不**代写/代审/PUT 正文当 rewrite worker  
> - 本计划实现与发版 **不**自动 resume 生产写书  

---

## 0. 一句话目标

> **让政策硬伤（书级 SoT 禁词、系统 HUD 等确定性 L0）在有词表/有规则时必出码、必抬 blocking，且不得被高 overall / litPass / `defer_and_continue` 降成可继续的债；词表与空表可观测；短章只加标签不进 isPass。**

吞吐归自循环；设定归设定计划；前序 writing-quality 已解决「修不更差 + 分数对齐 + SoT **能**扫」——**本计划解决「真拦 + 不可降级 + 缺规则补全」**。

---

## 1. Context：P0 已交付 vs 抽查仍漏

### 1.1 已交付（writing-quality P0，保留）

| 能力 | 锚点 | 状态 |
|---|---|---|
| 修文 evaluate → adopt \| discard | `ChapterRepairStreamRuntime` | 已交付 |
| isPass = c≥80 ∧ r≥75 ∧ e≥75；loop 文学信号对齐 | `literaryQualityPass` / `chapterQualityLoop` | 已交付 |
| L0 扫描接线：`detectProseQuality(..., { bannedTerms, mustAvoidTerms })` | finalization + repair | 已交付 |
| 书级词表读取：`sotBannedTerms` ← slice / overrides JSON | `shared/types/sotBannedTerms.ts` | 已交付 |
| `!literaryPass` 不得质量过审/completed（A6） | generationState 合并路径 | 已交付 |
| qualityLoop 单 blocking 真源 | `classifyChapterQualityLoopRisk*` | 已交付 |

### 1.2 抽查仍漏（本计划范围）

| 现象 | 根因（代码级） | 为何前序 P0 不够 |
|---|---|---|
| 「称重」等政策词进正文仍高分过 | `extractSotBannedTermsFromNovel` 在词表 **空** 时不产生 `sot_banned_term`；生产书大概率未写入 `sotBannedTerms` | 接线在，**数据空 = 零规则** |
| 多章 `【…】` 系统 HUD | `ProseQualityIssueCode` **无** HUD/系统面板码；`normalizeTextForTermLeakScan` **剥掉【】** 仅服务词匹配 | 检测器从未覆盖结构 HUD |
| 高 overall / litPass + 硬伤 | triad 分数与 L0 **正交**；无 L0 finding 时高分合法 | 设计正确；缺 finding 才是 bug |
| repair 耗尽后 `terminalAction=defer_and_continue` → non_blocking 债 | `classifyChapterQualityLoopRisk`：defer 默认 non_blocking；**仅** setting enforce hard / `manual_gate` / replan 等抬 blocking；**sot/prose high 无对称保护** | A6 挡 completed，**不**挡导演 processed 续跑 |
| `buildProseQualitySignal`：worst ≥ high → 仅 **`risk`** | 无 `invalid` 路径；`resolveAction` 对 risk → `patch_repair`，耗尽后仍可 defer | 文案写「不得因高 overall 放行」，分类未钉死 |
| 短章 litPass | 字数故意不进 isPass；`length_under_*` 只在 auto-exec **不可 skippable** | 符合产品原则；**缺 observabilityTags / 债板可见** |

### 1.3 非根因（勿误修）

| 误判 | 说明 |
|---|---|
| 自循环 BatchRoll 坏了 | 52→69 续窗正常；正交于质量 |
| isPass 阈值太松 | 阈值是文学三维；不是政策硬伤闸 |
| 应把字数塞进 isPass | 产品否决机械节奏 |
| 应上 `writingQualityMode` | 前序 v2 已否决 |
| 监管人工 scrub / PUT 每章 | 掩盖门禁缺口；违反 monitor-only |
| setting enforce 能挡「称重」 | 设定对齐 ≠ 政策禁词/HUD |

### 1.4 与三正交计划边界

| 计划 | 解决 | 不解决 |
|---|---|---|
| director-self-cycle | 窗尽死停、合同 strip、recovery 回卷 | 硬伤码、词表、defer 降级 |
| writing-quality P0 | 修文不退化、isPass 对齐、SoT **接线** | 空表运营、HUD 码、L0 不可 defer |
| setting-alignment | Canonical/功能表、mode 下对齐门 | 废弃术语、系统括号 HUD |
| **本计划** | L0 数据完备、HUD 规则、不可 defer 降级、l0 可观测、短章标签 | 自循环算法、设定本体、字数 isPass |

**合并序（强制）**：

1. 不改 `isDirectorAutoExecutionChapterProcessed` 旁路；继续只读 `classifyChapterQualityLoopRiskFlags(qualityLoop)`。  
2. 改 `classify` / `buildProseQualitySignal` / detector 时 **单点** 合入，禁止平行 processed 规则。  
3. 与 setting 的 defer 保护 **对称扩展**，不复制第二套 setting 状态机。

---

## 2. 设计原则（薄）

1. **L0 > L1 > L2** — 确定性硬伤先于义务缺口先于文学 isPass；高分不得盖 L0。  
2. **有码才拦；空表显式** — book-agnostic 引擎不硬编码书名禁词；**空 `sotBannedTerms` 必须可观测**（warn / readiness），避免「以为有 L0」。  
3. **政策 L0 不可 defer 降级** — 对齐 setting hard invalid：`terminalAction=defer_and_continue` **不得**把 sot/critical prose/HUD 变成 non_blocking。  
4. **单 blocking 真源** — 只扩展 classify + signal 语义；不新建 quality 状态机。  
5. **isPass 公式不变** — 仍 80/75/75；本计划不改 triad 数字。  
6. **不机械控节奏** — 短章 → tag / 债可见；**不**进 isPass。  
7. **结构 HUD ≠ 词表** — `【系统面板】` 用原文结构规则；勿依赖剥括号后的 term scan。  
8. **默认打开** — 无 off 主开关；错误配置（空表）只影响「无 SoT 词规则」，不影响 prose_*/HUD。  
9. **不写书** — 实现/发版不 resume autopilot；词表注入属 Manual 或独立运维步骤。

---

## 3. 目标行为（To-Be）

```text
draft / repair_candidate / manual_put
        │
        ▼
 L0a: ProseQuality 既有 prose_*（critical/high 语义保留）
 L0b: SoT bannedTerms + mustAvoid → sot_*（high）     ── 词表来自 slice；空=无 sot 码
 L0c: prose_system_hud（结构【】/伪系统面板，扫原文）  ── 新增；与 term 剥壳正交
        │
        ▼  findings → audit.openIssues
 buildProseQualitySignal
   · sot_* 或 critical prose_* 或 prose_system_hud(high+) → signal status **invalid**
   · 其它 medium/low prose → valid 或 risk（保持现语义可微调）
        │
 resolveAction / assessment
   · prose invalid → patch_repair（或 manual_gate 若 plateau/budget hard_stop）
   · **不得**因 overall 高而 continue 清 L0
        │
 耗尽 / pipeline terminalAction=defer_and_continue
        │
 classifyChapterQualityLoopRisk
   · 若 hasNonDeferrableProseOrSotDebt(qualityLoop) → **blocking**
   · 否则保持既有 defer → non_blocking（L2 可读债）
        │
 导演 processed / 债板 / 列表
   · blocking → 不推进下一章自动过门
   · 投影：literaryPass（旧）+ **l0Clear**（新，可选 P1）
   · 短章：observabilityTags 含 length_under_*（不挡 isPass）
```

### 3.1 不可 defer 降级集合（冻结默认）

下列任一为真时，`defer_and_continue` **仍** classify 为 `blocking`：

| 条件 | 说明 |
|---|---|
| `prose_quality` signal `status === "invalid"` | 本计划抬升后的主路径 |
| openIssues / signal.issueCodes 含 `sot_banned_term` / `sot_must_avoid_leak` | 防御：signal 未抬 invalid 时仍拦 |
| issueCodes 含 `prose_system_hud` 且 severity high/critical | HUD |
| issueCodes 含既有 critical 级 prose：`prose_ai_self_reference` / `prose_placeholder_leak` / `prose_verbatim_repeat` / `prose_truncation` | 与 detector 现 severity 对齐 |
| 既有：`manual_gate` / replan / setting hard invalid / enforce setting debt | 不改动 |

**可继续 defer 的（保持）**：

- 仅 L2 `!isPass` / literary_score risk 且无上述 L0  
- 仅 timeline_extraction_deferred  
- 仅 setting **advisory**  
- 仅 medium/low 自然度提示（`prose_dash_or_ellipsis` 等）且未进 invalid 集合

### 3.2 空词表策略（冻结默认）

| 场景 | 行为 |
|---|---|
| `sotBannedTerms` 缺失或 `[]` | **不**产生 sot 码（book-agnostic）；**不**假装拦了政策词 |
| 运维/验收 | readiness 或日志：`sotBannedTermsCount=0`；生产书 Manual 注入 |
| 引擎 | **禁止**把《源世界》词表写死进 `ProseQualityDetector` |

词表示例（overrides JSON，词条用现行 SoT，**勿**在文档示例里复述已废弃监管黑话以外的生产敏感长列表；实现测用 fixture）：

```json
{
  "sotBannedTerms": ["称重"]
}
```

> 运营扩展词表时在 slice/overrides 追加；代码只认数组/分隔字符串约定（见 `sotBannedTerms.ts`）。

### 3.3 HUD 规则草图（实现可收紧，语义冻结）

**码**：`prose_system_hud`  
**severity 默认**：`high`（成块/多命中可 `critical`，实现定）  
**扫原文**（不要用 `normalizeTextForTermLeakScan` 结果当唯一输入）：

- 成对全角括号行：`【` … `】` 且内容匹配系统面板启发式（如含「系统」「状态」「任务」「冷却」「等级」「HP」「MP」「面板」等可配置子串 **或** 多字段键值块）  
- 可选：行首 `[系统]` / `「系统提示」` 工程风（与叙事引号区分，宁可漏不可误杀大面积对话）

**反误杀**：

- 单个【书名号式】短专名、方志地名：需启发式（长度/内部标点/关键词）  
- 对话中的偶发括号：低密度可 soft；**连续 ≥2 块或单块多行键值** 抬 high

精确正则在实现阶段用 fixture 锁；**验收夹具**必须含：真 HUD 拦、普通【别称】不拦。

### 3.4 短章（非 isPass）

| 项 | 行为 |
|---|---|
| isPass | **不变** |
| auto-exec skippable | 已有 `length_under_*` 不可 skip（`novelDirectorAutoExecutionFailure`）— 保留 |
| 本计划 | 在 qualityLoop `observabilityTags`（或既有 tags 字段）写入 `length_under_soft` / `length_under_hard`（阈值建议：&lt; target×0.6 hard 标签；0.6–0.8 soft；实现与 lengthControl 同源） |
| 导演 | **不**因仅有 length tag 而 blocking（除非另有 L0） |

### 3.5 列表 / 债板投影（P1）

| 字段 | 含义 |
|---|---|
| `literaryPass` | 已有；文学三维 |
| `l0Clear`（新增可选） | 无 non-deferrable prose/sot/HUD open；**≠** literaryPass |
| 债板排序 | sot_* / prose_system_hud / critical prose 优先于分数债 |

无前端大改要求：后端 DTO / riskFlags 可先出字段，UI 可随后。

---

## 4. 插入点速查

| 动作 | 路径 |
|---|---|
| L0 检测 + 新码 | `server/src/services/novel/runtime/proseQuality/ProseQualityDetector.ts` |
| 词表提取 | `shared/types/sotBannedTerms.ts`（一般不改约定；可加 count helper） |
| 定稿/修文扫 L0 | `ChapterContentFinalizationService.ts` / `ChapterRepairStreamRuntime.ts` |
| prose signal / resolveAction | `shared/types/chapterQualityLoop.ts`（`buildProseQualitySignal`、`resolveAction`、**新增** `hasNonDeferrableProseOrSotDebt`） |
| defer 分类 | `classifyChapterQualityLoopRisk` 同文件 |
| 写 loop | `ChapterQualityLoopService.ts` |
| runtime package blocking 聚合 | `chapterRuntimePackageBuilders.ts`（确认 high sot/HUD 进 openIssues / hasBlockingIssues） |
| 短章 tag | lengthControl → assessment tags（pipeline / finalization 邻域） |
| 列表投影 | `literaryQualityPass.ts` 或 chapter DTO 装配处 |
| 不可 skip 短章 | `novelDirectorAutoExecutionFailure.ts`（只回归，原则上不改语义） |
| 前序质量计划 | `docs/plans/writing-quality-architecture-plan.md` |
| 链路 wiki | `docs/wiki/workflows/chapter-production-chain.md`（阶段末短链） |

---

## 5. 分阶段（上限 3，对应 P0/P1）

### 阶段 1 — 词表可观测 + L0 不可 defer 降级 + prose signal invalid（P0）

**目标**：有 sot/critical prose 时，defer 不能放行；signal 与 classify 语义一致。

**改动**：

1. `buildProseQualitySignal`：  
   - 任一 `sot_*` → `status: "invalid"`  
   - 任一 critical `prose_*`（见 §3.1）→ `invalid`  
   - 其它 high 非 critical：默认 `risk`（阶段 2 HUD 再并）或一并 invalid（实现选更严：sot+critical 必须 invalid）  
2. `hasNonDeferrableProseOrSotDebt(qualityLoop)` 纯函数 + 单测。  
3. `classifyChapterQualityLoopRisk`：在 `terminalAction === "defer_and_continue"` 分支，若 non-deferrable → `blocking`（对称 setting）。  
4. 可选 helper：`countSotBannedTerms(novel)` / readiness 日志字段 `sotBannedTermsCount`（finalization warn 一次/书或/章限流）。  
5. 测试：  
   - fixture 正文含 banned term + 高分 triad → assessment 非 continue 清债；defer 后仍 blocking  
   - 无词表 + 同正文 → 无 sot 码（回归空表）  
   - 仅 literary 不达标 + defer → 仍 non_blocking（L2 债不变）

**验证**：

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server test -- chapterQualityLoop
pnpm --filter @ai-novel/server test -- proseQuality
# 若测文件名不同，以实际 test 名为准；至少覆盖 classify + signal
```

**Commit**：`feat(phase-1): non-deferrable L0 prose/sot in qualityLoop classify`

---

### 阶段 2 — `prose_system_hud` 确定性检测（P0）

**目标**：系统 HUD / 伪状态面板不过 L0。

**改动**：

1. 扩展 `ProseQualityIssueCode` + `detectProseQuality` 扫描（原文）。  
2. 并入 audit report；repair / finalization 共用 detect（已共用入口则只扩 detector）。  
3. `buildProseQualitySignal` / non-deferrable 集合纳入 `prose_system_hud`。  
4. Fixture：真 HUD 拦；普通叙述+偶发【】不拦；高分+HUD → blocking。  
5. adopt 路径：candidate 引入 HUD → discard（复用既有 L0 恶化逻辑，补测）。

**验证**：

```bash
pnpm --filter @ai-novel/server test -- proseQuality
pnpm --filter @ai-novel/server test -- chapterQualityLoop
pnpm --filter @ai-novel/server test -- ChapterRepair
```

**Commit**：`feat(phase-2): detect prose_system_hud as non-deferrable L0`

---

### 阶段 3 — 短章标签 + l0Clear 投影 + 验收套件（P1）

**目标**：运营可见「短但过审」「L0 未清」；整包验收绿。

**改动**：

1. length 比 → `observabilityTags`（或 qualityLoop 既有 tags 槽）。  
2. DTO/列表：`l0Clear` 布尔（从 openIssues / qualityLoop 投影）。  
3. **新建** `server/tests/writingQualityHardgateAcceptance.test.js`（或扩展现有 writing-quality 验收）：  
   - A-H1… 见 §6  
4. wiki `chapter-production-chain.md` 增加 L0 / defer 硬门短链（3–10 行，不写成长文）。  
5. 更新本文件状态 → 实现完成（实现后）。

**验证**：

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server test -- writingQualityHardgate
pnpm --filter @ai-novel/server test -- chapterQualityLoop
pnpm --filter @ai-novel/server typecheck
```

**Commit**：`test(phase-3): hardgate acceptance and l0Clear projection`

---

## 6. 验收标准

| ID | 标准 |
|---|---|
| A-H1 | 配置非空 `sotBannedTerms` 后，正文命中禁词 → 出现 `sot_banned_term`，`prose_quality` 为 **invalid** 或等价 hard |
| A-H2 | 同上 + 人为高 c/r/e → **不得** `recommendedAction=continue` 且无 L0 债；导演 classify **blocking** |
| A-H3 | `terminalAction=defer_and_continue` + sot/HUD/critical prose → classify **blocking**（不可 non_blocking） |
| A-H4 | 空词表 + 同禁词正文 → **无** sot 码（book-agnostic 回归） |
| A-H5 | 典型 `【系统…】` HUD fixture → `prose_system_hud`；classify blocking |
| A-H6 | 叙事中偶发无害【】不误杀（fixture 锁定） |
| A-H7 | 仅 `!literaryPass`、无 L0 → defer 仍可为 non_blocking；且 **不得** completed（A6 回归） |
| A-H8 | isPass 公式与阈值单测与现网一致（80/75/75） |
| A-H9 | 短章 &lt; target×0.6 → 有 length 标签；**不**单独导致 `literaryPass=false` |
| A-H10 | 不存在策略化 `skip_quality_repair`；无 `writingQualityMode` 主路径 |
| A-H11 | adopt：candidate 新增 L0 invalid → discard，baseline hash 不变 |

---

## 7. Milestone 契约（审阅通过后冻结）

```text
Milestone：写文质量硬门 P0/P1（L0 真拦 · 不可 defer 降级 · HUD）
目标：政策 L0 与 HUD 确定性拦；defer 不降级；空表可观测；短章可观测；isPass 不变
P0/P1 范围：阶段 1–3
不做的 P2/P3：
  - 字数/松紧进 isPass
  - writingQualityMode / 灰度矩阵
  - 第二套 processed / blocking 真源
  - 设定对齐 enforce 本体、功能表导入
  - 导演 BatchRoll / 自循环算法
  - 前端债板大改、Job 长任务投影大改
  - 把《源世界》词表硬编码进 detector
  - 自动 resume 生产写书 / 代理代写 scrub
Manual-required：
  - 生产书 sotBannedTerms 注入（pxed overrides JSON）
  - 发版部署 pxed
  - 发版后监管按 vault 恢复观察（非本 milestone 写书）
阶段上限：3
验收：§6
停止条件：验收绿 + 文档状态更新 + 阶段 commit；不自动开下一 milestone；不自动写书
```

---

## 8. 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | HUD 误杀叙事括号 | 启发式 + 反误杀 fixture；先 high 可修再 critical |
| R2 | 不可 defer 后自动吞吐下降 | 正确：硬伤应停；靠修文/词表质量而非 skip |
| R3 | 空表书「仍不拦称重」 | 文档+readiness；Manual 注入；禁止假拦截 |
| R4 | 与 setting defer 逻辑分叉 | 同一 classify 函数扩展；共享命名 hasNonDeferrable* |
| R5 | repair adopt 与 invalid 竞态 | 复用 writing-quality adopt 测试；L0 恶化必 discard |
| R6 | 在途生产任务行为变化 | 发版说明；旧债章可能从 non_blocking → blocking（预期） |
| R7 | 监管误解 litPass | l0Clear 投影；文档写清两字段 |

---

## 9. 实现默认（代码内决策，减少开会）

| # | 决策 |
|---|---|
| D1 | non-deferrable 以 **issueCodes 集合 + prose_quality invalid** 双通道判定（防御 signal 漏写） |
| D2 | `prose_system_hud` 默认 severity `high`；多块抬 `critical` 可实现时做 |
| D3 | 短章 hard 标签阈值 **0.6 × targetWordCount**（与 auto-exec 不可 skip 口径一致） |
| D4 | `sotBannedTermsCount===0` 仅 warn/readiness，**不** fail 建书（旧书兼容） |
| D5 | 不在本 milestone 做 DB migration；词表仍 JSON 字段 |

---

## 10. Manual-required（生产书，非代码阶段）

| 步骤 | 说明 |
|---|---|
| M1 | 在 pxed 为 novel `cmriiu3u300006m9k2jo45w93` 写入 `storyWorldSliceOverridesJson.sotBannedTerms`（含「称重」等现行政策词） |
| M2 | 发版含本 milestone 的 server |
| M3 | **不** skip_quality；对已 defer 的历史章：blocking 抬升后由 Nova repair / 监管控制面 retry——**禁止**代理 PUT 洗正文 |
| M4 | 监管口径仍：poll + 重大门禁决策；见 vault 生产监管笔记 |

---

## 11. Backlog（明确不做）

- 债板 discard 率大盘、UnifiedVerdict 类型仪式  
- 连续 N 章过短 → 自动 manual_gate（产品未要）  
- 多语言 HUD、半角 `[]` 全量系统协议  
- 建书向导强制非空词表 UI  
- 历史 1–40 / 41–51 批量重生  

---

## 12. 审阅清单

- [ ] 同意 **不可 defer 降级** 集合（§3.1）？  
- [ ] 同意 **空表不假拦** + Manual 注入生产词表？  
- [ ] 同意 HUD 用 **结构规则** 而非只靠词表？  
- [ ] 同意短章 **只标签、不进 isPass**？  
- [ ] 同意三阶段拆分与 §7 契约？  
- [ ] 确认：通过前不自动恢复生产写书？  

---

## 13. 附录：现网关键锚点（2026-07-17）

**词表空 = 无 sot 码**

```ts
// shared/types/sotBannedTerms.ts
// 不新增 DB 列；空表 = 不附加 L0 规则。
```

**prose signal 今日仅 risk**

```ts
// shared/types/chapterQualityLoop.ts — buildProseQualitySignal
const status = worstSeverity >= SEVERITY_RANK.high ? "risk" : "valid";
// 本计划：sot_* / critical / HUD → invalid
```

**defer 今日默认 non_blocking**

```ts
// classifyChapterQualityLoopRisk
if (qualityLoop.terminalAction === "defer_and_continue") {
  if (hasEnforceSettingAlignmentDebt(qualityLoop)) return "blocking";
  return "non_blocking_quality_debt"; // ← 本计划在此增加 prose/sot 对称
}
```

**L0 码集合（扩前）**

```ts
// ProseQualityDetector.ts
type ProseQualityIssueCode =
  | "prose_negative_flip" | "prose_dash_or_ellipsis" | "prose_period_stutter"
  | "prose_long_paragraph" | "prose_verbatim_repeat" | "prose_truncation"
  | "prose_ai_self_reference" | "prose_placeholder_leak" | "prose_engineering_term_leak"
  | "sot_banned_term" | "sot_must_avoid_leak";
// 本计划新增：prose_system_hud
```

**抽查结论摘要（证据向）**

- 自循环运行中：approved 推进 + drafted 在修 — 吞吐 OK  
- 政策词 / HUD / 短章与高分共存 — 硬门缺口  
- 决策口径：架构修门禁，不靠监管代写  

---

## 14. 文档关系

| 文档 | 关系 |
|---|---|
| `writing-quality-architecture-plan.md` | 前序已交付；本文是其 **硬门 follow-on**，不重开 adopt/isPass 数字 |
| `setting-alignment-quality-architecture-plan.md` | 正交；defer 保护模式可对标，域不同 |
| `director-self-cycle-pipeline-plan.md` | 正交；本计划不改 BatchRoll |
| 本文 | 权威执行计划；实现后更新文首 **状态** |

---

**文档结束 · 写文质量硬门 · 完备待审 · 2026-07-17**
