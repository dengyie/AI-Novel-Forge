# 写文质量架构：开发文档（质量优先 · 审阅稿 v2）

> **文档类型**：可执行开发计划  
> **状态**：**文档闭环完成 · 可交付** · P0 三阶段 + 质量加固（baseline 同源 / A6 旁路 / SoT 词表 / L1 adopt）· 2026-07-16  
> **仓库**：`AI-Novel-Writing-Assistant`  
> **范围**：写文质量（book-agnostic）——修文不退化、硬伤真拦、isPass 与过审一致  
> **正交计划（不替代）**：  
> - `director-self-cycle-pipeline-plan.md` — 能跑完  
> - `setting-alignment-quality-architecture-plan.md` — 设定对  
> - `chapter-output-pipeline-optimization-plan.md` + wiki `chapter-production-chain.md` — 链路形态  
> **更新日期**：2026-07-16  
> **产品硬原则**：  
> - 不做机械字数 / 松紧硬闸  
> - **禁止**策略化 `skip_quality_repair` / 盲批 / 无根因 `forceResume`  
> - **不**为灰度而灰度；改动能抬正文质量的默认打开  
> - blocking 真源仍只认 `riskFlags.qualityLoop`（禁止第二套 processed 规则）  
> - 本计划实现 **不**自动恢复生产写书

---

## 0. 一句话目标

> **修文必须评估后才落库；硬伤/禁词确定性必拦；isPass 与 qualityLoop / 过审同一套阈值——默认生效，不为「安全」叠 mode 仪式。**

吞吐归自循环；设定归设定计划；**本计划只抬正文质量与修文收敛**。

---

## 1. 用户否决与重定向（v1 → v2）

| v1（否决） | v2（采用） |
|---|---|
| `writingQualityMode = off\|advisory\|enforce` 默认 off | **无三级 mode 主架构**；质量抬升默认生效 |
| 先统一 Verdict 类型仪式、再可选 adopt | **先改修文写路径**：candidate → evaluate → adopt\|discard |
| Q1–Q5 全冻结再动 | **只留 2 个实现默认**（plateau 映射、SoT 存哪）；其余代码内决策 |
| Phase1 零行为变化的契约层 | **P0 必须改变坏路径行为**（修更差不再静默落库） |
| literaryGate 四级开关 | **固定**：L0/L1 hard 挡推进；L2 `!isPass` 挡「质量过审/completed」，**不**默认挡导演 processed（可读可 defer 记债） |

**仍保留（与「不复杂化」兼容）**：

- 唯一执行链  
- qualityLoop 单 blocking 真源  
- 禁止 skip_quality  
- 不机械控节奏  
- L0 > L1 > L2 优先级（实现序，不是 UI mode）

---

## 2. Context：质量不可运营的根因（已核实）

| 现象 | 根因锚点 | 本计划动作 |
|---|---|---|
| **修了更差仍落库** | `ChapterRepairStreamRuntime.finalizeRepairResult`：`prisma.chapter.update(content)` **先于** recheck；`isPass` 只决定是否 `chapterStatePairAfterPipelineApproval` 与 SSE 文案，**不 discard** | P0-1：evaluate → adopt\|discard |
| **分与过审脱节** | `isPass` = c≥80 ∧ r≥75 ∧ e≥75（`novelCoreShared`）；列表 `qualityScore←overall`；qualityLoop **retention** 用 e/r 65/75、overall 68/78——**与 isPass 漂移** | P0-2：loop 文学信号对齐 isPass 阈值 |
| **硬伤/禁词复发** | `ProseQualityDetector` 有 prose_*；**书级 SoT / mustAvoid 泄漏**未进确定性 L0 | P0-3：L0 SoT + mustAvoid 扫描 |
| **双轨债** | processed 只认 qualityLoop；分数 isPass 未成为 loop signal | P0-2：`literary_score` signal 进 assessment |
| **长任务不透明** | SSE 当真相；本计划 **P1 再收** Job/poll（不阻塞 P0 正文质量） | P1，可砍 |

---

## 3. 设计原则（薄）

1. **质量优先于灰度** — 能减少「修更差 / 硬伤过审」的改动默认上；不为理论回滚叠 off 开关。  
2. **修文是采纳不是覆盖** — 任何自动改正文：`baseline → candidate → evaluate → adopt | discard`。  
3. **一层优先级** — `L0 机械/SoT > L1 义务硬缺口 > L2 isPass`；高分不得盖 L0。  
4. **单 blocking 真源** — 导演/债板只读 `classifyChapterQualityLoopRiskFlags(qualityLoop)`。  
5. **isPass 公式不变** — 仍 `coherence≥80 && repetition≥75 && engagement≥75`；改的是**投影与门禁用法**，不改监管契约数字。  
6. **不机械控节奏** — pacing/字数不进 isPass。  
7. **不第二引擎** — 不新建并行 quality 状态机；在现有 repair / qualityLoop / prose 上改。  
8. **不写书** — 实现与发版不 resume 生产 autopilot。

---

## 4. 目标行为（To-Be，无 mode 矩阵）

```text
draft / repair_candidate / manual_put
        │
        ▼
 L0: ProseQuality + SoT ban + mustAvoid leak   ── block codes → 必须修或 manual
        │
 L1: acceptance 硬义务 / systemRisk-only       ── system 风险禁止靠改文消
        │
 L2: isPass(c,r,e)                             ── !pass → 不得质量过审/completed；可 defer 记债
        │
        ▼
 buildChapterQualityLoopAssessment（含 literary_score，阈值=isPass）
        │
        ▼
 riskFlags.qualityLoop  ← 唯一 blocking 真源
 QualityReport + 列代理  ← 可观测；列表另出 literaryPass 防误解

仅 repair 路径额外：
 baseline 评估 ──► 生成 candidate（内存/临时）──► 再评估
      │                    │
      │         改进且无 L0/L1 恶化？
      │              │yes          │no
      │              ▼             ▼
      │           adopt         discard（正文保持 baseline）
      │              │
      └──── attempt / plateau（连续无改进 → 停自动修，记债）
```

**没有** `writingQualityMode`。可选：novel 级 `sotBanList` 内容与阈值覆盖（数据，不是 off 开关）。

---

## 5. P0 改动（直接抬质量）

### 5.1 修文 adopt / discard（最高优先）

**文件**：`server/.../runtime/repair/ChapterRepairStreamRuntime.ts`（`finalizeRepairResult` ~L169–238）  
**现网问题**：先 `update content`，再 review；失败也「修复稿已保存」。

**目标流程**：

1. 读 baseline 正文 + 已有/即时评估（score、prose、acceptance 摘要）。  
2. 生成 candidate 字符串，**先不写 chapter.content**。  
3. 对 candidate：L0 扫描 + review/score（复用 `reviewChapterAfterRepair` 的评估能力，content 入参）。  
4. **Adopt** 当且仅当：  
   - candidate 非空；且  
   - 无**新增** L0 high/critical（相对 baseline）；且  
   - L1 blocking 义务不恶化；且  
   - `candidate.overall >= baseline.overall`（anti-regression，delta 默认 0）；且  
   - 若 baseline `!isPass`：至少一维 isPass 门槛维度提升，**或** 变为 `isPass`；若 baseline 已 isPass：不得引入 `!isPass` 且 overall 不降。  
5. Adopt → 写 content + revision bump + artifact sync +（若 isPass）approval state。  
6. Discard → **不改** content；写 repairHistory 决策行；SSE 明确「未采纳」。  
7. 连续 discard / 无改进 ≥ 2 → plateau：停止自动再修，qualityLoop → `manual_gate` 或 non_blocking debt（见 §8 默认）。

**兼容**：人工 PUT 正文不走 adopt 机（人责）；仅自动 repair stream / quality_repair stage。

**测**：

- overall 下降 → discard，DB content hash 不变  
- 新增 prose hard → discard  
- isPass 提升且无 L0 恶化 → adopt  
- 空 candidate → 失败，不写库  

### 5.2 isPass 与 qualityLoop 对齐

**文件**：

- `novelCoreShared.isPass` / `QUALITY_THRESHOLD` → 导出到 `shared`（`isLiteraryQualityPass` + 默认阈值），server re-export 兼容  
- `shared/types/chapterQualityLoop.ts`：`buildRetentionSignal` 等与「文学门」相关的 score 驱动，**对齐 isPass 三阈值**（去掉 65/68/78 与过审两套数）  
- additive signal：`literary_score`（status：isPass→valid，否则 risk/invalid 按差度）  
- 列表 DTO：显式 `literaryPass: boolean`（由同一函数算）；注释写清 `qualityScore≠isPass`

**不改**：isPass 三个数字本身（80/75/75）。

### 5.3 L0 SoT / mustAvoid

**文件**：`ProseQualityDetector` 旁路或扩展：

| code | 含义 | severity |
|---|---|---|
| 既有 `prose_*` | 保持 | 现网 |
| `sot_banned_term` | 书级/全局废弃术语 | high |
| `sot_must_avoid_leak` | 章 taskSheet/合同 mustAvoid 进正文 | high |

- 确定性扫描；空词表 = 零附加规则。  
- high/critical → 进入 qualityLoop / 修文优先级；**不得**因 overall 高而 continue。  
- 词表来源：novel.meta（或 world JSON）单一 key；章 mustAvoid 从现网合同字段读。

### 5.4 归并写入（轻量，非新状态机）

不强制上巨型 `UnifiedChapterQualityVerdict` 作为 P0 主类型。

P0 够用：

- `riskFlags.qualityLoop`（扩展 signals）  
- repairHistory 增加 `{ decision: adopt|discard|plateau, baselineHash, candidateHash, scoreDelta }`  
- 可选：`riskFlags.qualitySummary` 短结构（layer fails + literaryPass）——**若实现成本低再加**，不做仪式前置

P2 backlog：若 UI 真需要完整 verdict schema，再抽纯函数；**不**阻塞 P0。

---

## 6. P1（质量相关，可跟可砍）

| 项 | 说明 |
|---|---|
| 质量过审门 | `!literaryPass` 不得 `completed` / 质量过审 API；导演 processed 仍可 defer（非 blocking，除非 L0/L1 hard） |
| Job/poll | repair 长任务优先复用现有 genRun/pipeline job；SSE 降为投影 |
| 债板 | 窗口 literaryPass 率、discard 率、plateau 数（观测，非硬闸） |
| wiki 短链 | `chapter-production-chain` 增加 adopt 段 |

---

## 7. 非目标

- `off|advisory|enforce` 主架构与默认 off 灰度叙事  
- 单书清洗脚本、恢复 pxed 写书  
- 导演 BatchRoll / recovery（self-cycle）  
- 设定 function 表本体  
- 多 Agent 重写、机械字数硬闸  
- 第二套 processed 规则  
- 把 overall/pacing 改成 isPass  
- 策略化 skip_quality  

---

## 8. 实现默认（仅 2 个需审阅默许）

| # | 问题 | **冻结默认** |
|---|---|---|
| D1 | plateau 后 | L0/L1 仍 hard → `manual_gate`；仅 L2 未过且正文可读 → non_blocking debt + 停自动修 |
| D2 | SoT 词表 | `novel.meta`（或现网 world JSON）单一 key；默认空 |

其余（anti-regression delta=0、plateau 连续 2 次、max 自动修仍对齐 wiki patch+heavy 一次预算）代码内按上表实现，不再开 Q 矩阵。

---

## 9. 分阶段（压缩为 3 阶段，上限 5）

### 阶段 1 — 修文 adopt/discard（P0）

- 改 `ChapterRepairStreamRuntime.finalizeRepairResult`（及 quality_repair 入口若旁路写文）  
- repairHistory 决策  
- 单测：regress / L0 / adopt / 空稿  

```bash
pnpm --filter @ai-novel/server test -- ChapterRepair
# 及指向 finalize/adopt 的新测
```

**Commit**：`feat(phase-1): repair evaluate-before-adopt discard regression`

### 阶段 2 — isPass 契约 + qualityLoop 对齐 + L0 SoT（P0）

- shared 导出 isPass  
- retention/literary signal 阈值对齐  
- SoT + mustAvoid L0  
- list `literaryPass`  

```bash
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server test -- chapterQualityLoop
pnpm --filter @ai-novel/server test -- proseQuality
```

**Commit**：`feat(phase-2): align literary isPass into qualityLoop and L0 SoT`

### 阶段 3 — 过审门 + 验收（P1）

- 未 literaryPass 不得质量过审/completed（L0/L1 hard 已在 loop）  
- 验收测：L0 不被高分盖；discard 保正文；isPass 边界；禁止 skip 映射  
- wiki 短链  

**Commit**：`feat(phase-3): literary review gate and writing-quality acceptance`

**砍掉的 v1 Phase**：独立「mode=off 零行为 verdict 类型层」、enforce 灰度矩阵、Job 强制新表。

---

## 10. 验收标准

| ID | 标准 |
|---|---|
| A1 | repair candidate 降 overall 或新增 L0 hard → **discard**，正文 hash 不变 |
| A2 | adopt 后 content=hash(candidate)，repairHistory 有 decision |
| A3 | `isLiteraryQualityPass` 与现网 80/75/75 单测边界一致 |
| A4 | qualityLoop 文学相关 score 驱动与 isPass **同阈值**（无 65/68 双轨） |
| A5 | L0 blocking（含 mustAvoid/SoT 命中）时不得 `recommendedAction=continue` 清债 |
| A6 | `!literaryPass` 不得质量过审/completed |
| A7 | 不存在默认 true 的 `skip_quality_repair` 策略开关 |
| A8 | 无 `writingQualityMode` 三级作为主路径；行为默认即质量门 |

---

## 11. 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | adopt 严 → 修文更常 discard | 正确：差修不落库；plateau 后人介入，不 skip |
| R2 | SoT 误杀 | 默认空表；词表可配 |
| R3 | 与 setting loop 叠压 | 仍只写 qualityLoop；不平行 processed |
| R4 | 改写路径多入口 | 只改 coordinator repair stream + 搜一切直接 `content:` 写修复稿的旁路 |
| R5 | 现网「修完即可见」习惯变化 | SSE/API 明确 discard 原因；属质量提升预期 |

---

## 12. Milestone 契约（审阅通过后冻结）

```text
Milestone：写文质量 P0（修文不退化 + 阈值对齐 + L0 硬伤）
目标：自动修不再静默写差稿；isPass 与 loop/过审一致；SoT/mustAvoid 可拦
P0/P1：阶段 1–3
不做：mode 矩阵、UnifiedVerdict 仪式前置、导演自循环、设定本体、写书 resume、机械节奏硬闸
Manual-required：发版；生产 resume 写书
阶段上限：3（复杂可扩到 5，不默认扩）
验收：§10
停止：验收绿 + 文档状态更新；不自动开下一 milestone；不自动写书
```

---

## 13. 插入点速查

| 动作 | 路径 |
|---|---|
| 修文落库 | `server/src/services/novel/runtime/repair/ChapterRepairStreamRuntime.ts` |
| isPass | `server/.../novelCoreShared.ts` → `shared` |
| qualityLoop 阈值 | `shared/types/chapterQualityLoop.ts` `buildRetentionSignal` 等 |
| prose/L0 | `runtime/proseQuality/ProseQualityDetector.ts` + SoT 扩展 |
| 执行链文档 | `docs/wiki/workflows/chapter-production-chain.md` |
| 分数落库 | `quality/chapterQualityScorePersist.ts`（literaryPass 投影） |

---

## 14. 附录：现网关键片段

**isPass**

```ts
const QUALITY_THRESHOLD = { coherence: 80, repetition: 75, engagement: 75 };
export function isPass(score: QualityScore): boolean {
  return score.coherence >= QUALITY_THRESHOLD.coherence
    && score.repetition >= QUALITY_THRESHOLD.repetition
    && score.engagement >= QUALITY_THRESHOLD.engagement;
}
```

**修文先写后评（待改）** — `finalizeRepairResult`：先 `prisma.chapter.update({ content })`，再 `reviewChapterAfterRepair`；`isPass` 仅 approval。

**retention 漂移（待改）** — engagement/repetition 65/75、overall 68/78，与 isPass 不一致。

---

## 15. 审阅清单（精简）

- [ ] 同意 **默认打开** adopt / isPass 对齐 / L0 SoT，不做 off 主开关？  
- [ ] 同意 D1/D2？  
- [ ] 同意三阶段拆分（先修文路径，再阈值+L0，再过审门）？  
- [ ] 确认：通过前不恢复自动写书  

---

## 16. 文档闭环加固（2026-07-16）

相对 P0 三阶段后 code review 的 P1 缺口，本轮已落地：

| 缺口 | 落地 |
|---|---|
| baseline 信旧 QualityReport | `resolveBaselineReview`：优先 evaluateOnly 与 candidate 同协议 |
| A6 completed 旁路 | `mergeChapterPatchForGenerationStateBump` 无 `literaryPass:true` 不写 completed；pipeline 过审路径显式传 true |
| 书级 bannedTerms 空接线 | `sotBannedTerms` 从 `storyWorldSlice(Overrides)Json` 读取；finalization + repair 共用 |
| L1 义务恶化可 adopt | `baseline/candidateBlockingL1Codes` + `fingerprintReviewIssuesAsL1BlockingCodes` |
| mustAvoid「」包装漏扫 | `normalizeTextForTermLeakScan` 归一化扫描 |
| adopt 后 recheck/artifact 失败半写 | catch 后强制 `needs_repair`，正文保留 |

**仍属 backlog（不阻塞本闭环）**：Job/poll 长任务投影、债板 discard 率面板、UnifiedVerdict 类型仪式。

**词表写入示例**（novel.storyWorldSliceOverridesJson；词条用当前 SoT 废弃术语，勿写已废口径）：

```json
{ "sotBannedTerms": ["旧废弃术语示例"] }
```

---

**文档结束 · v2 质量优先 · 文档闭环完成 · 可交付**
