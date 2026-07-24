# 有声书合成链路分层重构设计（借鉴 CosyVoice frontend/model/API 三层）

> **类型**：架构重构 + 具体开发设计文档（引擎不换，借鉴分层骨架）
> **日期**：2026-07-24
> **借鉴对象**：[FunAudioLLM/CosyVoice](https://github.com/FunAudioLLM/CosyVoice) 的 `frontend / model / inference-API` 三层切分
> **引擎**：仍用现有 MiMo（小米 chat-audio / CPA），**不引入 CosyVoice 模型**
> **现状 tip**：`f4a6128`（diarize P0 live）
> **前置调研**：`audiobook-cosyvoice-borrowing-research.md`
> **相关 SoT**：`audiobook-segment-delivery-style-plan.md` · `audiobook-voice-library-ops-and-ai-plan.md` · `audiobook-channel-diarize-cast-plan.md` · `audiobook-mimo-tts-multi-backend-plan.md`

---

## 0. 一句话

CosyVoice 值得完整借鉴的是它的**层次纪律**：`frontend`（文本归一 + 按 mode 组装 model_input + 说话人条件缓存）→ `model.tts()`（统一入口、对 mode 无感）→ `inference API`（只做薄编排/计时/产出）。我们把同一套骨架搬到有声书链路：**引擎照旧用 MiMo，但把散落四处的文本处理、mode 决策、音色解析、引擎调用收拢成 4 个边界清晰、可单测、可扩引擎的层**，并顺手补上「缓存指纹含引擎身份」这个隐患。

**不是加功能，是把现有能力重新分层**，让代码可读、可维护、可扩第二引擎。

---

## 1. CosyVoice 的分层纪律（我们要借的骨架）

从 `cosyvoice/cli/cosyvoice.py` 提炼（引擎无关的**结构**）：

```
inference_sft/zero_shot/cross_lingual/instruct(...)   ← API 层：薄编排
   ├─ text_normalize(text)                            ← Frontend：文本归一
   ├─ frontend_{mode}(text, spk/prompt/instruct)      ← Frontend：按 mode 组装 model_input
   │     └─ 持有 spk2info（说话人条件缓存）
   └─ model.tts(**model_input, stream, speed)         ← Model：统一合成入口，对 mode 无感
```

**三条纪律**：

1. **mode 差异只活在 frontend**：`frontend_sft` vs `frontend_zero_shot` vs `frontend_instruct` 组装出**不同的 `model_input`**；`model.tts()` 只消费 `model_input`，完全不知道 mode。
2. **文本处理是一个独立层**：`text_normalize` 在 frontend 内，一处收口，所有 mode 共用。
3. **API 极薄**：只切分句子、循环、计时（RTF）、yield 音频。无业务逻辑内联。
4. **说话人条件被缓存**：`spk2info` / `add_zero_shot_spk` 把「音色→条件」解析成一次性可复用对象。

---

## 2. 我们的现状分层（as-built，诚实版）

（依据对 `server/src/services/audiobook/` 的实测调用图）

```
AudiobookTaskService.run
  → AudiobookPipelineService.run  ← 又胖又什么都管
      → annotateChapter            [文本处理①: delivery 编译 + 材料化]
      → reconcileAnnotationSegmentsWithVoices [音色解析②: 重绑 + delivery 再编译]
      → expandSegmentsToChunkJobs  [文本处理②: coalesce/split/sanitize]
      → chunkLayoutFingerprint     [缓存: 不含引擎身份]
      → resolveChunkSynthesizeFields [文本处理③: delivery 第三次触碰 / style·design SoT]
      → mimoChatAudioTTSProvider.synthesize [引擎: mode 分支泄漏在 buildMimoTtsRequestBody]
      → concat / gaps / m4b        [装配]
```

**六个结构问题**（不是 bug，是层次不清带来的债）：

| # | 问题 | 现在的位置 | 后果 |
|---|---|---|---|
| P-1 | **无单一「前端层」**：文本处理散在 annotate / expand / resolveChunkSynthesizeFields 三处 | `AudiobookAnnotationService` + `audiobookChunk.ts` + `deliveryStyle.ts` | 读音/TN 无处安放；改一处要追三处 |
| P-2 | **delivery 编译多次**：annotate 一次、reconcile 一次、resolveChunkSynthesizeFields 又一次 | `deliveryStyle.ts:314/427` × 多调用点 | 重复计算 + 「以哪次为准」的隐式约定 |
| P-3 | **mode 逻辑泄漏进引擎**：preset/design/clone 分支在 `buildMimoTtsRequestBody` | `MimoChatAudioTTSProvider.ts:364` | 换/加引擎要在传输层重抄 mode 语义 |
| P-4 | **无引擎抽象**：`mimoChatAudioTTSProvider` 被 3 处直接调用 | pipeline `:612`、VoiceAssetService `:1102/:1251` | 第二引擎无插入点；drama 有 port 但没接过来 |
| P-5 | **缓存指纹不含引擎身份**：fingerprint 无 engineId/model/endpoint | `chunkLayoutFingerprint` `:427` | 换 model/env 不失效；未来双引擎必脏缓存 |
| P-6 | **音色解析分散**：planner / materialize / reconcile / resolve 四处决定 mode 与参数 | 4 文件 | 优先级是隐式口头约定，无单一「spk2info」 |

---

## 3. 目标分层（把 CosyVoice 骨架搬进来）

四层，边界即契约。**引擎照旧 MiMo**，只是被收进 L3 的一个 adapter。

```
┌─ L4 Orchestration ── AudiobookPipelineService（瘦身后，= CosyVoice inference API）
│    循环 chunk · retry · gaps · concat · m4b · 计时/质量告警。无文本/音色/mode 逻辑内联。
│
├─ L1 Frontend ── audiobook/frontend/   （= CosyVoice frontend）
│    TextNormalizer  : TN + 读音词典（正文不动，只改合成文本）
│    Chunker         : coalesce / split / sanitize（收编现 audiobookChunk）
│    SynthesisBuilder: 按 mode 组装 SynthesisRequest（= frontend_{mode} → model_input）
│                      delivery 在这里编译「一次」
│
├─ L2 Voice ── audiobook/voice/          （= CosyVoice spk2info）
│    VoiceResolver   : 当前角色卡 → 冻结的 VoiceProfile（一次解析，供 L1 消费）
│    （planner / library / brief 作为「离线 spk 注册表」保留不动）
│
└─ L3 Engine ── audiobook/engine/        （= CosyVoice model.tts）
     TtsEngine(port) : synthesize(SynthesisRequest) → wav；对 mode「几乎」无感
     MimoTtsEngine   : 把 SynthesisRequest 映射成 MiMo body（mode→model 映射内化于此）
     engineRegistry  : engineId → engine；fingerprintKey() 进缓存
```

**数据在层间只流一个对象**：`VoiceProfile`（L2→L1）与 `SynthesisRequest`（L1→L3）。这两个契约是重构的核心。

---

## 4. 两个核心契约（层间只传这两个对象）

### 4.1 `VoiceProfile`（L2 → L1）= 冻结后的说话人条件（借 spk2info）

一个段落的「说话人 → 音色」一旦解析，就冻结成不可变对象，L1/L3 只读不改。**取代**现在 planner/materialize/reconcile/resolve 四处各自摸 `segment.ttsMode/voice/refAudioPath` 的隐式约定。

```ts
// server/src/services/audiobook/voice/voiceProfile.ts
export interface VoiceProfile {
  /** 稳定 speaker key（用于合并/缓存/日志） */
  speakerKey: string;
  mode: AudiobookTtsMode;              // preset | design | clone
  /** preset：预置名；clone：可空（走 ref） */
  voice: string | null;
  /** clone：已 sandbox 校验的可读 ref 路径；其余 null */
  refAudioPath: string | null;
  /** 音色底稿（未叠 delivery）：preset/clone 的 style、design 的 designPrompt */
  baseStyle: string | null;
  baseDesignPrompt: string | null;
  /** 审计来源：card | guest | narrator | library */
  source: "card" | "guest" | "narrator" | "library";
}
```

`VoiceResolver` = 现有 planner/library/brief 的**读侧**门面（离线注册表保留不动）：

```ts
// server/src/services/audiobook/voice/voiceResolver.ts
export interface VoiceResolver {
  /** 段落 speakerName + 当前角色卡 → 冻结 profile。优先级在此「一处」定义。 */
  resolve(speakerName: string | null, ctx: VoiceResolveContext): VoiceProfile;
}
// 优先级（收编现 reconcile/materialize 的隐式规则，显式化）：
//   已有完整 clone(ref/assetId) > 角色卡 mode > guest 预置 > narrator 兜底
```

### 4.2 `SynthesisRequest`（L1 → L3）= 引擎无关的 model_input（借 frontend_{mode}）

L1 的 `SynthesisBuilder` 把 `VoiceProfile + 文本 + delivery` 组装成它。**mode 差异在这里定型**（就像 `frontend_sft` vs `frontend_zero_shot` 产出不同 model_input），L3 引擎只消费它。

```ts
// server/src/services/audiobook/frontend/synthesisRequest.ts
export interface SynthesisRequest {
  mode: AudiobookTtsMode;
  /** 已 TN + 读音 + sanitize 的最终合成文本（assistant 内容） */
  text: string;
  /** 已叠加 delivery 的最终条件（不再二次编译）： */
  style: string | null;          // preset/clone 用
  designPrompt: string | null;   // design 用
  voice: string | null;          // preset 预置名
  refAudioPath: string | null;   // clone 参考
  /** 缓存/日志用：不进引擎请求体 */
  speakerKey: string;
  deliveryFingerprint: string | null;
}
```

**关键收敛**：delivery **只在 `SynthesisBuilder` 编译一次**（消灭 P-2）。`resolveChunkSynthesizeFields` 的「剥离已编译标记再重编译」的绕路整个删除——因为不再有多处编译，也就无标记可剥。

---

## 5. L3 引擎层：把 MiMo 收进 adapter（消灭 P-3/P-4）

CosyVoice 的 `model.tts(**model_input)` 对 mode 无感；我们对齐：

```ts
// server/src/services/audiobook/engine/ttsEngine.ts
export type TtsEngineId = "mimo";           // 未来 | "cosyvoice"
export interface TtsSynthesizeResult { audio: Buffer; format: "wav" | "mp3"; sampleRate: number; }

export interface TtsEngine {
  readonly id: TtsEngineId;
  /** 进缓存指纹的引擎身份（含 model 版本），消灭 P-5 */
  fingerprintKey(req: SynthesisRequest): string;
  synthesize(req: SynthesisRequest, opts: { signal?: AbortSignal }): Promise<TtsSynthesizeResult>;
}

// server/src/services/audiobook/engine/mimoTtsEngine.ts
// = 现 MimoChatAudioTTSProvider 收进来；mode→model 映射（preset→mimo-v2.5-tts，
//   design→…voicedesign，clone→…voiceclone）从 buildMimoTtsRequestBody 内化到此 adapter。
export class MimoTtsEngine implements TtsEngine { readonly id = "mimo"; /* … */ }

// server/src/services/audiobook/engine/engineRegistry.ts
export function getEngine(id: TtsEngineId = "mimo"): TtsEngine;
```

- `AudiobookPipelineService`、`AudiobookVoiceAssetService`（预览）三处直连改为 `getEngine(id).synthesize(req)`。
- **drama 的 `TTSProviderPort`** 与本 port 保持**分域**（请求形状不同，不强并）；仅在文档标注「若将来统一，此处是并点」。
- 第二引擎（CosyVoice 侧车）= 新增一个 `implements TtsEngine`，**零改 L1/L2/L4**。这就是分层的红利。

---

## 6. 缓存指纹补引擎身份（消灭 P-5）

`chunkLayoutFingerprint`（`AudiobookPipelineService.ts:427`）现哈希：speakerKey / ttsMode / voice / refAudioPath / style·design SoT / text。**新增** `engine.fingerprintKey(req)`（含 engineId + model 版本）。

- 效果：换 model 或换引擎 → 指纹变 → 章级 skip 正确失效。
- 兼容：一次性指纹版本号 bump（`chunk-layout.sha1` 加前缀 `v2:`），旧缓存自然 miss 重合成一次，无需手动清。
- **风险**：全量 book 会触发一次重合成。落地时用 env 开关 `AUDIOBOOK_FP_V2` 灰度，确认无回归再默认开。

---

## 7. 迁移策略（行为不变、可分批、每步可回滚）

**总纲：先抽契约与层，再逐步把逻辑「搬家」，语义零改动**。每步独立可 ship、可单测、有 golden 对照。

| 步 | 内容 | 验证门 | 回滚 |
|---|---|---|---|
| M1 | 新建 `frontend/ voice/ engine/` 目录 + 契约类型（`VoiceProfile`/`SynthesisRequest`/`TtsEngine`），无接线 | 编译通过；类型单测 | 删目录 |
| M2 | `MimoTtsEngine` 包住现 provider（**逐字转发**，mode 映射内化）；`getEngine` 返回它；三处直连改走 registry | golden：同输入 body 逐字节等价 | 直连回退 |
| M3 | `SynthesisBuilder` 收编 `resolveChunkSynthesizeFields` + delivery 编译（**一次**） | golden：SynthesisRequest.style/design 与旧 SoT 逐字段等价 | 保留旧函数并行跑对比 |
| M4 | `Chunker` 收编 `audiobookChunk`（coalesce/split/**sanitize**）；`TextNormalizer` 建**空壳**（先只透传，为读音/TN 留位） | golden：chunk 文本 + fingerprint 不变 | 旧 `audiobookChunk` 留存 |
| M5 | `VoiceResolver` 收编 reconcile/materialize 的绑定优先级，产出 `VoiceProfile` | golden：每段 mode/voice/ref 与旧绑定一致 | 旧 reconcile 留存 |
| M6 | 指纹加 `engine.fingerprintKey`（env 灰度 `AUDIOBOOK_FP_V2`） | 一本书重合成，wav 时长/段数一致 | env 关 |
| M7 | 瘦身 `AudiobookPipelineService.run` 为纯编排（删已搬走的内联逻辑） | 全链 e2e：源世界 ch1 前后 wav 对照 | git revert |

**golden 对照法**：M2–M5 每步在改造函数旁临时保留旧函数，跑 assert「新旧输出等价」，绿了再删旧的。这是把「行为不变」变成可测断言，而不是口头保证。

**与 diarize P0 主链的关系**：本重构**不碰** L0 diarize / annotate 的 LLM 语义与通道规则（`renderPolicy`/`overlayChannelSkips`/`channelRepair` 原样），只重排 annotate **之后** 的合成侧。刚 live 的 `f4a6128` 行为不受影响。

---

## 8. 重构后能自然接住的东西（红利，非本轮实现）

分层到位后，这些从「要动多处」变成「加一层里的一块」：

- **读音词典 + TN**：只往 `TextNormalizer` 里填规则，一处收口（对照调研文档 P0）。
- **第二引擎（CosyVoice 侧车）**：新增一个 `implements TtsEngine`，L1/L2/L4 零改。
- **clone ref 质量门**：挂在 `VoiceResolver`（source=library 分支）。
- **方言字段**：`VoiceProfile` 加 `dialectHint`，`SynthesisBuilder` 注入 design 文案。

即：**这份重构是上一份调研里 P0–P3 的公共地基**。先铺地基，后续每块借鉴都变轻。

---

## 9. 明确不做（YAGNI / 防范围蔓延）

1. **不换引擎**：MiMo 仍是唯一 live 引擎；CosyVoice 只是「未来可 implements 的位」。
2. **不碰 diarize/annotate LLM 语义**：通道模型、rules、narrator 兜底原样。
3. **不改正文落库**：TextNormalizer 只作用于合成文本。
4. **不合并 drama TTS port**：分域，仅标注并点。
5. **不做流式**：仍离线章 wav / m4b 交付。
6. **不追求一次性大改**：M1–M7 分批，每步 golden 可回滚；禁止「重写式」重构。

---

## 10. 开放问题（落地前需定）

1. **golden 对照保留多久**：M2–M5 的新旧并行断言，是留到全绿一次性删，还是留一个 release 周期？倾向「全绿即删」，避免死代码。
2. **`AUDIOBOOK_FP_V2` 灰度范围**：先在单本书验证，还是直接全量？倾向单本（源世界）验证。
3. **`VoiceResolver` 与 planner 的边界**：planner 是「写侧」（决定角色卡），resolver 是「读侧」（消费角色卡）。确认不把 planner 逻辑误搬进 resolver。
4. **目录命名**：`frontend/voice/engine` vs 现有扁平布局。倾向新建子目录，老文件逐步 re-export 迁入，避免一次性 move 破坏 import 图。

---

## 11. 落点速查（实现时对照）

| 层 | 新建/收编 | 现有来源 | 关键行 |
|---|---|---|---|
| L4 编排 | 瘦身 `AudiobookPipelineService.run` | 同文件 | `:655–1107`（同步 synth 调用 `:922`） |
| L1 TextNormalizer | `frontend/textNormalizer.ts`（新，先透传） | 为读音/TN 预留 | — |
| L1 Chunker | `frontend/chunker.ts` | `audiobookChunk.ts`（`:102` sanitize） | `:73/:102` |
| L1 SynthesisBuilder | `frontend/synthesisBuilder.ts` | `resolveChunkSynthesizeFields` + `deliveryStyle` | pipeline `:464`、delivery `:314/:427` |
| L1 sanitize | 收编入 Chunker | `diarize/ttsTextSanitize.ts` | `:15` |
| L2 VoiceProfile | `voice/voiceProfile.ts`（新） | — | — |
| L2 VoiceResolver | `voice/voiceResolver.ts` | `reconcileAnnotationSegmentsWithVoices` + `materializeAnnotationSegments` + guest | pipeline `:147/:806`、annotate `:333`、`diarize/guestVoice.ts` |
| L3 TtsEngine port | `engine/ttsEngine.ts`（新） | — | — |
| L3 MimoTtsEngine | `engine/mimoTtsEngine.ts` | `MimoChatAudioTTSProvider.ts`（mode 映射 `:364`） | `:364–465` |
| L3 registry | `engine/engineRegistry.ts`（新） | 3 处直连 | pipeline `:612`、VoiceAsset `:1102/:1251` |
| 缓存指纹 | 加 `engine.fingerprintKey` | `chunkLayoutFingerprint` | `:427` |
| 类型 | `AudiobookTtsMode`/models | `shared/types/audiobook.ts` | `:172–180` |

---

## 12. 结论

我们要从 CosyVoice 借的，是它**把可控合成切成 frontend/model/API 三层**的纪律，而不是它的模型。把这套骨架搬进有声书链路后：

- **文本处理**收拢到 L1 一层（读音/TN 从此有家）；
- **mode 决策**只活在 L1 SynthesisBuilder（引擎对 mode 无感）；
- **音色解析**冻结成 L2 `VoiceProfile`（消灭四处隐式约定）；
- **引擎**收进 L3 adapter + registry（第二引擎零改上层）；
- 顺手补齐**缓存指纹含引擎身份**这个既有隐患。

迁移全程 **golden 对照、分批可回滚、语义零改**，且**不触碰刚 live 的 diarize P0 主链**。这既让当前代码更可维护，也成为后续所有 CosyVoice 借鉴块的公共地基。

> 本文档为架构设计，落地按 §7 的 M1–M7 分批走 spec/实现；本轮不锁定起步步骤，待你决策。

