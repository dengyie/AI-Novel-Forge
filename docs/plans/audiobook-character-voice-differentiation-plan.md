# 有声书 · 角色音色区分度（Character Voice Differentiation）开发计划

> 状态：**v1.1 实现中**（分支 `feat/audiobook-voice-diff` · 阶段 1–2 代码已落地）· 2026-07-16  
> 相对 v1.0：删除写文线耦合；收紧默认 `auto`；槽位降为 prompt 约束；补隔离契约与 provider 契约测；阶段重切避免面子工程。  
> 范围：在 **不换 TTS 供应商、不新建 Voice 表、不通读全书正文、不碰写文管线** 的前提下，把「多角色身份音色可区分」做成 **可用、可维护、可回归** 的有声书能力。  
> 生产：pxed + `ainovel.mangoq.ccwu.cc`；TTS：**CPA → MiMo chat-audio** 三模态。  
> 产品 SoT：Obsidian `ainovel 小说转有声书 产品形态` · 协议：`ainovel 小说转有声书 TTS 经验` · 控制面：`docs/plans/audiobook-workbench-voice-readiness-plan.md` · 固定试听：`docs/plans/character-voice-preview-asset-plan.md` · 段级表演：`docs/plans/audiobook-segment-delivery-style-plan.md`（**正交**）。  
> 审查基线：v1.0 深度审查 **有条件通过**；本文 = 解除阻塞后的实施 SoT。

---

## 0. 执行契约（Codex）

```text
Milestone：角色音色区分度（有声书线 · 卡驱动 · MiMo VoiceDesign）
目标：
  1) 用户点「重新差异化」后，主要角色以 design 绑定为主，固定试听侧听可拉开身份音色
  2) design prompt 结构化 + 跨角色 prompt 防撞（启发式），可单测、可回滚
  3) 只改有声书路径；独立分支；零写文服务依赖
  4) 不编造听感；验收门 = 固定试听人工结论

P0：
  - audiobookVoicePlanner：结构化 buildDesignPrompt、slot 仅作 prompt 分化、clone 永不改写
  - 修 auto 死区（importance 70/80 + voiceTexture 不升 design）；auto 仍保守，不默认全员 design
  - UI「重新差异化」→ strategy=prefer_design；「补齐缺失」→ auto
  - 单测：策略矩阵 / 槽位占用 / prompt 长度与互斥维 / clone skip
  - Mimo design 请求形状契约测（mock，不打真网）

P1：
  - prepare / 一键就绪：文档化 planStrategy；可选 UI 勾选 prefer_design（默认仍 auto 保守语义）
  - suggest summary 兼容字段：designCount 已有；可选 collisionSoftCount / designTooShortCount（非阻断）
  - apply 后引导就绪/重生成试听文案（已有 stale 逻辑回归）

不做的 P2/P3 / 明确移出本里程碑：
  - CharacterVisibleProfile / 任何 services/novel/** 调用或 import
  - 通读正文 / 对白抽样挖声线
  - 独立 Voice 表 / 供应商永久 voice id / RoleBank 微服务
  - 旁白 design/clone；旁白固定试听
  - 自动 clone；多 TTS 厂商；embedding / librosa 声学碰撞检测
  - design 多样本 A/B 自动选优
  - 改 deliveryStyle 协议；delivery 写进 Character；delivery 进 fixed preview 完备门禁
  - 把「槽位不撞」写成「听感已区分」产品文案
  - 默认 auto 大跃进为「重要角色全 design / 同性别超池全 design」（见 §4.1；属 backlog 可选项）

Manual-required：
  - 源世界：重新差异化(prefer_design) → 写入 → 一键就绪/重生试听 → 人工并排听 ≥3 主角色
  - 可选：重生 ch1 与旧 task 对比 — 只记录用户结论，禁止编造
  - CPA/MiMo design 限流与长 prompt 稳定性

阶段上限：3
阶段拆分：
  1) planner 纯函数 + 单测 + UI prefer_design 接线（最小听感闭环）
  2) auto 保守修补 + provider 契约测 + apply/stale 回归
  3) 可选 summary/hints + 文档交叉链 + 审查收口（hints 可整段 backlog）
验收：§7
停止：P0/P1 完成并验证；或阶段用尽；或 MiMo design 现网无法产出可侧听样本 → 《需人工关注报告》
禁止：自动开下一 milestone；为 Profile/声学分析/A-B 派生新阶段
```

---

## 0.1 隔离契约（硬性 · 违反即停）

### 分支

```text
独立分支：feat/audiobook-voice-diff（名可微调，必须独立于写文/内容门禁分支）
禁止：同一 PR 混入 novel 写作、content gate、quality、非有声书 UI
```

### 代码白名单（仅允许）

```text
server/src/services/audiobook/audiobookVoicePlanner.ts
server/src/services/audiobook/AudiobookVoiceAssetService.ts    # 透传 strategy/summary；禁止拉 Profile
server/src/services/audiobook/AudiobookVoiceReadinessService.ts # 仅 planStrategy 透传/文档；慎改默认
server/src/services/audiobook/MimoChatAudioTTSProvider.ts      # 仅当抽出可测 build* 且不改生产协议
client/src/pages/novels/components/NovelAudiobookPanel.tsx    # strategy + 文案
shared/types/audiobook.ts                                     # 策略/summary 向后兼容字段
server/tests/audiobookVoicePlanner.test.js
server/tests/*Mimo* / *audiobook*provider* 契约测（新建可）
server/tests/helpers/*（可选 test-support，不进生产渠道）
docs/plans/audiobook-character-voice-differentiation-plan.md
```

### 代码黑名单（禁止）

```text
server/src/services/novel/**          # 含 CharacterVisibleProfileService
写作任务 / 标注写作 / content gate / 样板门禁
Character / Novel schema migration、新 Prisma 字段
client 成文「角色准备」主路径（非有声书工作台）
client 裸写 ttsRefAudioPath
改 delivery 默认 off；delivery 字段挂 Character
AudiobookPipelineService / deliveryStyle 业务逻辑（本里程碑默认零改动）
为测试注册生产 TTS 渠道或改全局 provider 路由
```

### 依赖方向

```text
audiobook/*  →  shared types / prisma Character 只读字段 / 既有 Mimo provider
audiobook/*  ↛  novel/characterProfile、novel 写作服务
写文线不得因本里程碑被要求改 API
```

### 验收隔离门

```text
[ ] git diff 仅白名单（+ 本 plan / Obsidian 镜像）
[ ] rg "CharacterVisibleProfile" server/src/services/audiobook → 0 命中
[ ] 无 prisma migrate
```

---

## 1. 问题与动机

### 1.1 用户反馈（2026-07-16 · 源世界 ch1）

- 段级表演 + 现流水线 **总体可听**。  
- **人物身份音色区分度不足**：听感偏系统预设互撞，难靠耳朵稳定分角色。  
- 诉求：每角色独特 **身份** 音色；基于 **小米 MiMo**；工程补强规划能力，而非一次性手改几个 prompt。

### 1.2 根因（对照现网代码 · 有锚点）

| 层 | 现状 | 后果 |
|----|------|------|
| 预置池 | 中文仅 **冰糖/茉莉/苏打/白桦** | 同性别 >2 时 preset **物理撞车** |
| UI | 「补齐 / 重新差异化」均硬编码 `strategy: "auto"`（`NovelAudiobookPanel`） | **提高区分度按钮不生效** |
| auto 升档 | 外层 `importance≥70 && voiceTexture`，内层却要 `≥80` 才 design | **死区**：有 texture 的重要角色仍可能全 preset |
| design 文案 | `voiceTexture≥12` **原样返回**；否则短拼接；**无跨角色互斥** | 多角色描述同质 → design 也易撞 |
| 防撞 | 仅 preset **计数**；design 无分化约束 | 两个「沉稳青年男声」可并存 |
| 特征来源 | suggest **只读角色卡**（正确） | 卡空时质量上限低；**不是**缺通读正文 |
| 正交 | deliveryStyle 改 **演法** | **不能**替代身份 base |

### 1.3 产品一句话

**身份音色 SoT 在角色卡；区分度主操作 = 工作台「重新差异化」走 `prefer_design`；prompt 负责文本级分化；固定试听是唯一听感验收门（人工）。**

### 1.4 什么叫「真改善」vs「面子工程」

| 真改善 | 面子工程（禁止当交付） |
|--------|------------------------|
| 卡上 `ttsMode/ttsDesignPrompt` 真变 design | 只加 collisionCount 看板 |
| UI 真发 `prefer_design` | 文案写「已区分」但 strategy 仍 auto |
| prompt 含可执行的分离维 + 互斥句 | 槽位表全绿却无人侧听 |
| apply → preview stale → 重生试听可并排听 | 引入写文 Profile「看起来更智能」 |
| 单测锁策略与 payload 形状 | 删测 / 放宽断言混过 |

---

## 2. 外部实践（吸收边界）

| 实践 | 本项目落地 |
|------|------------|
| RoleBank / 每角色固定 voice 资产 | 已有 `Character.tts*` + `preview.wav`；**不**新建表 |
| 身份 vs 表演分离 | 身份 = tts 绑定；表演 = delivery（正交、默认 off） |
| VoiceDesign 造虚构角色声 | **主路径（prefer_design / 升档 design）** |
| VoiceClone | **仅人工**；planner 永不写 clone |
| 预置 | 旁白 + 低重要路人；池小故不能当多人主方案 |
| 描述多维 | 结构化 prompt；**slot = 启发式文本约束，非声学保证** |
| 短样本锁定 | 固定试听；改绑定 → fingerprint stale |
| 不把全书解析当门禁 | **本里程碑不读正文** |

**不抄**：voice marketplace、跨书 embedding、第二 TTS 引擎、独立 RoleBank 服务。

---

## 3. 数据与边界

### 3.1 特征输入（只吃角色卡 · 只读）

`VoicePlannerCharacterInput`（`AudiobookVoiceAssetService.suggest` 已 select）：

| 字段 | 用途 |
|------|------|
| gender / 名 / role / appearance… | genderBucket |
| role / voiceTexture / personality / appearance… | ageBucket |
| castRole / role / 字段丰富度 | importance 0–100 |
| **voiceTexture** | design【声线】核心 |
| personality / firstImpression / appearance / storyFunction | 补维 |
| 现有 tts* | onlyMissing / clone 跳过 / overwrite |

**禁止**本里程碑规划输入：章节正文、annotation speaker 统计、delivery 字段、VisibleProfile 生成结果（见 §3.2）。

### 3.2 卡空时怎么办（无写文依赖）

| 选项 | 说明 | 本里程碑 |
|------|------|----------|
| A. 弱字段启发式拼 design | gender/age/role/personality | **P0 必有** |
| B. 人工角色台补 `voiceTexture` | 用户操作 | **始终可用 · UI 提示** |
| C. CharacterVisibleProfile 补卡 | 写文线服务 | **禁止**（移出本 milestone；若未来做，只在角色/写文入口触发，audiobook **零 import**） |
| D. 通读正文抽声线 | — | **P3 backlog，本里程碑不做** |

### 3.3 输出资产（不改 schema）

| 输出 | 规则 |
|------|------|
| design | `ttsMode=design`，非空 `ttsDesignPrompt`，`ttsVoice` 清空；`ttsStyle` 可短审计句 |
| preset | 合法预置名；`ttsDesignPrompt` 清空 |
| clone | **不规划**；已绑定带 ref 的 clone **永久 skip** |
| 试听 | 既有 preview + fingerprint；apply 后 stale → prepare/单条 regenerate |

### 3.4 模块边界

```text
Character 卡（文学字段 + tts* + preview）  ← 只读写这些列
        ↑ apply / generateCharacterPreview
audiobookVoicePlanner（纯函数 · 本里程碑核心）
        ↑ suggest
AudiobookVoiceAssetService / VoiceReadiness prepare
        ↓
固定试听（只读播）→ 人工验收
        ↓
AudiobookTask 合成（消费卡上 tts*；delivery 只改演法）
```

- **不改** pipeline / delivery 实现。  
- **不改** createTask 硬拦语义（仍音色完备；preview 可选 requireReadyPreview）。  
- design 绑定变化后，合成自然吃新 prompt；无需为「区分度」改合成器。

---

## 4. 冻结决策

| ID | 决策 |
|----|------|
| D1 | 不新建 Voice 表 / 供应商永久 id |
| D2 | 特征 **只来自角色卡只读字段**；**不通读正文**；**不调** CharacterVisibleProfile |
| D3 | **提高区分度主路径 = `prefer_design`**（UI「重新差异化」）；不是默默改 prepare 全员 design |
| D4 | **`auto` 保持保守可预期**：修死区 + 重要角色 preset 碰撞升 design；**不做** v1.0「重要≥55 全 design」大跃进（该语义若验证听感后再开 backlog） |
| D5 | clone 永不由规划器写入/覆盖 |
| D6 | **槽位 = prompt 分化启发式**，**不是**声学/听感证明；产品文案禁止「已保证可分」 |
| D7 | **听感验收门 = 固定试听人工侧听**；工程验收 = 单测 + 策略接线 + 隔离门 |
| D8 | 策略三态保留：`auto` / `prefer_design` / `preset_only`；`preset_only` = 回滚/廉价 |
| D9 | 不改 MiMo 协议与 model 名；design：`user=designPrompt`，禁止 `audio.voice` |
| D10 | delivery 默认与行为不变；不进 Character；不进 fixed preview 完备门禁 |
| D11 | 规划 **禁止** 调用 TTS；prepare 仍串行 TTS 并发 1；**不**因重规划自动全书重合成 |
| D12 | 独立分支 + 白名单；黑名单零容忍 |

### 4.1 策略矩阵（实现锁进单测）

| strategy | 行为 |
|----------|------|
| `prefer_design` | 除 clone skip 外，**全部**候选 → design + 结构化防撞 prompt |
| `preset_only` | 仅 preset 负载均衡；**不**升 design |
| `auto`（**保守修订**） | 见下表 |

**`auto`（P0 写死 · 相对现网只做可证明修补）：**

| 条件 | 结果 |
|------|------|
| clone 已绑定（mode=clone 且 ref 非空） | skip |
| `prefer_design` 不在此列 | — |
| importance ≥ 70 **且** `voiceTexture` 非空 | **design**（**删除**内层 ≥80 死区；与外层条件对齐） |
| importance ≥ 55 且目标 preset 的 importantUsage ≥ maxImportantPerPreset（默认 1） | **design**（保持现网碰撞升档） |
| 其余 | preset 负载均衡（seed 已绑定 usage） |

**明确不做进本里程碑 `auto` 的 v1.0 草案：**

- importance ≥ 55 无条件 design  
- 同性别人数 > 池大小则强制超出全 design  

> 理由：无侧听对照前改默认 prepare 成本与行为面过大；**区分度主按钮已是 prefer_design**。上述激进 auto 进 Backlog，听感验证后再议。

**兼容：**

- 旧「两男两女分 preset」测：保留在 `preset_only` 或低重要 `auto`。  
- 旧 auto「至少一 design 或两不同 preset」：改为对 **有 texture 的高重要双男主** 断言 **至少一 design**（修死区后应更稳）。  
- `prefer_design` 测：全 design + prompt 非空 + 含互斥/结构标记。

### 4.2 声线槽位（prompt 约束 · 非 ML · 非听感证明）

每个 **走 design** 的角色占用 slot key：

```text
{genderBucket}|{pitchBand}|{textureBand}|{energyBand}
```

| 维 | 枚举（实现可微调，单测锁定） |
|----|------------------------------|
| pitchBand | high / mid / low |
| textureBand | bright / neutral / dark_raspy / airy |
| energyBand | lively / even / heavy |

规则：

1. 从卡字段启发式推断默认槽；**design prompt 必须显式写出**对应自然语言（音高/质感/气息）。  
2. 槽已被占用 → 按固定优先级扰动（texture → pitch → energy → 年龄细节）直到空闲。  
3. 池耗尽 → 允许 soft 冲突；`reason` 含 `collision:soft`；互斥句最多引用 **1** 个邻居维度标签（不点名过多角色，防 prompt 爆炸）。  
4. preset 路径：仍用 usage 计数；**重要角色不共享同一 preset**（`maxImportantPerPreset` 默认 1）。  
5. **禁止**用「slot 无硬撞」在 UI/readiness 展示为「听感已区分」。

### 4.3 design prompt 模板（结构化 · ≤480 字）

```text
【身份】{年龄段}{性别}，叙事身份：{role/castRole 短名}
【声线】音高{pitch}，质感{texture}，气息{energy}；{voiceTexture 原句优先整段保留}
【气质】{personality/firstImpression 截断}
【表达】语速中等，吐字清楚，适合小说对白；中文普通话（除非卡明确方言）
【互斥】与同书其他角色在音高/质感上可辨；避免播音腔与无特征标准青年声
【禁止】不要模仿旁白；不要空壳「标准男/女声」
```

**截断优先级（高 → 低）：**  
`【声线】含 voiceTexture` → `【互斥】` → `【身份】` → `【表达】` → `【气质】` → 其它。  
总长 ≤480；互斥与声线不得被气质句挤掉。

**相对现网修复：**

- `voiceTexture≥12` **禁止**再 `return base` 了事；原句进【声线】，**仍拼**结构维与互斥。  
- `ttsStyle`：preset/clone 短审计 ≤200；design 模式以 `ttsDesignPrompt` 为准。

### 4.4 reason 字段（可观测）

每条 plan item 的 `reason` 应能看出：

- 策略名  
- 升 design 原因（prefer_design / texture+importance / preset 重要位满）  
- 若有 soft 碰撞：`collision:soft`  
- 禁止空 reason

---

## 5. 架构与改动面

### 5.1 模块

| 模块 | 职责 | 变更 |
|------|------|------|
| `audiobookVoicePlanner.ts` | 纯函数规划 + 槽位 + prompt | **核心** |
| `AudiobookVoiceAssetService` | suggest/apply 读卡 | 透传 strategy；**不**调 Profile；summary 可选扩展 |
| `AudiobookVoiceReadinessService` | prepare planStrategy | 默认保持 `auto`（新保守语义）；支持传入 `prefer_design` |
| `novelAudiobookRoutes` | zod 已有 strategy | 可不加字段；文档化 |
| `NovelAudiobookPanel` | 按钮策略 | **重新差异化 → prefer_design**；补齐 → auto |
| `MimoChatAudioTTSProvider` | design payload | 仅可测抽取；**协议不改** |
| `audiobookVoicePlanner.test.js` | 回归 | **必改** |
| provider 契约测 | design/clone/preset 形状 | **P0 小测** |

### 5.2 API 契约

现有即可：

- `POST .../voice-plan/suggest` `{ onlyMissing?, characterIds?, strategy?, maxImportantPerPreset? }`  
- `POST .../voice-plan/apply`  
- prepare：`planStrategy?: auto|preset_only|prefer_design`

**可选 P1 summary 扩展（向后兼容）：**

```ts
summary: {
  // existing: presetCount, designCount, ...
  softCollisionCount?: number;
  designTooShortCount?: number; // prompt 异常短（实现阈值如 <24）
}
```

非阻断；**不得**变 createTask 硬拦。

### 5.3 UI 行为（工作台）

| 控件 | 行为 |
|------|------|
| 补齐缺失音色 | `onlyMissing=true`，`strategy=auto` |
| **重新差异化** | `onlyMissing=false`，**`strategy=prefer_design`** |
| 一键就绪 | 缺音色时 plan+apply 用 prepare 的 planStrategy（默认 **auto 保守**）；高级可选 prefer_design |
| 写入后 | 明确：试听将过期，请一键就绪/生成试听 |
| 文案 | 副标题说明：提高身份音色区分度（VoiceDesign）；特征来自角色卡，**不读正文**；空卡请补 voiceTexture |
| 禁止 | 展示「槽位已保证听感可分」 |

### 5.4 可维护 / 高可用

| 维 | 做法 |
|----|------|
| 可测 | 纯函数 + provider 形状；禁 suggest 内打 TTS |
| 可观测 | reason；job 日志保留 planStrategy |
| 失败隔离 | design TTS 失败不改卡；preview 失败记 item，不拖死其他角色 |
| 限流 | prepare TTS 并发 1；重规划不触发全书合成 |
| 回滚 | `preset_only` 重规划；git 回退 planner+UI；无 migration |
| 安全 | prompt 截断 480；无 HTML；clone 路径既有校验 |

---

## 6. 阶段拆分（≤3）

### 阶段 1 — 规划纯函数 + 最小控制面闭环（P0）

**目标**：单测证明可区分规划；UI 重新差异化真正打 `prefer_design`（否则听感闭环不通）。

- 槽位模型 + `buildDesignPrompt` 结构化（含 texture 原句 + 互斥 + 截断优先级）。  
- `prefer_design` / `preset_only` / clone skip 保持并加强断言。  
- **不**在本阶段改 prepare 默认激进行为。  
- Client：重新差异化 → `prefer_design`；补齐 → `auto`；文案。  
- 测试：`audiobookVoicePlanner.test.js` 扩展。

**可验证：** 测试绿；请求 body 策略正确；无 DB 迁移；diff 在白名单。

### 阶段 2 — auto 保守修补 + provider 契约 + 回归（P0/P1）

- 删除 auto 70/80 死区；重要 preset 满员升 design 回归。  
- Mimo design/preset/clone **请求形状**单测（mock HTTP 或不发起网络；断言 messages/audio 字段）。  
- 可选：test-support 记录 `lastRequest`（仅测试树）。  
- apply 后 preview fingerprint stale 既有行为回归（有则跑，无则点名依赖既有测）。  
- **禁止**接 CharacterVisibleProfile。

**可验证：** typecheck；相关单测绿；design payload 无 `audio.voice`。

### 阶段 3 — 可见性与收口（P1 · 可收缩）

- summary softCollision / designTooShort（可选）。  
- 非阻断 hints；**不**硬拦 createTask。  
- 代码审查（production-code-quality-review）；Obsidian 产品形态决策行与索引状态；本 plan → 实现中/已上线。  
- 若阶段预算紧：**整段 backlog**，不阻塞以阶段 1–2 交付。

**可验证：** 审查通过；隔离门通过；文档 tip **待 cutover 另记**（不在本阶段伪造生产 tip）。

---

## 7. 验收标准

### 7.1 工程验收

- [ ] `planCharacterVoices` 新/修订语义单测全绿  
- [ ] clone 在 onlyMissing=false + prefer_design 下仍 skip  
- [ ] designPrompt ≤480；含【声线】或等价维 + 互斥意图（单测可对子串/标记）  
- [ ] texture 长文不再裸 return；仍含结构/互斥  
- [ ] UI 重新差异化 body.`strategy` === `"prefer_design"`  
- [ ] 补齐缺失仍 `auto`  
- [ ] Mimo design 契约：user=designPrompt，audio 无 voice  
- [ ] apply 后 preview stale 逻辑不回归  
- [ ] 无 prisma migration；delivery 默认 off 不变  
- [ ] 隔离门：audiobook 树无 CharacterVisibleProfile；diff 白名单  

### 7.2 产品/听感验收（Manual-required · **不编造**）

1. 源世界：重新差异化 → 写入 → 一键就绪/重生成试听。  
2. 并排播放 ≥3 名主要角色固定试听，**仅用户**判断是否明显可分。  
3. 可选：重生 ch1（旧 task 如 `cmrmzarq8000gto9ksjpz1j1j`）— **只记用户结论**。  
4. 硬刷新工作台：重新差异化不得静默退回仅 preset 规划。

### 7.3 非目标（不要误测）

- 不要求旁白 design。  
- 不要求零人工改 prompt。  
- 不要求 embedding/声学指标。  
- 不要求 prepare 默认 auto 即全员 design。  
- 不要求写文画像自动补全。

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| MiMo 对相似中文描述仍撞声 | 听感改善不足 | 结构化+互斥；Manual 侧听；单角色手修一维 |
| 槽位绿但耳朵撞 | 面子工程幻觉 | 文案与验收禁止等同；只认试听 |
| design 成本/时延 | 就绪变慢 | 并发 1；只重生成 stale；不自动全书合成 |
| 误把 auto 改激进 | 预期/成本失控 | 本版 auto 保守；主路径 prefer_design |
| 空 voiceTexture | 描述弱 | 弱字段模板 + UI 提示补卡；**不**调 Profile |
| prompt 截断丢互斥 | 又撞 | 截断优先级单测 |
| 与 delivery 叠加过满 | 噪声 | delivery 默认 off；本里程碑不改 delivery |
| 写文耦合回流 | 破坏隔离 | 黑名单 + rg 门禁 |

---

## 9. 测试计划

| 类型 | 内容 | 层级 |
|------|------|------|
| 单元 | 策略矩阵、死区修复、槽位占用、prompt 结构/长度/截断、clone skip、onlyMissing seed | P0 |
| Provider 契约 | design/preset/clone 组装：model、messages[0]、audio.voice 有无 | P0 |
| 可选 test-support | 假 WAV + lastRequest；供 asset 层不联网 | P1 |
| 回归 | fingerprint 含 designPrompt；apply 清交叉字段 | P0/P1 |
| 手工 | §7.2 | Manual |
| 禁止 | 编造听感；mock 通过冒充 Manual；为测改写文 provider | — |

**实现提示：** 现测 `require("../dist/services/audiobook/...")`；改 planner 后先 build/按仓库惯例跑测，**禁止删断言混过**。

---

## 10. 回滚与发布

| 项 | 做法 |
|----|------|
| 代码 | 回退 planner + UI strategy 即可；无 migration |
| 数据 | 已写 tts 字段不自动回滚；可用 `preset_only` 再规划（非 clone） |
| 发布 | 含 client：Mac dist + scp（pxed 易 OOM）；纯 server 可机上 tsc |
| Cutover | 运维手册新小节；索引 tip；**听感结论不写进 cutover 当已验证** |

---

## 11. Backlog（本 milestone 明确不做）

- CharacterVisibleProfile / 写文线补 `voiceTexture`  
- `auto` 激进：重要≥55 全 design；同性别超池强制 design  
- 正文抽样推断声线 / speaker 频率加权  
- design 试听 A/B 自动选优  
- 音高客观分析 / embedding 碰撞  
- 旁白 design/clone  
- 跨小说音色模板市场  
- 英文 locale 池细化  

---

## 12. 文档交叉链（实现时勾选）

- [ ] 本文件保持 SoT（v1.1）  
- [ ] Obsidian `ainovel 有声书角色音色区分度-开发计划` 与本文同步  
- [ ] Obsidian `ainovel 小说转有声书 产品形态` 决策 #14 与隔离/prefer_design 主路径一致  
- [ ] Obsidian `ainovel 文档索引` 本 plan 行 status  
- [ ] `audiobook-workbench-voice-readiness-plan.md` 备注：prepare 默认 auto=**保守修订**；区分度主按钮=prefer_design  
- [ ] 上线后 cutover 记运维手册  

---

## 13. 附录 A — 现状代码锚点

| 路径 | 说明 |
|------|------|
| `server/src/services/audiobook/audiobookVoicePlanner.ts` | plan / buildDesignPrompt / 70–80 死区 |
| `server/src/services/audiobook/AudiobookVoiceAssetService.ts` | suggest select 卡字段、apply |
| `server/src/services/audiobook/AudiobookVoiceReadinessService.ts` | prepare planStrategy |
| `server/src/services/audiobook/MimoChatAudioTTSProvider.ts` | design：user=designPrompt |
| `shared/types/audiobook.ts` | AudiobookVoicePlanStrategy |
| `client/.../NovelAudiobookPanel.tsx` | strategy 硬编码 `"auto"` ~L948 |
| `server/tests/audiobookVoicePlanner.test.js` | 既有测 |
| `shared/types/novelCharacter.ts` | voiceTexture 等文学字段 |
| `server/src/services/novel/characterProfile/*` | **本里程碑禁止引用** |

## 14. 附录 B — MiMo 模态

| ttsMode | model | 身份承载 |
|---------|-------|----------|
| preset | `mimo-v2.5-tts` | `audio.voice` 预置名 + style |
| design | `mimo-v2.5-tts-voicedesign` | `user`=designPrompt（主输出） |
| clone | `mimo-v2.5-tts-voiceclone` | 参考 WAV DataURL；人工 |

## 15. 附录 C — 要不要读正文

| 问题 | 结论 |
|------|------|
| 规划要通读文章？ | **不要** |
| 特征从哪来？ | **角色卡只读字段** |
| 空卡？ | 弱启发式 + 人工补 voiceTexture |
| VisibleProfile？ | **本里程碑不做** |
| 何时考虑正文？ | P3 且另开里程碑 |

## 16. 附录 D — v1.0 → v1.1 变更摘要

| 项 | v1.0 | v1.1 |
|----|------|------|
| VisibleProfile | 阶段 2 P1 | **删除** |
| auto 语义 | 重要≥55 全 design 等激进 | **保守**：修死区 + 碰撞升档 |
| 区分度主路径 | 偏改默认 auto | **UI prefer_design** |
| 槽位 | 易被读成声学保证 | **明示 prompt 启发式** |
| 隔离 | 未写 | **§0.1 分支+白/黑名单** |
| 测试 | 偏纯函数 | **+ provider 契约** |
| texture 长文 | 裸 return | **仍拼结构与互斥** |
| 阶段 | Profile+hints 占位重 | 1=闭环 2=契约 3=可收缩 |

---

**文档维护：** 改 `auto` 阈值、槽位枚举、策略矩阵必须同步 §4 与单测，禁止只改代码。  
**听感：** 任何「改善/可分」结论仅来自 Manual §7.2 用户反馈，文档与 cutover 不得预支。
