# CosyVoice 借鉴调研与分阶段设计

> **类型**：调研 + 分阶段可借鉴清单（不锁定本轮实现）
> **日期**：2026-07-24
> **对照对象**：[FunAudioLLM/CosyVoice](https://github.com/FunAudioLLM/CosyVoice)（Apache-2.0；Fun-CosyVoice 3.0 0.5B）
> **我们现状 tip**：`f4a6128`（有声书 diarize P0 live）
> **主链**：MiMo chat-audio 远端（CPA），三模态 `preset | design | clone`
> **相关 SoT**：`audiobook-segment-delivery-style-plan.md` · `audiobook-voice-library-ops-and-ai-plan.md` · `audiobook-channel-diarize-cast-plan.md` · `audiobook-mimo-tts-multi-backend-plan.md`

---

## 0. TL;DR

CosyVoice 对我们最有价值的**不是**「再接一个开源模型当默认 TTS」，而是它把**可控合成的几层产品化**了。逐层对照后：

- **instruct 结构化**：我们**已有**（`deliveryStyle.ts` 的 `AudiobookSegmentDelivery` → `deliveryLine`）。边际收益低。
- **读音修补（Pinyin/专名）**：我们**没有**。中文网文刚需。**ROI 最高、引擎无关、风险最低**。
- **文本归一（TN，数字/符号/专名）**：我们只有极薄 `sanitizeTtsChunkText`。**ROI 高、引擎无关**。
- **clone 参考音频规范**：我们有审批门，但**无 ref 声学质量门**。中 ROI，贴现有库审批。
- **方言/口音维度**：我们无一等公民字段。中 ROI，看后续书是否有地域角色。
- **CosyVoice 作第二引擎**：高成本（GPU/托管、协议分叉、双轨质检）。仅适合**克隆兜底 / 听感对照**，不进主链默认。
- **流式 ~150ms**：我们是离线章 wav 交付，产品形态不匹配。除非在线试听改流式，否则 backlog。

**建议实现顺序（若后续动手）**：P0 读音词典 + TN → P1 clone ref 质量门 → P2（可选）方言字段 → P3（可选、独立立项）CosyVoice 侧车引擎。

本文档只给出**分层设计与接口草图 + 精确代码落点**，供逐块决策；不代表本轮全实现。

---

## 1. CosyVoice 是什么（对照维度提炼）

| 维度 | CosyVoice 3.0 | 出处 |
|---|---|---|
| 定位 | LLM-based 多语零样本 TTS，全栈训练/推理/部署 | README |
| 模型 | Fun-CosyVoice3-0.5B-2512（base + RL）；CosyVoice2-0.5B（流式）；1.0 300M/SFT/Instruct | README/ModelScope/HF |
| 语言 | 9 语种 + 18+ 中文方言/口音 | README |
| 推理模式 | `sft` / `zero_shot` / `cross_lingual` / `instruct` | client 模式 |
| 可控性 | Pinyin / CMU **读音 inpainting**；instruct 控情绪/语速/方言/音量 | README |
| 文本归一 | 内置 TN（数字/符号），无传统 frontend（ttsfrd 缺失时 wetext 兜底） | README |
| 流式 | bi-streaming 文本进/音频出，延迟低至 ~150ms | README/ICASSP2025 |
| 部署 | Conda / Docker（gRPC/FastAPI）/ TRT-LLM+Triton；ModelScope/HF 下载 | README |
| 许可 | Apache-2.0 | LICENSE |

**关键差异**：CosyVoice 是**本机/自托管 0.5B 模型**；我们是**远端 MiMo chat-audio（CPA 代理）**。二者不是同一形态，采用需权衡 GPU/托管成本。

---

## 2. 能力映射（CosyVoice vs 我们栈）

| CosyVoice 能力 | 我们现状（代码落点） | 差距 | 借鉴度 |
|---|---|---|---|
| Instruct 情绪/语速/音量 | `deliveryStyle.ts` `AudiobookSegmentDelivery`（emotion/intensity/rate/vocalEffort/pitchMove）→ `compileDeliveryLine` → MiMo user | **已覆盖** | 低 |
| 段级控制粒度 | 段级表演 Core/Extended，章默认 + 段覆盖（delivery-style-plan） | 已覆盖 | 低 |
| Zero-shot clone | `ttsMode=clone`，`MimoChatAudioTTSProvider` DataURL/refAudioPath | 协议已有 | 低（协议）/ **高（ref 规范）** |
| SFT 预置 | `ttsMode=preset` 预置名 | 已覆盖 | 低 |
| Cross-lingual | 无产品能力 | 缺 | 中（多语书再开） |
| **读音 inpainting** | **无**；靠正文/人工 | **缺** | **高** |
| **文本归一 TN** | `sanitizeTtsChunkText`（仅补标点/丢空）`ttsTextSanitize.ts` | **薄** | **高** |
| **方言/口音一等公民** | design 文案可写；`VoiceBrief` 无 dialect 字段 | 缺 | 中 |
| Ref 质量把关 | 库审批 `heardAt/heardSha`（听过才批），**无声学质量门** | 部分 | 中 |
| Bi-streaming | 离线章 wav/m4b 交付（`AudiobookPipelineService`） | 形态不同 | 低 |
| 自托管/TRT | 远端 MiMo；multi-backend fallback 已有 env 通道 | — | 中（若上二引擎） |

---

## 3. 分阶段借鉴设计

> 每阶段独立可决策、可单独立 plan → spec → 实现。互不阻塞。

### P0 · 读音词典 + 有声书 TN（引擎无关，ROI 最高）

**问题**：中文网文合成硬伤——多音字（「重」chóng/zhòng）、生造人名/地名/功法名读错、数字与符号硬读（章节号、ID、手机号、百分比、英文缩写、中英混排）。CosyVoice 用 Pinyin/CMU inpainting + 内置 TN 解决；我们只有补标点级 sanitize。

**设计原则**：
- **不改正文落库**：只在**合成文本**上做替换/旁注，正文 `Chapter.content` 不动。
- **唯一收口**：所有替换在 `sanitizeTtsChunkText` 同层之前/之内，保证 preset/design/clone 与旁白/角色全通道一致。
- **与通道 diarize 正交**：TN 只作用于 `renderPolicy=tts` 的段；typed/chat/on_screen 已 skip，不参与。
- **词典分层**：全局默认 < 书级 < 角色级（就近覆盖）。

**新模块**（建议）：`server/src/services/audiobook/diarize/ttsPronounce.ts`

```ts
/** 读音/TN 替换项。三种形态之一。 */
export interface PronounceRule {
  /** 匹配串（字面）或 /.../ 源（后续可选正则）。一期先字面。 */
  match: string;
  /**
   * 替换策略：
   * - "reading"：整体替换为可读串（如 "3.5" → "三点五"、"CP" → "西批"）
   * - "annotate"：保留字形，追加注音提示给 TTS（如 "重楼（chóng lóu）"）——
   *   仅在引擎能吃注音时启用；MiMo 不稳则退化为 reading。
   */
  kind: "reading" | "annotate";
  /** reading：目标可读串；annotate：拼音/注音串 */
  to: string;
  /** 作用域来源（审计/去重） */
  scope: "global" | "book" | "character";
}

export interface PronounceDict {
  /** 已按 scope 合并 + 按 match 长度降序（长匹配优先） */
  rules: PronounceRule[];
}

/**
 * 对单段/单 chunk 合成文本应用读音/TN。
 * - 幂等：多次应用结果一致
 * - 不跨段：只处理传入文本
 * - 长匹配优先，避免子串误伤
 * - 失败/空规则 → 原文返回（永不抛）
 */
export function applyPronounce(text: string, dict: PronounceDict): string;

/** 内置 TN：数字/百分比/常见符号 → 可读中文；纯规则，无词典也生效。 */
export function normalizeReadableText(text: string): string;
```

**接线**：`audiobookChunk.ts:102`

```ts
// 现在：
const text = sanitizeTtsChunkText(raw);
// 借鉴后（顺序：TN → 词典 → 补标点）：
const normalized = normalizeReadableText(raw);
const pronounced = applyPronounce(normalized, dict);   // dict 由任务级预加载
const text = sanitizeTtsChunkText(pronounced);
```

`dict` 从任务上下文注入（书级 + 角色级词典在 annotate/pipeline 起点加载一次，避免每 chunk 重建）。

**数据存储**（一期最小）：
- 全局默认：仓内常量表（数字/符号 TN + 通用多音词种子）。
- 书级/角色级：新表或复用现有 JSON 字段。二选一见 §5「开放问题」。

**验收**：
- 单测：多音字、数字、百分比、手机号、英文缩写、中英混排、长短匹配优先、幂等、空词典透传。
- Manual：源世界 ch1 抽取 5–10 个已知读错点，词典命中后重合成对比。

**风险**：`annotate` 依赖引擎吃注音；MiMo 不稳 → 一期默认只用 `reading`，`annotate` 留 flag。

---

### P1 · clone 参考音频质量门（贴库审批）

**问题**：zero-shot 克隆质量高度依赖参考音频（干净、单说话人、时长、情感中性）。我们有 `heardAt/heardSha`（人听过才批），但**无声学层质量门**——脏 ref 也能批。

**设计**：在 `VoiceAsset`（clone_ref）审批链加**声学预检**（引擎无关，本机分析）：

```ts
export interface RefAudioQuality {
  durationSec: number;
  /** 估计信噪比（dB），静音/底噪检测 */
  snrDb: number | null;
  /** 是否疑似多说话人（能量分段的粗启发，非完整 diarize） */
  multiSpeakerSuspect: boolean;
  /** 首尾静音过长 / 削波 */
  clipping: boolean;
  leadingSilenceSec: number;
  /** 推荐用途 */
  recommendedUse: "clone" | "preview_only" | "reject";
  reasons: string[];
}

export function assessRefAudio(filePath: string): Promise<RefAudioQuality>;
```

**接线**：
- 库导入 / `setStatus(approved)` 时计算并落 `VoiceAsset` metadata。
- `voiceLibraryApproveGate.ts`：`recommendedUse=reject` 时**禁止** bind approved 或强制 design 回退。
- Ready/Patrol（H）纳入 ref 质量维度。

**范围约束**：推荐 5–15s、SNR 阈值、静音/削波阈值先给保守默认，可 env 调。**不**做完整声纹聚类（那是另立项）。

**验收**：好/坏样本各若干，阈值命中；approve gate 对 reject 样本拦截。

---

### P2 · 方言/口音维度（可选，看内容需求）

**问题**：地域角色（东北/粤语/川渝…）目前只能塞进 design 自由文案，不可测、不可路由。

**设计**（最小侵入）：
- `VoiceBrief` 增 `dialectHint?: string | null`（`voiceBriefService.ts:22`）；rule/LLM 两路都可产出。
- planner → design 文案模板注入方言提示（`audiobookVoicePlanner.ts`）。
- **不**上 CosyVoice 方言模型；先看 MiMo design 听感能否拉开。拉不开再考虑 P3 引擎。

**验收**：Manual 听感——同角色带/不带 dialectHint 的 design 试听对比。

**YAGNI 提醒**：若近期书无地域角色，**不做**。

---

### P3 · CosyVoice 作第二 TTS 引擎（可选，独立立项）

**仅在以下触发时才值得**：MiMo 持续 5xx/克隆崩、成本压力、或中文方言成为硬需求。

**设计**：运输层可插拔（复用 `audiobook-mimo-tts-multi-backend-plan.md` 的 transport 方向）。

```ts
export type TtsEngineId = "mimo" | "cosyvoice";

export interface TtsSynthesizeInput {
  engine: TtsEngineId;               // 缺省 mimo
  mode: "preset" | "design" | "clone";
  text: string;
  style?: string | null;
  designPrompt?: string | null;
  refAudioPath?: string | null;
  // …deliveryLine 已 compile 进 style/designPrompt
}

export interface TtsEngineAdapter {
  readonly id: TtsEngineId;
  synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult>;
}
```

**模态映射**：

| 我们 | CosyVoice client 模式 |
|---|---|
| preset | `sft`（固定 speaker id） |
| clone | `zero_shot`（+ prompt wav） |
| design | `instruct`（design 文案 → instruct 自然语言） |
| delivery style | instruct 情绪/语速字段 |

**接线**：`AudiobookPipelineService.ts:612` 的 `mimoChatAudioTTSProvider.synthesize(...)` 抽象为 `engineRegistry.get(engineId).synthesize(...)`。

**硬约束**：
- **GPU 或付费托管**：pxed 现网无 GPU；需评估 ModelScope/HF 托管或独立推理机。
- **段级缓存 fingerprint 必须含 `engineId`**，否则 mimo/cosy 混用脏缓存（现 fingerprint ≡ resolveChunk，需扩位）。
- **双轨质检**：两引擎产物质量门分开。
- drama TTS 与有声书注册表**分域**（与现 plan 一致）。

**先做侧车评测**再谈生产：同文同 ref，两引擎出对照 wav，只写评测报告，不进主链。这是低风险验证 CosyVoice 是否真优于 MiMo 的方式。

---

## 4. 明确不做（YAGNI）

1. **整仓替换 TTS 为 CosyVoice**：有声书合同/库审批/resynth/m4b 链路都绑 MiMo 行为。
2. **为流式重做任务状态机**：交付物是章 wav，不是实时会话。
3. **自训练/SFT 0.5B**：数据标注 + 运维成本远超当前产品阶段收益。
4. **Voice conversion 当配音主路径**：与多角色叙事合成不是同一问题。
5. **P3 直接上生产默认引擎**：必须先侧车评测 + 成本核算。

---

## 5. 开放问题（实现前需定）

1. **读音词典存储**：新 Prisma 表（`PronounceRule`，book/character 外键）vs 复用现有 JSON 字段（如角色卡/书设定的扩展 JSON）？
   - 新表：可查询/可运营台管理；改 schema + 迁移。
   - JSON：零迁移；但难批量运营、难去重。
   - **倾向**：全局 TN 用仓内常量；书/角色词典先 JSON，量大再升表。
2. **`annotate` 注音是否对 MiMo 有效**：需 1 次真机验证；无效则一期只做 `reading`。
3. **ref 质量分析依赖**：纯 Node（wav 解析 + 能量启发）vs 引 ffmpeg/轻量库？倾向纯 Node + 已有 `audiobookWav.ts` 复用。
4. **P3 托管形态**：ModelScope/HF Inference vs 自建推理机 vs 不做。需成本数据。

---

## 6. 落点速查（实现时对照）

| 借鉴块 | 主要文件 | 关键行/符号 |
|---|---|---|
| 读音/TN 收口 | `server/src/services/audiobook/audiobookChunk.ts` | `:102` `sanitizeTtsChunkText(raw)` |
| 新读音模块 | `server/src/services/audiobook/diarize/ttsPronounce.ts` | 新建 |
| 现有薄 sanitize | `server/src/services/audiobook/diarize/ttsTextSanitize.ts` | `sanitizeTtsChunkText` |
| instruct（已有） | `server/src/services/audiobook/deliveryStyle.ts` | `AudiobookSegmentDelivery` / `compileDeliveryLine` |
| clone ref 质量门 | `voiceLibraryApproveGate.ts` / `AudiobookVoiceAssetService.ts` | approve 链 + metadata |
| 方言字段 | `voiceBriefService.ts` | `VoiceBrief` `:22` |
| 引擎边界 | `server/src/services/audiobook/AudiobookPipelineService.ts` | `:612` `mimoChatAudioTTSProvider.synthesize` |
| 引擎类型 | `shared/types/audiobook.ts` | `AudiobookTtsMode` 附近 |
| schema | `server/src/prisma/schema.prisma` | 读音表（若走表）/ VoiceAsset metadata |

---

## 7. 结论

CosyVoice 值得借鉴的是它**把可控合成产品化的那几层**，而非模型本身。在我们**已有 instruct（段级表演）+ 音色库 + 通道 diarize** 的底座上，**读音词典 + TN（P0）** 是引擎无关、风险最低、对中文网文听感提升最直接的一块，应优先。clone ref 质量门（P1）贴现有库审批、增量小。方言（P2）看内容需求。真正接 CosyVoice 引擎（P3）成本最高，只建议以**侧车评测 / 克隆兜底**形态、独立立项推进，不冲击刚 live 的 diarize P0 主链。

每块都可独立走 spec → plan → 实现；本文档不锁定本轮实现范围。
