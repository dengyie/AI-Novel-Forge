# 设定对齐与生文质量大修：架构与开发文档

> **文档类型**：可执行开发计划（完备设计）  
> **状态**：已冻结开工 · Phase 1（policy + canonical guard）实现中  
> **分支**：`feat/setting-alignment-quality`（from `main@888a504`）  
> **仓库**：`/Users/mango/project/claude-project/AI-Novel-Writing-Assistant`  
> **生产背景**：《源世界》卷一 pxed 生产实测（novelId `cmriiu3u300006m9k2jo45w93`，task `cmrijv50c000c9w9kack9k7gx`）  
> **权威设定**：Obsidian `新书-异能纪元-暂定/{01,11,13,18,20,24,25,26,27}`（经 `00.MOC/AI-DOC-ROUTER.md`）  
> **正交计划**：`docs/plans/director-self-cycle-pipeline-plan.md`（BatchRoll / strip / recovery）— **不替代本计划**  
> **更新日期**：2026-07-14  
> **文档修订**：2026-07-14 — 吸收 production review 全部 P0/P1，正文与默认已一致，可冻结开工  
> **产品硬原则**（不可违背）：
> - 不做机械字数/松紧硬闸（节奏交给项目 AI）
> - 禁止策略化 `skip_quality_repair`
> - 卡住先查根因再重试，禁止无脑放行
> - **默认不破坏现网书**：`settingQualityMode` 默认 `off`；旧书零行为变化

---

## 0. 一句话目标

> **让「设定层」成为一等公民真源，让「节拍/文笔分」退居服务位；在 opt-in enforce 书上，生文链路在自动推进前必须过设定对齐门禁——且不得拖垮非 enforce 书与写章可用性。**

自循环（BatchRoll）解决「能跑完」；本计划解决「跑完是对的书」。

---

## 1. Context：三层真相与实测失真

### 1.1 三层真相（生产实测）

| 层 | 内容 | 权威度 | 生产实际 |
|---|---|---|---|
| **A** | Obsidian 设定：约 25 万 / ~20 功能章；澄湾·岚桥；陆深托付；F5 猫模糊伏笔；红·入署；周砚/唐晚晴在入署后 | 创作真源 | 未作为 runtime 硬约束注入 |
| **B** | createNovel framing：`defaultChapterLength≈3000`、80 章级 framing、`primaryStoryModeId=story_mode_growth_leveling` | 建书参数 | 驱动章长与 beat 模板，与 A 冲突 |
| **C** | Runtime 合同：40 薄拍 structuredOutline + world slice + taskSheet | 执行真源 | 静默发明 lore；beat 主导；无设定对齐门 |

### 1.2 质量结论（源世界卷一 1–40，约 15.9 万字）

| 维度 | 评分倾向 | 现象 |
|---|---|---|
| 主弧骨架 | 尚可 | 欺负→托付→报复→措施→小惩→副线→红入署 大体在 |
| 设定对齐 | **差** | 残渣流失/脱序者等 slice 发明；港/澄湾/周砚/唐晚晴/F5 在 outline 几乎消失 |
| 功能覆盖 | **差** | 无一等公民功能验收表；beat 薄拍替代 20 功能章 |
| 人物与现场 | 中下 | 沈晚弱；桥/港薄；taskSheet 钉认知不钉选择 |
| 节奏同质 | 中 | growth_leveling 拍型均质化 |
| 文笔/acceptance score | 中上 | 现有 gate 主要打散文质量，**不等于设定对齐** |
| **综合** | **≈6.2/10** | 能读完，但不是设定书 |

### 1.3 根因权重

| 权重 | 层 | 说明 |
|---|---|---|
| **~50%** | **架构** | world slice 自由文本可发明；outline 以 beat 为脊；无 setting-alignment gate；taskSheet 模板偏「认知钉死」 |
| **~25%** | **framing / 文档形态** | A 层 20 功能章未结构化导入；B 层 3k×80 + growth_leveling 覆盖 A |
| **~20%** | **过程** | 无 outline 冻结 diff；无中段 diff；监管停条件绑「卷写完」而非「设定卷完成」 |
| **~5%** | **模型** | 在坏合同下合理发挥；修合同后模型不是主瓶颈 |

**结论**：资料（A）可用；主因是 **B/C 未把 A 变成可门禁的一等结构**，且过程无人工冻结点。

### 1.4 与自循环计划的边界

| 计划 | 解决 | 不解决 |
|---|---|---|
| director-self-cycle | 批间死停、taskSheet 内部 code、recovery 回卷 | 设定对齐、功能表、slice 发明、监管停条件语义 |
| **本计划** | 设定真源、功能验收、对齐门禁、taskSheet 语义、过程 diff/停条件 | 批续窗算法本身 |

**合并序（强制）**：优先合入 self-cycle 的 strip / processed 稳定性；本计划改 `isDirectorAutoExecutionChapterProcessed` 时 **单点归并** qualityLoop（见 §5.0、§5.3）。可同 PR 一人改 processed，禁止双分支各改一套规则。

发版建议：self-cycle 与本计划可分 PR；**恢复《源世界》写书前**，本计划至少完成 Phase 1–3 且目标书 `settingQualityMode=enforce`。

---

## 2. 设计原则

1. **设定真源分层，禁止静默升格**  
   Canonical > Framing > Runtime 合同 > 正文。Runtime 只能引用与裁剪 Canonical。

2. **功能验收表 first-class，beat 服务功能**  
   卷的「必须发生」来自功能表；beat 只做节奏切片。  
   **仅 `enforce` 书**要求 chapter 挂 `functionIds[]` 且覆盖门禁生效。

3. **设定对齐门 ≠ 文笔 qualityScore**  
   对齐失败归并进 **qualityLoop 单一真源** 的 blocking 债；禁止 `overallScore≥阈值 ⇒ 设定通过`。

4. **taskSheet = 人物选择 + 现场压力，禁止钉死认知**。

5. **过程有冻结与 diff，停条件与设定卷解耦**  
   freeze **复用**现网 `structured_outline_ready`，不平行新状态机。

6. **默认不破坏现网**：`settingQualityMode` 默认 `off`；灰度用 advisory → enforce。

7. **可用性优先于严格抛错**：slice/build 永不拖垮写章；blocking 主要发生在正文 alignment（enforce 下）。

8. **不机械控字数节奏**；短章防空章属自循环计划，本计划不叠加字数硬闸。

---

## 3. 全局控制面（收口后的总开关）

### 3.1 `settingQualityMode`

```ts
// shared/types/settingQualityPolicy.ts（新建）
export const SETTING_QUALITY_MODES = ["off", "advisory", "enforce"] as const;
export type SettingQualityMode = typeof SETTING_QUALITY_MODES[number];

export interface SettingQualityPolicy {
  mode: SettingQualityMode;
  /** slice 构建/规范化时是否走 canonical strip；enforce 默认 true，其余 false */
  canonicalSliceLock: boolean;
  /** mid-run 仅 backlog 阶段使用；本 milestone 默认不启用 */
  midRunDiffMode?: "off" | "advisory" | "blocking";
  midRunDiffCheckpoints?: number[]; // 若启用，默认 [10, 20]
}
```

| Mode | 行为 |
|---|---|
| **`off`（默认）** | 全站现网行为；不写 function 强制、不跑 alignment blocking、不改 processed、不要求 freeze artifact |
| **`advisory`** | 跑规则/可选报告，写入 `riskFlags.settingAlignment` **详情** + qualityLoop **非阻塞** signal；**不**挡 sync / processed / auto_execute |
| **`enforce`** | 功能覆盖必过；alignment blocking 归并 qualityLoop；structured_outline 事实含覆盖+diff；processed 认债；C3 停条件语义生效 |

**解析优先级**（高→低）：

1. 本次 task / autoExecution plan 显式 `settingQualityPolicy`  
2. novel 级持久化策略（建议 `novel` 扩展字段或 meta JSON）  
3. 默认 `{ mode: "off", canonicalSliceLock: false }`

**自动升 `enforce` 的唯一路径（可选辅助，仍须可关）**：

- 用户导入 `FunctionAcceptanceTable` 且 `source` 为 `import|hybrid`，**并**在 UI/API 确认「启用设定门禁」→ 写 novel 策略为 enforce  
- **禁止**：仅因为 `source:generated` 自动 enforce（防对齐错书）

### 3.2 Slice `lockMode`（与 quality mode 正交）

```ts
export type StoryWorldSliceLockMode = "canonical" | "theme_invent";
```

| 条件 | lockMode |
|---|---|
| 读存量 slice、字段缺失 | **`theme_invent`（兼容）** |
| `mode=off|advisory` 的新 build | `theme_invent`（可 warn） |
| `mode=enforce` 且 `canonicalSliceLock=true` 的新 build | `canonical` |

### 3.3 单一债真源

```text
导演 / 债板 / processed 只读：
  riskFlags.qualityLoop
    ← 汇总 acceptance + setting_alignment + 既有 4 类 artifact 信号

详情缓存（不参与 hasBlocking*）：
  riskFlags.settingAlignment  // 完整 checks，供 UI/调试
```

`hasBlockingSettingAlignmentDebt` **若保留**，必须是：

```ts
function hasBlockingSettingAlignmentDebt(chapter) {
  return classifyChapterQualityLoopRiskFlags(chapter.riskFlags) === "blocking"
    && qualityLoopHasSettingBlockingSignal(chapter.riskFlags);
}
// 禁止第二套独立规则引擎
```

推荐实现更简单：**不**新增 processed 分支；只扩展 qualityLoop 汇总，使 `hasBlockingQualityLoopDebtForAutoExecution` 自然覆盖 setting。

---

## 4. 目标架构（To-Be）

```text
┌─────────────────────────────────────────────────────────────┐
│ Policy: settingQualityMode = off | advisory | enforce       │
│ 默认 off → 下列 enforce 路径整枝跳过                         │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ A. Canonical Setting Pack（导入优先）                         │
│  functionAcceptanceTable · entityRegistry · foreshadow…     │
│  source=import|hybrid 才允许升 enforce                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ B. Framing：不得覆盖 A 硬禁；storyMode 不改 function 顺序     │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ C1. Story World Slice                                         │
│  schemaVersion 保持 1 兼容；lockMode/inventViolations optional│
│  canonical：strip+violations；runtime 永不因 guard 抛垮写章  │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ C2. Volume Planning（enforce 时）                             │
│  function_table → beat_sheet → chapter_list → contract      │
│  coverage 失败 → structured_outline 事实未完成（现网审批）    │
└───────────────────────────┬─────────────────────────────────┘
                            │ structured_outline_ready 审批
                            │ 通过时写 OutlineFreezeSnapshot artifact
┌───────────────────────────▼─────────────────────────────────┐
│ C3. Chapter Runtime                                           │
│  style → acceptance → setting_alignment(规则优先)             │
│  → merge qualityLoop（单源）→ package                         │
│  processed = 现网逻辑 ∧ ¬blocking(qualityLoop)                │
│  function status 写回 planned→assigned→satisfied|missed     │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 关键概念与持久化

| 概念 | 定义 | 持久化 |
|---|---|---|
| **SettingQualityPolicy** | 总开关 | novel meta / plan 字段 |
| **FunctionAcceptanceItem/Table** | 卷功能验收 | `VolumePlanDocument` 扩展字段（contentJson SoT，**不新 Prisma 表**） |
| **functionIds** | 章挂载的功能 | chapter plan JSON + sync 到执行合同可读路径 |
| **SettingAlignmentAssessment** | 章设定对齐结果 | 详情→`riskFlags.settingAlignment`；blocking→**归并 qualityLoop** |
| **OutlineFreezeSnapshot** | 审批通过指纹 | director artifact（挂现网 approval，非新 checkpointType） |
| **EntityRegistry** | 专名允许表 | novel/world JSON 一处 SoT（实现选 novel.meta，避免双写） |

### 4.2 现有插入点（已核实，实现锚点）

| 域 | 文件/符号 | 要点 |
|---|---|---|
| Slice 发明 | `storyWorldSlicePersistence.normalizeStoryWorldSlice` | ID 白名单已有；自由文本无校验 |
| Slice stale | `NovelWorldSliceService` vs `STORY_WORLD_SLICE_SCHEMA_VERSION` | **禁止**为 lockMode 全局升常量触发全量重建 |
| 大纲 | `volumeBeatSheetGeneration` / `volumeChapterListGeneration` | beat 主导；无 functionIds |
| 合同 | `generateChapterTaskSheetDetail` | 无功能验收字段 |
| 定稿 | `ChapterContentFinalizationService` | style → `runAcceptanceGateOnly` |
| 债分类 | `classifyChapterQualityLoopRiskFlags` | **只读** `riskFlags.qualityLoop` |
| 导演进度 | `isDirectorAutoExecutionChapterProcessed` | content + qualityLoop blocking + status |
| 大纲审批 | `novelDirectorPipelineRuntime` `structured_outline_ready` | **复用**，不平行 outline_freeze |

---

## 5. 方案详设

### 5.0 跨切面契约（所有阶段必须遵守）

| ID | 契约 |
|---|---|
| X1 | `mode=off`：本计划代码路径 no-op 或严格旁路，**现网测试全绿** |
| X2 | blocking 真源唯一：`riskFlags.qualityLoop` |
| X3 | 章节 runtime：slice 构建失败 → structure-only fallback + 日志，**禁止**抛到 `runFromReady` 顶层 |
| X4 | enforce 的 function 表：`source` 必须为 `import` 或 `hybrid`（含人工改）；纯 `generated` 不得 enforce |
| X5 | freeze = `structured_outline` readiness 事实 + 通过时 artifact；**不新增** `DirectorAutoApprovalPointCode` |
| X6 | function `satisfied` 必须有写回路径，禁止 C3 空转 |
| X7 | 与 self-cycle 合并时 processed/qualityLoop **单点修改** |
| X8 | 伴随改动必扫：`volumeGenerationMemorySafety` / telemetry / schemas / 债板 projection / shared exports |

---

### 5.1 B1 — World Slice Canonical Lock

#### 5.1.1 数据模型（兼容优先）

```ts
// shared/types/storyWorldSlice.ts
// STORY_WORLD_SLICE_SCHEMA_VERSION 保持 1（或仅当必须改 breaking 时再升，并附原地补丁迁移）
// 禁止：升常量 → 全部 cache stale → 全量 LLM 重建

export type StoryWorldSliceLockMode = "canonical" | "theme_invent";

// metadata 扩展（全部 optional，旧数据合法）
metadata: {
  schemaVersion: number; // 现网 1
  builderMode: ...;
  lockMode?: StoryWorldSliceLockMode;      // 缺省按 theme_invent 解释
  inventViolations?: string[];             // strip 掉的发明项，可观测
  // ...既有字段
}
```

**迁移**：读 v1 无 lockMode → 不视为 stale；不调用 rebuild。仅 **新 build** 写入 lockMode/violations。

#### 5.1.2 Guard API（永不靠抛错阻断写章）

```ts
// storyWorldSliceCanonicalGuard.ts
export type CanonicalGuardResult = {
  ok: boolean; // false = 有 violations（可能已 strip）
  slice: StoryWorldSlice; // 始终返回可用 slice
  violations: string[];
  stripped: boolean;
};

export function applyCanonicalStoryWorldSliceGuard(input: {
  slice: StoryWorldSlice;
  structure: WorldStructuredData;
  entityRegistry: string[]; // 允许专名
  lockMode: StoryWorldSliceLockMode;
}): CanonicalGuardResult;
```

| lockMode | 行为 |
|---|---|
| `theme_invent` | 不 strip；violations 可空或 soft warn |
| `canonical` | 自由文本字段 **strip** 未注册专名 / 高置信发明模式；写入 `inventViolations`；**仍返回 slice** |

规则（canonical strip）：

| 字段 | 规则 |
|---|---|
| appliedRules / forces / locations | 保持现有 ID 白名单 |
| activeElements / pressure / mystery / conflict / coreWorldFrame / scope | 相对 registry∪structure 名表 strip 未知专名；高置信发明模式（如未注册「××者」、源世界金样例中的发明句） |
| forbiddenCombinations | 允许自然语言；未注册势力名 strip |

**误杀控制（P1-R1 收口）**：

- 阶段 1 交付 **金样例集**（≥20 条）：发明句必须 strip；合法压力/环境句不得 strip  
- 启发式默认 **保守**：宁漏判进 violations warn，不误杀；仅金样例覆盖的高置信模式 hard strip  
- 误杀率验收：金样例合法句 0 误杀，否则降级为 advisory 标记不 strip

#### 5.1.3 Build 路径

```text
LLM raw → normalizeStoryWorldSlice（永不抛业务致命）
  → applyCanonicalGuard（按 lockMode）
  → 若 enforce 且 violations 过多：可选 1 次带 feedback 重试
  → 仍脏：structure-only fallback slice（无发明，可写书）
  → 持久化 cache（含 violations 元数据）
```

- **显式 build API**（手动刷新）可返回 `ok:false` 给 UI，仍带 fallback slice  
- **章节 runtime / GenerationContextAssembler**：只取可用 slice，忽略 ok  

#### 5.1.4 Prompt

`storyWorldSlice.prompts.ts`：当 `canonical` 时增加禁令——禁止创造 structure 外规则名/势力/地点/能力术语；自由句只描述压力关系。

#### 5.1.5 文件清单

| 动作 | 路径 |
|---|---|
| 改 | `shared/types/storyWorldSlice.ts`（optional 字段，**不升全局强制 version 行为**） |
| 改 | `storyWorldSlicePersistence.ts` |
| 新建 | `storyWorldSliceCanonicalGuard.ts` |
| 改 | `NovelWorldSliceService.ts`（stale 逻辑：无 lockMode ≠ stale） |
| 改 | `prompting/prompts/storyWorldSlice/*` |
| 新建测 | `storyWorldSliceCanonicalGuard.test.js`（金样例 + v1 兼容 + fallback） |
| 扩测 | `storyWorldSlice.test.js` |

---

### 5.2 B2 — 功能验收表 First-Class

#### 5.2.1 结构

```ts
// shared/types/functionAcceptance.ts
export interface FunctionAcceptanceItem {
  id: string;
  order: number;
  title: string;
  mustHappen: string;
  mustNotHappen?: string[];
  charactersOnPage?: string[];
  locationHints?: string[];
  foreshadowIds?: string[];
  targetChapterHint?: string; // 软提示，非字数闸
  acceptanceChecks: string[];
  /** 写回状态，见 §5.2.5 */
  status: "planned" | "assigned" | "satisfied" | "missed";
  assignedChapterOrders?: number[];
}

export interface FunctionAcceptanceTable {
  volumeId: string;
  schemaVersion: 1;
  source: "import" | "generated" | "hybrid";
  items: FunctionAcceptanceItem[];
}
```

`VolumePlanDocument` 增加：

```ts
functionAcceptanceTable?: FunctionAcceptanceTable | null;
```

Chapter plan / execution 可读：

```ts
functionIds?: string[]; // mode=off 时可缺省
```

#### 5.2.2 管线顺序

```text
strategy
  → function_table   【新】import 优先；可 generated（不得 auto-enforce）
  → beat_sheet       【改】mustDeliver 映射 function 子集（enforce 时）
  → chapter_list     【改】enforce 时每章 functionIds + coverage
  → execution_contract 【改】对齐 function items；taskSheet 新模板（B4）
```

`mode=off`：不插入 function_table 强制；若 JSON 里已有表，忽略覆盖门禁。

#### 5.2.3 覆盖校验

```ts
validateFunctionCoverage(table, chapters): { ok: boolean; missingIds: string[]; issues: string[] }
```

**仅 `mode=enforce`**：

- 每个非 `missed` 的 item 至少被一章 `functionIds` 引用 → 否则 chapter_list / outline **事实未完成**  
- `mustNotHappen` 合并进相关章 `mustAvoid`  
- 未覆盖 → **不得** `execution_contract.sync` 视为完成；走现网 `structured_outline_ready` 未通过语义  

**`advisory`**：算出 missing，写报告，不挡 sync。  
**`off`**：不跑。

#### 5.2.4 导入 vs 生成

| source | 可否 enforce |
|---|---|
| `import` | 可（用户确认策略后） |
| `hybrid`（import + 人工改） | 可 |
| `generated` | **否** — 只可 advisory；UI 明文「生成表未人工确认，不能启用强制门禁」 |

storyMode（含 growth_leveling）：**不得改写 function 表顺序**；仅影响 scene 密度提示。beat/chapter prompt 加硬句 + 单测快照关键句存在。

#### 5.2.5 功能状态写回（C3 前置，P0-R5 收口）

| 转换 | 时机 | 执行点 |
|---|---|---|
| → `planned` | 表创建/导入 | function_table 阶段 |
| → `assigned` | chapter_list 挂上 functionIds | list merge / sync |
| → `satisfied` | 该 function 的 **全部** `acceptanceChecks` 在所属章 setting_alignment **规则段 pass**，或人工 `mark_function_satisfied` | finalization 后 `FunctionAcceptanceStatusService` |
| → `missed` | 卷末 enforce 仍未 satisfied 且未 force | volume completion 计算时 |

跨章功能：所有 assigned 章的相关 checks 均 pass 才 `satisfied`。  
alignment 单次 pass **不**单独把无关 function 标 satisfied。

#### 5.2.6 functionIds 持久化与 sync（P1-R3）

- SoT：volume `contentJson` 内 chapter plan  
- `VolumeChapterSyncService`：**往返保留** `functionIds`  
- 执行上下文 / contract：assembler 与 taskSheet 生成可读 `functionIds` + 表项  
- 单测：sync 前后 JSON 含 functionIds

#### 5.2.7 文件清单

| 动作 | 路径 |
|---|---|
| 新建 | `shared/types/functionAcceptance.ts`、`settingQualityPolicy.ts` |
| 改 | `shared/types/novel.ts`（VolumePlanDocument） |
| 新建 | `volumeFunctionTableGeneration.ts`、`volumeFunctionCoverage.ts` |
| 新建 | `FunctionAcceptanceStatusService.ts`（写回） |
| 改 | `volumeGenerationOrchestrator.ts`、beat/list/helpers/schemas |
| 改 | `volumeGenerationMemorySafety.ts`、telemetry、helpers scope 联合 |
| 改 | `VolumeChapterSyncService.ts` |
| 测 | coverage / sync 往返 / mode 矩阵 |

---

### 5.3 B3 — Setting Alignment Gate

#### 5.3.1 链路位置与合成（P0-R7）

```text
正文
  → style review（现有）
  → acceptance gate（现有）
  → setting_alignment（新：规则段始终可跑；LLM 段可选）
  → mergeQualityLoop(acceptance, setting, …)  // 单源
  → package / riskFlags
```

| 规则 | 说明 |
|---|---|
| 跑闸条件 | `mode=off`：跳过。`advisory|enforce`：跑规则段 |
| acceptance 已 risk | **仍跑** alignment 规则段（防只修文笔） |
| 合成 | severity：`blocking` > `repairable` > `pass`；`recommendedAction` 取更严 |
| 预算 | **共用**既有 qualityLoop budget；无 setting 专用无限重试 |
| 规则段 | 硬禁词表 / function checks 关键词或结构化线索 / 必出角色；目标廉价、可测 |
| LLM 段 | 仅模糊项；**超时或失败 → 不默认 blocking**；记 observability + 可选 repairable |
| enforce + 规则 hard 失败 | → qualityLoop blocking（manual_gate 或 patch_repair） |
| advisory + 失败 | → non_blocking signal 或详情 only |

**禁止**：`overallScore >= 7 ⇒ 设定通过`。

#### 5.3.2 评估 I/O

输入：正文、functionIds+表项、exclusiveEvent/mustAvoid、出场义务、registry、硬禁/伏笔窗口。  

```ts
export interface SettingAlignmentAssessment {
  chapterId: string;
  status: "pass" | "repairable" | "blocking";
  score: number; // 独立于 prose
  checks: Array<{
    id: string;
    kind: "function" | "entity" | "forbid" | "foreshadow" | "location";
    passed: boolean;
    severity: "low" | "medium" | "high";
    summary: string;
    evidence?: string;
  }>;
  recommendedAction: "continue" | "patch_repair" | "replan" | "manual_gate";
  ruleEngineVersion: string;
  llmUsed: boolean;
}
```

#### 5.3.3 归并 qualityLoop（P0-R3）

```ts
// 扩展 signals 允许 artifactType 含 "setting_alignment"
// 汇总器：
// - 任 hard setting check 失败且 mode=enforce → overallStatus invalid/risk + recommendedAction
// - 写入 riskFlags.qualityLoop（唯一 blocking 源）
// - 完整 assessment → riskFlags.settingAlignment（详情）
```

导演：

```ts
// 保持
if (hasBlockingQualityLoopDebtForAutoExecution(chapter)) return false;
// 不新增第二套 processed 条件（避免双源）
// 若 qualityLoop 未正确归并 setting，视为实现 bug
```

#### 5.3.4 缓存与性能

- 复用 `ChapterQualityGateService` contentHash + requestKey 持久缓存范式  
- 规则段目标亚 50ms 级（纯 CPU）  
- LLM 段独立超时（建议 ≤ 现网 acceptance 超时策略）

#### 5.3.5 文件清单

| 动作 | 路径 |
|---|---|
| 新建 | `shared/types/settingAlignment.ts` |
| 新建 | `ChapterSettingAlignmentService.ts`、规则引擎纯函数文件 |
| 改 | `ChapterQualityGateService.ts`、`ChapterContentFinalizationService.ts` |
| 改 | `shared/types/chapterQualityLoop.ts`（signal 类型 + 汇总） |
| 改 | 债板 projection（若有消费者 switch） |
| Prompt | `settingAlignment.prompts.ts`（可选 LLM） |
| 测 | 合成矩阵、超时非阻塞、enforce vs advisory、processed 矩阵 |

---

### 5.4 B4 — taskSheet 模板重写

#### 5.4.1 新合同语义

```text
【本章独占事件】一句话，可拍成现场
【在场人物】必须露脸 / 故意 offscreen（与 must_on_page 语义对齐，避免双重 hard）
【人物选择】有代价的选择（写选择，不写觉悟句）
【现场压力】环境/社会/身体（龙族节点：一处整体环境锚）
【功能兑付】functionIds → acceptanceChecks 短列表（enforce/advisory 有表时）
【禁止】说明书讲规则、死人上课、未到期伏笔、未注册设定发明
```

降权：「读者应理解…」「主题是…」类钉认知句。

#### 5.4.2 质量门（规则优先，P1-R4）

`chapterTaskSheetQuality` 新增 issue（**正则/结构规则优先**，LLM 仅 borderline）：

- `cognitive_nailing`  
- `missing_choice_pressure`  
- `missing_scene_anchor`  

与 self-cycle **strip 内部 code** 兼容：先 sanitize codes，再跑语义规则。

`mode=off`：可只上线更温和的规则（或整段 gate 扩展 behind flag）；推荐 **规则对所有书 advisory 级提示**，blocking 合同失败仅 `enforce` 或现有 full_book_autopilot 策略下启用——实现时与 `ChapterTaskSheetQualityMode` 对齐，写入阶段契约。

#### 5.4.3 文件清单

| 动作 | 路径 |
|---|---|
| 改 | `chapterDetail.prompts.ts`、contract schema |
| 改 | `generateChapterTaskSheetDetail` |
| 改 | `chapterTaskSheetQuality.ts` + GateService + prompts |
| 改 | `chapterLayeredContext` writer-facing 顺序 |
| 测 | 钉认知打回；选择+现场通过；strip 后不误伤 |

---

### 5.5 C1 — Outline Freeze（复用现网审批，P0-R4）

#### 5.5.1 流程

```text
structured_outline 步骤（含 function_table + list + detail，enforce 时）
  → validateFunctionCoverage + build OutlineDiffReport
  → 写入 step readiness / inspectCompletion 事实
       enforce 且未覆盖 → completed=false（现网不会进 auto_execute）
  → 用户/策略通过 structured_outline_ready（现网 resolveRuntimeApproval）
  → 通过钩子：persist OutlineFreezeSnapshot { contentHash, tableFingerprint, diffSummary }
  → execution_contract.sync + 现网 chapter_batch 路径
```

**禁止**：新建 `outline_freeze` checkpointType / 平行 waiting_approval 状态机。

`mode=off|advisory`：不因缺 freeze snapshot 拦截 auto_execute。  
`mode=enforce`：无合法 snapshot 且覆盖未通过 → 事实未完成（等同现网未批 outline）。

#### 5.5.2 Diff 报告内容

- 功能覆盖矩阵 item → chapters  
- 硬禁扫描  
- 舞台锚 / 人物坑窗口  
- 与 beat 名 **仅信息性** 对比  

#### 5.5.3 文件

| 动作 | 路径 |
|---|---|
| 新建 | `outlineDiffAgainstFunctions.ts` |
| 新建 | `OutlineFreezeArtifact.ts` 或挂现有 director artifact ledger |
| 改 | structured outline step modules 的 inspectCompletion / 完成钩子 |
| 改 | **不**改平行 Policy 新点；只扩展 readiness 事实 |
| 前端 | P2；首期 artifact JSON 可验收 |

---

### 5.6 C2 — Mid-run Diff（本 milestone **Backlog**）

| 项 | 收口后默认 |
|---|---|
| 是否做 | **本 milestone 不做**（P2 backlog） |
| 若未来做 | 默认 `midRunDiffMode=advisory`；enforce 书可开 blocking |
| 与 BatchRoll | 若 blocking：`halt_for_review` > expand_range；不得静默跳过 |

避免默认每 10 章停，破坏自循环体验（P1-R5）。

---

### 5.7 C3 — 监管停条件与设定卷解耦

#### 5.7.1 语义

| 条件 | `volumeCompletion` |
|---|---|
| enforce 且全部 function `satisfied` | `setting_complete` |
| 章写满但存在未 satisfied（非 force） | `prose_complete_only`（监管默认不收工） |
| 用户显式 `force_complete_volume`（可审计） | `forced` |
| mode=off | 保持现网「窗尽/workflow_completed」语义，字段可省略或 `legacy` |

```ts
export function resolveVolumeCompletion(input: {
  mode: SettingQualityMode;
  functionTable: FunctionAcceptanceTable | null;
  forceFlag?: boolean;
  forceAudit?: { actor: string; at: string; reason: string };
}): "legacy" | "setting_complete" | "prose_complete_only" | "forced"
```

依赖 §5.2.5 写回；无写回则本阶段验收失败。

#### 5.7.2 文件

| 动作 | 路径 |
|---|---|
| 新建 | `volumeSettingCompletion.ts` |
| 改 | checkpoint payload / projection（completion 枚举） |
| 改 | BatchRoll `completed_scope` 仅在接 self-cycle 后挂接；本计划可先写纯函数 + 投影 |
| 文档 | vault `27` 停条件（Manual-required） |

---

## 6. 非目标

- 不重写 LLM provider 层  
- 不机械每章字数硬闸到 1.2 万  
- 不在本计划重写《源世界》1–40 正文  
- 不把 Obsidian 全文塞进每章 prompt  
- 不替代 self-cycle BatchRoll  
- 不做前端大改 / 完美 NER / 历史章回填  
- 不策略化 `skip_quality_repair`  
- **不**对本 milestone 交付 C2 blocking mid-run  
- **不**默认全站 enforce  

---

## 7. Milestone 契约（实现时冻结用稿）

```text
Milestone：设定对齐与生文质量 P0
目标：opt-in enforce 下 canonical slice + 功能表 + setting→qualityLoop 单源门禁
      + taskSheet 模板 + 复用 structured_outline_ready 的 freeze artifact
      + function 状态写回 + volumeCompletion 三态
P0：
  - settingQualityMode 默认 off，兼容矩阵绿
  - B1 guard strip+fallback，不升全局 stale
  - B2 function 表 + coverage（仅 enforce）+ sync 往返 + 状态写回
  - B3 alignment 规则优先 + 归并 qualityLoop + 合成/预算/超时策略
P1：
  - B4 taskSheet 规则语义 gate
  - C1 freeze artifact 挂现网审批
  - C3 completion 枚举与投影
P2/Backlog：C2 mid-run、前端 diff UI、NER、1–40 回填
Manual-required：源世界 import 表人工确认 → 升 enforce；pxed 发版；再生产授权
阶段上限：5
停止：P0+P1 测绿 + §8 勾选；不自动开内容重写；不自动恢复写书
```

| 阶段 | 内容 | 可验证结果（含兼容） |
|---|---|---|
| **1** | Policy 类型 + B1 guard/金样例/fallback/v1 兼容 | mode=off 零行为变化；canonical strip 金样例过；脏 LLM→fallback 可装配 |
| **2** | B2 表+coverage+orchestrator+sync+写回骨架 | enforce 漏功能 → outline 事实未完成；generated 不可 enforce；sync 保留 functionIds |
| **3** | B3 alignment + qualityLoop 归并 + finalization 合成 | 硬禁 enforce→blocking processed；LLM 超时不默认 blocking；advisory 不挡 |
| **4** | B4 taskSheet 模板+规则 gate | 钉认知打回；与 strip 共存 |
| **5** | C1 artifact + C3 completion + 端到端夹具 | 现网 approval 路径；satisfied 写回；三态 completion；回归 mode=off |

---

## 8. 验收标准

### 8.1 自动化

**兼容**

- [ ] `mode=off`：既有 worldSlice / volume / acceptance / autoExecution 相关测试仍绿  
- [ ] 存量 v1 slice 读取 **不**触发 stale 强制重建  

**B1**

- [ ] 金样例：发明句 strip，合法句 0 误杀  
- [ ] fallback slice 可被 GenerationContext 消费；guard 不抛垮  

**B2**

- [ ] enforce 漏功能 → coverage 失败  
- [ ] generated 表拒绝升 enforce  
- [ ] sync 往返 functionIds  
- [ ] assigned/satisfied 写回单测  

**B3**

- [ ] 仅写 settingAlignment 详情、不归并 qualityLoop → processed 仍 true（证明不双源）  
- [ ] 归并 blocking → processed false  
- [ ] acceptance pass + 硬禁 → blocking  
- [ ] LLM 超时 + 规则 pass → 非默认 blocking  

**B4**

- [ ] cognitive_nailing 规则命中  
- [ ] 合法选择+现场合同通过  

**C1/C3**

- [ ] enforce 未覆盖时 structured_outline 事实未完成  
- [ ] 审批通过后存在 freeze artifact  
- [ ] 全 satisfied → `setting_complete`；缺一 → `prose_complete_only`；force+audit → `forced`  

- [ ] shared build + server typecheck / 相关 test 绿  

### 8.2 场景验收（夹具 novel）

迷你包：3 功能 + 2 硬禁 + 城校名；`mode=enforce` + import 表。

1. slice 无未注册「脱序者」类词（strip/fallback 后）  
2. chapter_list 覆盖 3 功能  
3. 缺功能正文 → qualityLoop blocking，导演不 processed  
4. 合法正文 → pass，function 写回 satisfied  
5. 未过 outline 事实前不能 auto_execute（现网语义）  
6. 全 satisfied → `setting_complete`  

另跑 **同一夹具 mode=off**：行为与改造前基线一致。

### 8.3 生产回归（Manual-required）

- 源世界 import `11` 功能表 → 确认 → enforce  
- 重跑 **规划**（不重写 40 章）  
- 人过 diff 一眼  
- 再开写另令  

### 8.4 再生产后质量指标（非本开发编造）

- 设定对齐主观分 ≥ 8/10  
- F5/舞台锚/人物窗口大纲可追踪  
- 无系统性发明 lore  

---

## 9. 风险与缓解（收口后）

| ID | 风险 | 缓解（已设计内建） |
|---|---|---|
| R1 | 专名误杀 | 金样例 0 误杀门禁；保守启发式；fallback |
| R2 | 功能表僵化 | checks 短句；多章共享；禁止机械字数 |
| R3 | 成本/延迟 | 规则优先；缓存；LLM 可选超时 |
| R4 | 与自循环冲突 | 合并序 + processed 单点 |
| R5 | 历史书无 functionIds | 默认 mode=off |
| R6 | 停条件误解 | completion 枚举 + vault 文案 |
| R7 | 范围膨胀 | 5 阶段；C2 backlog |
| R8 | 双源债 | 仅 qualityLoop blocking |
| R9 | 平行审批闸 | 复用 structured_outline_ready |
| R10 | schema stale 风暴 | 不升全局强制 version |
| R11 | generated 错表 enforce | 源校验拒绝 |
| R12 | satisfied 空转 | 写回服务 + 验收门禁 |

---

## 10. 推荐默认决策（最终）

1. **`settingQualityMode` 默认 `off`**  
2. **blocking 真源 = `riskFlags.qualityLoop` only**  
3. **slice schemaVersion 行为保持兼容**；lockMode optional 缺省 theme_invent  
4. **canonical strip + fallback**；不抛垮写章  
5. **function 表 import 优先**；generated 不可 auto-enforce  
6. **freeze = 现网 approval + artifact**  
7. **C2 mid-run = backlog**；未来默认 advisory  
8. **Prisma 不新表**；contentJson + riskFlags + artifacts  
9. **alignment 规则优先**；LLM 失败不默认 blocking  
10. **force 完成卷必须带 audit 字段**  

---

## 11. 实现期执行口径

- 工作目录：`AI-Novel-Writing-Assistant`  
- Codex 目标模式：契约（粘贴 §7）→ 阶段实现 → 验证 → `production-code-quality-review` → 原子 commit → 总结 → **停止**  
- Commit：`feat(phase-N):` / `fix(phase-N):` / `test(phase-N):`  
- **禁止**本计划内自动恢复 pxed 写书、禁止 skip_quality_repair  
- 运维事实以 Obsidian `AI-DOC-ROUTER` 为准（pxed + ainovel.mangoq.ccwu.cc）  

每阶段结束审查须显式勾选：§5.0 X1–X8 未破。

---

## 12. 与 Obsidian / 内容 backlog

| 项 | 归属 |
|---|---|
| 本开发文档 | monorepo `docs/plans/` |
| 驾驶简报 `13` / 监管 `27` | 发版后更新停条件与 enforce 流程（Manual） |
| F5 缺失、短章、沈晚弱 | **内容修复 backlog**，不晋升本 milestone |
| 自循环 BatchRoll | 独立计划；合并序见 §1.4 |

---

## 13. 附录 A — 源世界功能表种子（示意）

> **非代码硬编码真源**；导入以 Obsidian `11` 全表为准。

| id | mustHappen（摘要） | 硬禁提示 |
|---|---|---|
| vol1.fn.01_establish_loser | 何屿废柴日常可感 | |
| vol1.fn.02_zhao_errand | 赵客气使唤立住 | |
| vol1.fn.03_shen_wan_kindness | 沈晚小善 | |
| vol1.fn.04_world_seam | 世界缝/传闻擦边 | |
| vol1.fn.05_meet_lu_shen | 撞上绝境陆深；环境锚 | |
| vol1.fn.06_entrust | 真同意托付+身亡+P5+恩人债 | 死人上课；伟岸遗言课 |
| vol1.fn.06b_f5_hint | 遗言模糊猫/会来找你 | 猫出场；答案句 |
| vol1.fn.07_aftermath | 藏事/后遗/被盯感 | |
| vol1.fn.08_11_probe_revenge | 试探与打不穿 | 无代价变强 |
| vol1.fn.12_measure | 沈博文短接触制止；机构神秘 | 约谈导师 |
| vol1.fn.13_eval | 评估阴影 | 机构摊牌 |
| vol1.fn.15_social_punish | 社会性小惩赵 | 署刀代打 |
| vol1.fn.16_18_shen_wan_arc | 失联+背锅名裂 | 沈晚死亡实锤 |
| vol1.fn.19_20_red_pill | 红·入署选择 | 蓝线正文 |
| … | 以 `11` 20 功能章全表导入 | 制造产业链/恋爱主笔/父线 |

入署后走廊（`20`）属卷二窗口；卷一 freeze 以 `11` 为主，不把周砚/唐晚晴误塞进卷一强制功能，除非用户改锁。

---

## 14. 附录 B — 关键符号速查

| 符号 | 路径 |
|---|---|
| `normalizeStoryWorldSlice` | `storyWorldSlicePersistence.ts` |
| `NovelWorldSliceService` / stale | `NovelWorldSliceService.ts` |
| `generateBeatSheet` | `volumeBeatSheetGeneration.ts` |
| `generateChapterTaskSheetDetail` | `volumeGenerationHelpers.ts` |
| `VolumeChapterSyncService` | volume sync |
| `runAcceptanceGateOnly` | `ChapterQualityGateService.ts` |
| `ChapterContentFinalizationService` | runtime |
| `classifyChapterQualityLoopRiskFlags` | `shared/types/chapterQualityLoop.ts` |
| `hasBlockingQualityLoopDebtForAutoExecution` / `isDirectorAutoExecutionChapterProcessed` | `novelDirectorAutoExecution.ts` |
| `resolveRuntimeApproval(..., "structured_outline_ready")` | `novelDirectorPipelineRuntime.ts` |
| `characterAppearanceObligation` | `characterAppearanceObligation.ts` |

---

## 15. 文档状态

| 项 | 状态 |
|---|---|
| 调查 | ✅ |
| 设计正文 | ✅ 与审查收口一致 |
| 审查 P0/P1 | ✅ 已吸收进 §3–§10，无对立默认 |
| Milestone 冻结 / 开工 | ⏸ 待用户确认 §7 契约 |
| 生产重跑写书 | ⏸ Manual-required |

**下一步**：用户确认 §7 → 输出 Codex 执行契约（复制 §7 + §5.0）→ 阶段 1 开工。

---

## 16. 审查收口对照表（历史问题 → 正文位置）

| 原问题 | 收口位置 |
|---|---|
| P0-R1 feature flag / 默认全开 | §3.1 `settingQualityMode` 默认 off |
| P0-R2 schemaVersion stale | §5.1.1 保持兼容、不升强制常量 |
| P0-R3 双源债 | §3.3、§5.3.3 仅 qualityLoop blocking |
| P0-R4 平行 freeze 状态机 | §5.5 复用 structured_outline_ready |
| P0-R5 satisfied 无写回 | §5.2.5 + C3 依赖 |
| P0-R6 guard 抛垮写章 | §5.1.2–5.1.3 result+fallback |
| P0-R7 合成/预算/超时 | §5.3.1 |
| P1-R1 误杀 | §5.1.2 金样例 0 误杀 |
| P1-R2 generated enforce | §3.1、§5.2.4 |
| P1-R3 sync functionIds | §5.2.6 |
| P1-R4 taskSheet LLM | §5.4.2 规则优先 |
| P1-R5 mid-run blocking | §5.6 backlog / advisory |
| P1-R6 合并序 | §1.4、§5.0 X7 |
| P1-R7 storyMode 盖表 | §5.2.4 硬句+测 |
| 伴随文件清单 | §5.0 X8、§5.2.7 |

**通过状态**：收口后设计 **可安全冻结开工**（实现时仍按阶段 review）。

---

*End of plan.*
