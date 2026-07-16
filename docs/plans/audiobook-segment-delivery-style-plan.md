# 有声书 · 段级语境表演（Delivery Style）开发计划

> 状态：设计稿 · 2026-07-16 · **R2 修订（深度 review 后）**  
> 范围：角色对白（及可选旁白）在 **合成前** 根据上下文分析情绪与表演因素，生成 **可注入 MiMo `user`/style 通道** 的提示词。  
> 产品 SoT：`[[ainovel 小说转有声书 产品形态]]` · 协议 SoT：`[[ainovel 小说转有声书 TTS 经验]]` · 生产 tip 以运维手册为准。  
> 本计划 **只定义实现边界**；未获准前不改生产合成默认路径。  
> Review 结论已吸收：指纹 / 失败隔离 / Core 字段 / design 契约 / 合并桶 / deliveryLine 校验 / roster 声线 / 存储 / 听感门禁。

---

## 1. 一句话目标

在现有「按章 LLM 标 speaker → 段绑定角色音色 → MiMo 合成」链路上，增加 **段级语境表演**：

1. **上下文分析**：角色开口时，从前后文抽出情绪、强度、场景与有助于声音表现的因素。  
2. **提示词生成**：把分析结果编译成 **自然语言 delivery style**，与角色卡静态 `ttsStyle` 合成后注入 MiMo `messages[user]`，让听感随剧情变化、身临其境。

**质量目标**：提示词必须达到「角色骨架加深字段」同级——固定键名、分层不撞车、可执行、可校验；禁止单词 emotion 或空话。

---

## 2. 调研摘要（外部 · 非实现 SoT）

> 本节为调研维度，**实现契约以 §5 为准**。

### 2.1 业界/论文主结论

| 来源 | 要点 | 对本项目含义 |
|---|---|---|
| **DeepDubbing / CA-Instruct-TTS**（arXiv 2509.15845） | 多角色有声书 = 脚本分析 + 音色 + Context-Aware Instruct-TTS | 已有 speaker + 音色；缺 **上下文指令** 层 |
| **TACA-TTS 等** | 文本+语境 style，长文韵律 | 表演应吃前后文 |
| **Gemini-TTS** | 自然语言 prompt 控风格/情绪；标签增强 | **控制面 = 自然语言 instruction** |
| **中文实践** | 描述性 style 句 | 与 MiMo `user=style` 同构 |
| **共识** | 多维 > 单词情绪；强度；连续性 | 结构化 → compile；禁止只吐「悲伤」 |

### 2.2 控制分层

```text
L0 音色身份（稳定）     Character.ttsMode/voice/design/clone + 基线 ttsStyle
L1 场景/导演备注（章）  氛围、整体节奏 —— 本里程碑不实现，见 backlog
L2 行级表演（每段）     Core + Extended 加深字段
L3 合成注入             MiMo user instruction（preset/clone=style；design=designPrompt）
```

### 2.3 调研维度 → 实现字段映射

| 调研维度 | 实现字段（§5） |
|---|---|
| 主情绪/强度 | `primaryEmotion` + `intensity` |
| 次级表演/面具 | `surfaceTone` · `maskOrLeak` · `secondaryTraits` |
| 气声/音量/语速/停顿 | `vocalEffort` · `rate` · `pitchMove` · `pauseBreath` · `articulation` |
| 场景/对象/潜台词 | `sceneSpace` · `scenePressure` · `addresseeRelation` · `intent` · `subtext` |
| 连续性 | `continuityFrom`（+ 服务端后处理） |
| 成稿注入 | `deliveryLine` → compile → user |

**反模式**：单词 emotion；整段上下文塞进 user；SSML 主路径；忽略基线声线；每句推倒身份。

---

## 3. 本地现状对照（差距 · 含现网硬事实）

### 3.1 已具备

| 能力 | 位置 | 说明 |
|---|---|---|
| 章级 speaker 标注 | `AudiobookAnnotationService` + `audiobookChapterAnnotate.prompts` | 只产出 `speakerKind/speakerName/text` |
| 段 → 角色音色绑定 | 标注后 `resolveCharacter` | style/design 来自角色卡 |
| 静态 style 规划 | `audiobookVoicePlanner.buildStyle` | voiceTexture / personality；**非语境** |
| 合成注入 | `MimoChatAudioTTSProvider.buildMimoTtsRequestBody` | preset/clone：`user=style`；**design：`user=designPrompt`（有 design 时忽略 style）** |
| 段合并 | `canMergeSegments` | speaker + ttsMode + voice + **style** + designPrompt + ref 全等 |
| 语义静音 | `AUDIOBOOK_GAP_MS` | 旁白↔角色 / 角色↔角色 |
| 固定试听 / readiness | 另计划 | 基线音色；**不**替代段级表演 |
| 章内容截断 | annotate `content.slice(0, 28_000)` | 长章尾部不可见 |
| 标注失败 | `buildNarratorOnlyAnnotation` | **整章旁白**（与表演失败隔离必须分开） |

### 3.2 明确缺口

| 缺口 | 现状 | 影响 |
|---|---|---|
| 段级 delivery | 无 | 同角色全章同一 style，听感扁平 |
| 标注 prompt | 只切 speaker | 模型不算语境表演 |
| style 合成 | `matched.ttsStyle` 直填 | 无「基线 + 本句」 |
| roster | 基本只有角色名 | 无 voiceTexture/ttsStyle 摘要，难出高质声道 |
| **layout fingerprint** | **不含 style/designPrompt** | 只改表演会 **resume 复用旧 WAV**（P1 必改） |
| design user | 只用 designPrompt | 只改 `segment.style` **进不了** design 合成 |
| 可观测 | annotations 无表演审计 | 难 debug |

### 3.3 协议硬约束（不可破）

1. 禁止 `/v1/audio/speech`；仅 chat-audio。  
2. preset/clone：表演主通道 = **`user` = style**；正文 = assistant。  
3. design：表演必须进 **`user` = designPrompt 文案**（音色段 + 表演指令）；**禁止**另开未验证字段。  
4. readiness / 固定试听 **只用角色基线**，禁止段级高潮 style。  
5. chunk ≤ ~550 字；最终 user ≤ **280** 字。  
6. **合成入口唯一**：`resolveSynthesizeInput(segment)` → `{ style?, designPrompt? }`；Pipeline 禁止自猜。

---

## 4. 产品决策（冻结 · R2）

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 控制目标 | 段级 delivery；**不改** 音色 id | 身份稳定、表演可变 |
| D2 | 分析时机 | **同一次 annotate 产出 optional delivery**（单 pass A） | 少一次 LLM；质量不稳再升双 pass（backlog） |
| D3 | 注入方式 | 唯一 `resolveSynthesizeInput`：preset/clone→`style`；design→合并后的 `designPrompt` | 对齐现网 MiMo 分支 |
| D4 | 旁白 | mode=`characters` 时旁白 **无** delivery；`all` 时轻量 | 成本 |
| D5 | 正文标签 | 默认不写 assistant；实验开关 backlog | 不污染 text/指纹 |
| D6 | 失败策略 | **delivery 失败只剥表演**；speaker 段保留 + 静态 style；**禁止**因 delivery 整章旁白 | 与现网 annotate 总失败旁白区分 |
| D7 | 合并策略 | 使用 **`deliveryMergeKey` 桶**，不用全文 deliveryLine 相等 | 防 chunk 爆炸 |
| D8 | 连续性 | `continuityFrom` + 服务端按 characterId 补缺 | 防闪烁 |
| D9 | 范围 | 仅有声书任务；不进写作主链 / Drama | BC |
| D10 | 开关 | `deliveryStyleMode: off \| characters \| all` | **代码/产品默认 = `off`**；听测通过后改 `characters` |
| D11 | 指纹 | **layout fingerprint 必须含 style + designPrompt** | resume 正确性硬门禁 |
| D12 | 字段分层 | LLM 只出 **Core（必填倾向）+ Extended（可空）**；`stabilityGuard` **服务端常量** | 降 schema 失败率 |
| D13 | deliveryLine | 校验通过才用模型句，否则字段 compile | 质量门 |
| D14 | 存储 | 章文件为 annotations SoT；控制 DB `annotationsJson` 膨胀 | 长书 |
| D15 | 重处理 | `reannotate`：清标注+音频+指纹；`resynthesize`：沿用已存 delivery/style 重合成 | 语义清晰 |

**默认值统一（废除「默认 characters / 可先 off」双说）**：

```text
代码默认 deliveryStyleMode = off
产品目标（听测后）     = characters
env 可覆盖默认         = AUDIOBOOK_DELIVERY_STYLE_MODE
createTask 可显式覆盖
```

---

## 5. 目标架构

```text
章节正文 + 角色 roster（名|别名|声线摘要|性格一句）
   │
   ▼
┌────────────────────────────────────────┐
│ Annotate LLM（speaker 必填；delivery 可选）│
└────────────────┬───────────────────────┘
                 │ normalizeDelivery（非法→null，不剥 speaker）
                 │ baseStyle = 角色 ttsStyle / voiceTexture 规划
                 │ deliveryLine = validate? model : compileDeliveryLine
                 │ style / designPrompt = resolveSynthesizeInput
                 │ deliveryMergeKey = 桶
                 ▼
          coalesce（mergeKey + 音色字段）
                 │
                 ▼
     chunkLayoutFingerprint(… + style + designPrompt …)
                 │
                 ▼
     MiMo synthesize(resolve 结果)
```

### 5.1 字段体系：Core / Extended + 加深质量条

对齐 `character.base.skeleton` / `visible_profile` 的 **质量纪律**，但 **不** 把离线 30+ 字段原样搬进每段高 QPS 标注。

#### 5.1.0 本地先例

| 先例 | 用法 |
|---|---|
| 角色骨架分层不撞车 | Core 情绪核 ≠ 表面语气 ≠ 声道旋钮 |
| 角色 final 成稿整合 | `compileDeliveryLine` / `resolveSynthesizeInput` |
| voiceTexture 禁空话 | baseStyle 稳定；段级禁止改性别/年龄/声线身份 |
| MiMo context 文风 | user 必须可执行，不是影评 |

#### 5.1.1 两层

```text
L0 稳定：ttsStyle / voiceTexture / ttsDesignPrompt → baseStyle / baseDesignPrompt
L2 段级：Core + Extended → delivery → 合成用 style 或 designPrompt
```

#### 5.1.2 Core 字段（LLM 应填；缺省可服务端默认）

| 字段 | 类型 | 规则 | 正例 | 反例 |
|---|---|---|---|---|
| `primaryEmotion` | string ≤24 | 单一情绪核，可修饰 | 压抑愤怒 | 复杂/到位 |
| `intensity` | low\|mid\|high | 默认 mid；非高潮勿 high | mid | 无依据全程 high |
| `surfaceTone` | string ≤32 | 第一耳语气；**≠** primaryEmotion | 平静公事 | 与主情绪同义 |
| `intent` | string ≤40 | 交际意图 | 逼对方承认甩锅 | 表达情绪 |
| `vocalEffort` | whisper\|soft\|normal\|raised\|strained | 发声力度 | soft | 空话 |
| `rate` | slow\|measured\|normal\|fast\|rushed | 语速 | measured | 无依据 rushed |

#### 5.1.3 Extended 字段（全 optional）

| 字段 | 类型 | 规则 |
|---|---|---|
| `maskOrLeak` | string ≤32 | 面具/破绽 |
| `secondaryTraits` | string[] ≤3 | 不与主情绪撞车 |
| `addresseeRelation` | string ≤24 | 对谁说 |
| `subtext` | string ≤40 | 口是心非时建议填 |
| `sceneSpace` | string ≤32 | 物理空间 |
| `scenePressure` | string ≤32 | 局势；≠ sceneSpace 同义 |
| `pitchMove` | lowered\|stable\|lifted\|cracked | 音高走势 |
| `pauseBreath` | string ≤32 | 停顿/气口 |
| `articulation` | string ≤32 | 咬字 |
| `nonverbalCue` | string ≤24 | 描述性轻哼/冷笑；禁 BGM |
| `continuityFrom` | string ≤40 | 承接上句；空则服务端补 |
| `rawFactors` | string[] ≤6 | 调试证据短语 |
| `deliveryLine` | string ≤120 | 模型成稿句；须过校验 |

**服务端注入（不进 LLM schema）**：

```text
STABILITY_GUARD =
  "保持该角色声线与身份一致，吐字清楚，不要模仿旁白腔，不要唱歌，不要串戏到其他角色。"
```

#### 5.1.4 TypeScript 契约

```ts
type DeliveryIntensity = "low" | "mid" | "high";
type DeliveryVocalEffort = "whisper" | "soft" | "normal" | "raised" | "strained";
type DeliveryRate = "slow" | "measured" | "normal" | "fast" | "rushed";
type DeliveryPitchMove = "lowered" | "stable" | "lifted" | "cracked";
type DeliveryStyleMode = "off" | "characters" | "all";

interface AudiobookSegmentDelivery {
  // Core
  primaryEmotion: string;
  intensity: DeliveryIntensity;
  surfaceTone: string;
  intent: string;
  vocalEffort: DeliveryVocalEffort;
  rate: DeliveryRate;
  // Extended
  maskOrLeak?: string | null;
  secondaryTraits?: string[];
  addresseeRelation?: string | null;
  subtext?: string | null;
  sceneSpace?: string | null;
  scenePressure?: string | null;
  pitchMove?: DeliveryPitchMove | null;
  pauseBreath?: string | null;
  articulation?: string | null;
  nonverbalCue?: string | null;
  continuityFrom?: string | null;
  rawFactors?: string[];
  deliveryLine?: string | null;
}

interface AudiobookDialogueSegment {
  // 既有：index, speakerKind, characterId, speakerLabel, text,
  //       ttsMode, voice, style?, designPrompt?, refAudioPath?
  /** 角色卡/旁白基线 style（审计；preset 合成前参与 compile） */
  baseStyle?: string | null;
  /** design 模式：角色卡原始 design（审计；合成时与表演合并） */
  baseDesignPrompt?: string | null;
  /** 结构化表演；null = 无表演或已剥除 */
  delivery?: AudiobookSegmentDelivery | null;
  /**
   * 合并桶：emotion族|intensity|vocalEffort|rate
   * canMerge 用此字段（及音色字段），不用全文 style 字符串
   */
  deliveryMergeKey?: string | null;
  /** preset/clone：最终 user style；design：可为 null（走 designPrompt） */
  style?: string | null;
  /** design：最终 user = 音色 + 表演；preset/clone：保持卡上原值或 null */
  designPrompt?: string | null;
}
```

**兼容**：无 `delivery` → 行为与现网一致（静态 ttsStyle / designPrompt）。

#### 5.1.5 字段分层（禁止撞车）

```text
primaryEmotion  心里是什么
surfaceTone     嘴上怎么端着
maskOrLeak      演得住 / 露馅
intent/subtext  为什么说 / 没说出口的
scene*          物理与局势
vocal*/rate/... 声道旋钮
continuityFrom  时间轴
deliveryLine    成稿表演句（类 final personality）
```

### 5.2 归一化、校验与编译（纯函数 SoT）

```ts
/** 非法/空 → null；永不抛到整章旁白 */
normalizeDelivery(raw: unknown): AudiobookSegmentDelivery | null

/** 模型 deliveryLine 是否采用 */
validateDeliveryLine(d: AudiobookSegmentDelivery, spokenText: string): boolean
// 通过条件（全部）：
// - 长度 12–120
// - 不含空话词表：有感情|生动|自然|请朗读|情绪到位|丰富|很好地…
// - 不含与 spokenText 连续 ≥8 字的复述
// - 与 primaryEmotion 弱相关（子串或同义表命中）
// - 至少体现 1 个声道线索（effort/rate/pitch/pause 词）或 surfaceTone
// 失败 → 丢弃模型句，走 compileDeliveryLine

compileDeliveryLine(d: AudiobookSegmentDelivery): string
// 骨架：
// {surfaceTone}地，{primaryEmotion}（{intensity}）{；maskOrLeak}。
// 意图：{intent}。{subtext}。
// {effort词}，语速{rate词}{，pitch}{，pause}{，articulation}。
// {scene}。{addressee}。{continuity}。{nonverbal}
// 硬截断 120；禁复述台词

deliveryMergeKey(d: AudiobookSegmentDelivery | null): string
// null → "none"
// 否则 `${emotionFamily(primaryEmotion)}|${intensity}|${vocalEffort}|${rate}`
// emotionFamily：压抑愤怒/怒 → anger；惧/慌 → fear；… 未知 → other

resolveSynthesizeInput(segment): {
  style?: string | null;
  designPrompt?: string | null;
}
// preset/clone:
//   style = clip(baseStyle,120) + "\n本句表演：" + line + "\n" + STABILITY_GUARD
//   总长 ≤280；base 优先保留
//   designPrompt 透传角色卡原值（不把表演写进去）
// design:
//   designPrompt = baseDesignPrompt + "\n\n表演指令：" + line + "\n" + STABILITY_GUARD
//   style 可保留 baseStyle 供审计，但合成以 designPrompt 为准
// mode=off 或 delivery=null:
//   返回静态 baseStyle / baseDesignPrompt（现网行为）
```

**过戏抑制（compile 硬规则）**：

- intensity≠high 时删除「嘶吼/哭喊/崩溃」类词  
- secondaryTraits 与 primaryEmotion 同义则丢弃 traits  
- user 最终再跑一次空话/过戏词表 strip  

### 5.3 标注 Prompt（v2）

**Schema 原则（硬）**：

```ts
// speaker 字段保持现网必填语义
// delivery：z.object({...}).partial().optional().nullable()
// 或独立 catch：解析失败 → delivery=null，segment 仍有效
// Core 在 normalize 阶段补默认，而不是 zod 全部 required
```

**禁止**：把 18 字段全部 `required` 导致 structured 整包失败 → 现网 `buildNarratorOnlyAnnotation`。

**输入增强（roster 行格式）**：

```text
- 何屿 | 别名:小何 | 声线:内敛偏低、吐字清 | 风格:克制 | 性格:敏感要强
```

来源：`voiceTexture` / `ttsStyle` / `personality` 各截断；无则「声线:未设定」。

**输出示例（角色段）**：

```json
{
  "speakerKind": "character",
  "speakerName": "何屿",
  "text": "……",
  "delivery": {
    "primaryEmotion": "压抑愤怒",
    "intensity": "mid",
    "surfaceTone": "平静公事",
    "intent": "逼对方把责任说清楚",
    "vocalEffort": "soft",
    "rate": "measured",
    "maskOrLeak": "强装镇定，牙关发紧",
    "subtext": "表面问流程，其实拒再背锅",
    "sceneSpace": "狭小出租屋夜谈",
    "scenePressure": "一对一逼问",
    "addresseeRelation": "对甩锅上级",
    "continuityFrom": "承接对方冷笑，怒意未消",
    "rawFactors": ["被甩锅", "领导冷笑", "夜"],
    "deliveryLine": "平静公事地压着怒，强装镇定却牙关发紧；对上级逼问责任；压低音量、语速沉稳、句中短暂停再接。"
  }
}
```

**系统规则**：

1. 先 speaker，后 delivery；禁止因情绪改写 narrator/character 边界。  
2. 只根据正文邻域 + roster 声线；禁止编造未写剧情。  
3. Core 尽量填；Extended 有依据才填。  
4. 字段分层不撞车；声道可执行；禁空话。  
5. deliveryLine 可省略（服务端 compile）。  
6. 相邻同角色：continuityFrom 建议填。  
7. mode 语义由服务端决定是否请求/是否丢弃 delivery（prompt 可说明「请尽量输出 delivery」）。  
8. 不把 stage direction 写进 text。

### 5.4 上下文窗

| 方案 | 做法 | 本里程碑 |
|---|---|---|
| **A. 单次全章** | 仍 28k 截断；+ roster 声线 | **P0** |
| B. 双 pass | speaker → delivery | backlog（schema 失败率或听感不稳时升） |
| C. 滑窗 | 长书 | backlog |

**风险写明**：28k 外正文无 delivery 依据；截断尾部 delivery 可信度下降 → 指标观察，不假装无损。

### 5.5 合并 · 指纹 · resume · 重处理

#### 合并（D7）

```ts
canMergeSegments:
  speakerKey 相同
  && ttsMode/voice/refAudioPath 相同
  && (deliveryMergeKey 相同)   // 替代「style 字符串全等」作为表演维度
  // 注意：合并后 chunk 的 style/designPrompt 取 **段首** segment 的 resolve 结果
  // （同桶听感应接近；避免拼接多段不同 line）
```

**成本护栏**：

- 章级日志：`chunkCount`、`characterChunkCount`、`deliveryFallbackRate`  
- 告警阈值（软）：同章角色 chunk > 基线 off 的 3× 时打 warn（不阻断）

#### 指纹（D11 · 硬门禁）

```ts
chunkLayoutFingerprint 必须 update：
  speakerKey, ttsMode, voice,
  style ?? "", designPrompt ?? "",
  text.length, text.slice(0, 64)
// 与现网比：新增 style + designPrompt
// 变更后：旧 chunk-layout.sha1 不匹配 → 丢弃旧 chunk 重合成
```

#### 重处理（D15）

| mode | 行为 |
|---|---|
| `reannotate` | 删该章 annotations 落盘 + 清章音频 + 清指纹；resume 重标（含 delivery）并重合成 |
| `resynthesize` | **保留** annotations 内 delivery/style；清音频+指纹后按已有 style 重合成 |
| mode 从 off→characters | 需 **reannotate** 才有 delivery；仅 resynthesize 不够 |

### 5.6 存储（D14）

| 位置 | 内容 |
|---|---|
| 磁盘 `annotations/{chapterId}.json` | **SoT**：完整 segments（含 delivery / base* / mergeKey / style / designPrompt） |
| DB `annotationsJson` | 可存全文（与现网一致）或章摘要+路径；若膨胀：只存 segments 必要字段，rawFactors 可剥 |
| 任务进度 | 不每 chunk 写 delivery 放大（保持现网「标注完成/终态写 annotations」） |

### 5.7 UI

| 阶段 | 内容 |
|---|---|
| Phase1 | **不强制** UI；API/annotations 可查 |
| Phase2 | 标注视图：emotion/intensity + style 摘要；可选单段重算表演 |

readiness / 固定试听：**永不**展示或使用段级 delivery。

---

## 6. 实现阶段

### Phase 0 — 纯函数 + 契约（默认路径无行为变更）

- [ ] types：`AudiobookSegmentDelivery` Core/Extended、`DeliveryStyleMode`、segment 扩展字段  
- [ ] `deliveryStyle.ts`：normalize / validateDeliveryLine / compileDeliveryLine / deliveryMergeKey / resolveSynthesizeInput  
- [ ] **指纹函数升级设计**（可先单测纯函数 `fingerprintParts`，Phase1 挂 Pipeline）  
- [ ] 单测：  
  - 基线-only（off）  
  - Core 全字段 compile  
  - 坏 deliveryLine → 重算  
  - 空话/复述台词拒绝  
  - design resolve 表演进 designPrompt  
  - mergeKey 同桶/异桶  
  - 超长 280 截断、base 优先  
  - 过戏词 strip  
- [ ] 金标准样例 ≥10：**好例 + 坏例→重算**（源世界风格）

**验收**：单测绿；生产默认 off 路径未接线则行为不变。

### Phase 1 — 标注 v2 + 管线接线

- [ ] annotate schema：delivery **optional**；normalize 剥坏表演  
- [ ] roster 声线摘要进 prompt  
- [ ] AnnotationService：mode 分支；baseStyle/baseDesignPrompt；resolve；mergeKey  
- [ ] `canMergeSegments` 改用 mergeKey（+ 音色字段）  
- [ ] **Pipeline fingerprint 纳入 style+designPrompt**  
- [ ] synthesize 只吃 `resolveSynthesizeInput` 结果  
- [ ] createTask + env 开关，**默认 off**  
- [ ] reannotate / resynthesize 语义按 D15  
- [ ] 集成测：假 LLM 坏 delivery 不整章旁白；异桶不合并；指纹变则重合成  
- [ ] **听感门禁**：同章 off vs characters 各抽样 ≥2 角色 chunk 人工听

**验收**：

1. mode=off ≡ 旧行为  
2. mode=characters：角色 style/design 含表演；旁白基线  
3. delivery 全坏 → speaker 仍多角色，style 静态  
4. design 角色请求 user 含「表演指令」  
5. 改 delivery 后 resume 不复用旧 chunk  
6. 听感：对峙 vs 软化可区分；无系统性过戏/破音  

### Phase 2 — 质量与连续

- [ ] continuityFrom 服务端补全  
- [ ] mode=all 旁白轻量  
- [ ] 标注 UI  
- [ ] 指标：fallbackRate、段均 user 长、merge 后 chunk 倍率、28k 截断章标记  
- [ ] 可选 bracket 实验（默认关）

### 明确不做

- 换供应商 / SSML 主路径  
- sfx / BGM  
- L1 章级导演备注库（backlog）  
- 跨章情绪图 DB  
- delivery 写回 Character  
- 写作主链 / Drama  
- 剧本式整章一次合成  
- 手改 delivery UI（P2 backlog）

---

## 7. Prompt 编译模板（高质量 SoT）

### 7.1 preset/clone · 最终 user

```text
{baseStyle ≤120}
本句表演：{deliveryLine ≤120}
{STABILITY_GUARD}
```

例：

```text
声线偏低略收，吐字清楚，语速中等，内敛敏感，不夸张。
本句表演：平静公事地压着怒，强装镇定却牙关发紧；对上级逼问责任；压低音量、语速沉稳、句中短暂停再接；密闭夜谈，承接对方冷笑怒意未消。
保持该角色声线与身份一致，吐字清楚，不要模仿旁白腔，不要唱歌，不要串戏到其他角色。
```

### 7.2 design · 最终 user

```text
{baseDesignPrompt}

表演指令：{deliveryLine}
{STABILITY_GUARD}
```

### 7.3 旁白 mode=all

```text
{narratorStyle}
本句叙述：{surfaceTone}，{primaryEmotion}（{intensity}），语速{rate}；像有声书旁白，不抢角色，不演戏。
```

### 7.4 deliveryLine 金标准

| 通过 | 不通过 |
|---|---|
| 具体可执行 | 「请有感情地朗读」 |
| 情绪核+表面+≥1 声道 | 只写「悲伤」 |
| 不复述台词 | 整句抄 text |
| 不改声线身份 | 改性别/年龄 |
| 与 primaryEmotion 不矛盾 | 字段怒、句温柔无依据 |

---

## 8. 风险与门禁

| 风险 | 缓解 |
|---|---|
| structured 整包失败 → 旁白 | delivery optional + normalize；D6 |
| resume 旧音频 | **指纹含 style+designPrompt**（D11） |
| design 表演丢失 | resolve 只改 designPrompt 用户通道（D3） |
| chunk 爆炸 | mergeKey 桶 + 倍率 warn（D7） |
| style 过长冲音色 | 280 上限；base 优先 120 |
| 过戏 | intensity 默认 mid；过戏词 strip；听测 |
| 28k 截断 | 风险明示；指标 |
| annotations 膨胀 | 章文件 SoT；可剥 rawFactors（D14） |
| 成本 | 默认 off；characters 仅角色段 |

---

## 9. 验收清单

**功能**

- [ ] mode=off 回归  
- [ ] characters：annotations 有 delivery（或合法 fallback）+ resolve 后 style/design  
- [ ] MiMo：preset/clone user 含表演；design user 含表演指令；assistant 纯台词  
- [ ] 坏 delivery 不整章旁白  
- [ ] 指纹变更触发重合成  
- [ ] readiness / 固定试听不受影响  
- [ ] reannotate / resynthesize 符合 D15  
- [ ] 取消语义不变  

**听感（Phase1 门禁）**

- [ ] 同章 off vs characters 可辨差异  
- [ ] 同角色对峙 vs 软化可辨  
- [ ] 无系统过戏/破音/串戏  

---

## 10. 文件级改动预估

| 区域 | 文件 |
|---|---|
| 类型 | `shared/types/audiobook.ts` |
| 纯函数 | 新 `server/src/services/audiobook/deliveryStyle.ts` |
| 标注 | `audiobookChapterAnnotate.prompts.ts`、`AudiobookAnnotationService.ts` |
| 合并 | `audiobookChunk.ts`（mergeKey） |
| 指纹/合成 | `AudiobookPipelineService.ts` |
| 任务 | `AudiobookTaskService` / create 入参 |
| 测试 | deliveryStyle 单测、annotation normalize、merge、fingerprint |
| 文档 | 本文件；产品形态/TTS 经验交叉引用 |

---

## 11. 与现有计划关系

| 计划 | 关系 |
|---|---|
| Voice Readiness | 正交：有没有声 vs 怎么说 |
| 固定试听 | 仅基线；禁高潮 delivery |
| 产品形态 | 听感质量能力；控制面仍是有声书台 |

---

## 12. 上线策略

1. 合并后 **默认 off**。  
2. 内网《源世界》1–2 章 `characters` 听测 + 指标。  
3. 稳定后默认改 `characters`（env/产品配置）。  
4. `all` 保持可选。

---

## 13. 开放问题（已收敛 / 剩余）

| # | 问题 | R2 结论 |
|---|---|---|
| 1 | 开关位置 | **createTask 字段 + env 默认**；代码默认 off |
| 2 | UI 一期 | **否**；Phase2 |
| 3 | 长章双 pass | **backlog**；触发条件=失败率或听感不稳 |
| 4 | 手改 delivery | **P2 backlog** |
| 5 | DB 是否剥 rawFactors | 实现时按体积决定；章文件保留 |

---

## 14. 参考链接

- DeepDubbing: https://arxiv.org/html/2509.15845v1  
- TACA-TTS: https://arxiv.org/html/2406.05672v1  
- audiobook-cc: https://arxiv.org/html/2509.17516v1  
- Gemini-TTS: https://docs.cloud.google.com/text-to-speech/docs/gemini-tts  
- Gemini speech: https://ai.google.dev/gemini-api/docs/speech-generation  

---

## 15. 修订记录

| 日期 | 说明 |
|---|---|
| 2026-07-16 | 初稿：调研 + 差距 + 架构 |
| 2026-07-16 | 加深字段：对齐角色骨架质量条 |
| 2026-07-16 | **R2 review 修订**：指纹硬门禁；delivery 失败隔离；Core/Extended；design resolve；mergeKey；deliveryLine 校验；roster 声线；存储；reannotate 语义；默认 off 统一；听感门禁；L1 backlog |
