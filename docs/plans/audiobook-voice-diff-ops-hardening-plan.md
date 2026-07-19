# 有声书 · 音色区分度运营硬化（Voice Diff Ops Hardening）开发计划

> 状态：**待实现** · **v1.1 听感硬指标修订** · 2026-07-17  
> **唯一硬指标：生成音频的听感质量**（身份可辨 + 声线硬 + 长书稳定）。Token/费用/阶段面子/summary 字段 **一律让路**。  
> 调研：MiMo-V2.5 官方用法 / 发布文 / [MiMo-Skills](https://github.com/XiaomiMiMo/MiMo-Skills)；源世界 auto 灌预置实证；仓库现网 preview 默认句与单次合成固化。  
> 前置已上线：区分度 + 分簇 v2 · design prompt 质量 v1.2 · 固定试听 · readiness · delivery（默认 off）· multi-backend。  
> 产品 SoT：`ainovel 小说转有声书 产品形态` #14 · 协议：TTS 经验 · 底座：`audiobook-character-voice-differentiation-plan.md` · 文案：`audiobook-design-prompt-quality-plan.md`。  
> v1.0→v1.1：以听感重排 P0；**多样本选优 + 试听句质量 + Design→Clone** 从 backlog/可砍 提升为听感主路径；弱化 UI/summary 装饰项。

---

## 0. 听感硬指标（先于一切阶段）

### 0.1 什么叫「音频质量过关」（本里程碑）

| 维度 | 过关 | 不过关 |
|------|------|--------|
| **身份可辨** | 固定试听并排，主配角 ≥3 人，盲听能说出「不是同一个人」 | 苏打×N / 冰糖×N / design 同模板糊成一片 |
| **声线够硬** | 24k 清晰、无炸麦、无持续气声虚、角色有主心骨（lead 不平板） | 能播但空壳标准声 / 虚飘 / 全员播音腔 |
| **长书稳定** | 同角色跨章/跨任务身份不漂（lead 优先 clone 锚定） | 每章 design 重采样像换人 |
| **旁白隔离** | 旁白 preset 与角色声线不撞车 | 角色再绑茉莉=旁白 |

**CI 不能替耳朵做主。** 自动化只锁「会走到正确模型/正确资产路径」；**放行生产改默认策略前，必须 Manual 听感清单 §7.2 勾完。**

### 0.2 硬指标下的优先级重排（v1.1）

| 听感贡献 | 项 | v1.0 位置 | v1.1 |
|----------|----|-----------|------|
| 极高 | 主配角走 **VoiceDesign 模型** 而非 4 预置复用 | smart_fill P0 | **仍 P0** |
| 极高 | **同配置多抽选优** 再固化 preview（官方：有随机性，多生成挑选） | 明确不做/backlog | **P0 听感** |
| 极高 | **试听正文质量**（2–5 句、立得住节奏，禁一句产品腔） | 未写 | **P0 听感** |
| 高 | **Design→Clone**（满意样本作 ref，长书不漂） | 阶段 3 可砍 | **P0/P1 听感，不可因省事砍 lead** |
| 高 | design **声学可执行** 描述（质感/共鸣/节奏/底色正交，忌形容词堆） | 风格锚+癖好 | **保留但改写质量规约** |
| 中 | 旁白 reservedPresets | P0 | P0（防撞，间接听感） |
| 低 | UI 说明文案、summary 计数 | P0/P1 | **P2，不占听感阶段预算** |
| 负/险 | 单次随机 preview 直接 adopt clone | 阶段 3 默认 | **禁止无选优 adopt** |
| 负/险 | 往 identity 塞场景/导演长笔记/互斥空话冲掉声学指令 | 部分风险 | **硬禁 + 截断优先声学** |

### 0.3 明确：token/费用不是约束

- 允许 lead/cast **默认 design**、允许每角色 preview **N 次合成取 1**。  
- 禁止为省调用把主配角打回 preset、禁止把多抽从 P0 挪走。  
- 工程上仍要：可取消 prepare、串行 TTS 防打爆上游（稳定性），**但串行≠少抽**。

---

## 1. 执行契约（Codex · v1.1 冻结）

```text
Milestone：音色区分度运营硬化（听感硬指标版）
目标：
  1) 主配角身份音色默认走 mimo-v2.5-tts-voicedesign，不再被 4 预置灌满
  2) 固化试听前必须多抽选优；试听句本身能撑起声线判断
  3) design 文案以可听辨声学指令为主，禁止空壳模板与矛盾堆砌
  4) lead（及用户指定 cast）可将「选中的」试听升格 clone，锁长书身份
  5) 旁白 preset 与角色隔离
  6) 放行标准 = Manual 听感清单，不是「单测绿+文案改了」

P0（听感，本里程碑必须做完才能称可交付）：
  - auto → smart_fill：lead/cast 缺绑/规划 → design；extra → preset
  - reservedPresets：旁白 voice 角色池剔除
  - preview 合成：默认 N=3 抽，服务端/UI 选优固化（§3.4）；禁止 N=1 静默固化作为主路径
  - preview 正文：替换默认一句产品腔；按 Skills 2–5 句、与声线底色可兼容（§3.5）
  - buildDesignPrompt：声学正交规约 + 风格锚/癖好不得与三元冲突；截断优先声学短语
  - 单测：策略、reserved、多抽 API 契约、prompt 含可执行声学维、默认试听句长度/句数门
  - Manual：源世界（或同复杂度样书）§7.2 听感清单

P1（听感增强，优先于任何 UI 装饰）：
  - adopt-selected-preview-as-clone：仅允许「选优后的」样本升格；lead 强烈推荐
  - 升格后可选立即用 clone 再 gen 一条对照句，确认锁身份
  - prepare 支持 candidatesPerCharacter（默认 3，上限 5）

P2（非听感，有余力再做）：
  - UI 长说明、toast 文案打磨、summary 计数字段
  - Obsidian 交叉链润色

禁止（伤害听感或伪听感）：
  - 把多抽/试听句/lead-clone 标成 backlog 只为赶阶段数
  - 无选优的「一键 adopt 当前唯一 preview」
  - 声学 embedding 假门禁替代人耳
  - 槽位距离写成「已保证区分」
  - 导演长笔记/场景动作写进 identity
  - 改 MIMO 三模型映射（已正确）；换本地引擎
  - 通读正文 / Profile；新建 Voice 表（本里程碑仍不做，不阻塞听感）
  - 默认打开 delivery 污染固定试听

Manual-required（阻塞「听感可交付」）：
  - §7.2 全表；未听完不得宣称质量达标

阶段上限：3（按听感闭环切，不按「文档/UI」切）
  1) 路由听感：smart_fill + reserved + 多抽选优 preview + 试听句
  2) 文案听感：design 声学规约 + 冲突剥离 + 回归测
  3) 稳定听感：选优样本 → clone 升格（lead 默认引导）
验收：§7
停止：P0 听感清单通过；或 MiMo design/clone 现网不可用 → 人工报告
禁止：用「阶段用尽但只做了 reserved+文案」冒充可交付
```

---

## 2. 隔离契约

### 分支

```text
feat/audiobook-voice-diff-ops
从 main（生产 tip 以索引为准）拉出
```

### 白名单

```text
server/src/services/audiobook/audiobookVoicePlanner.ts
server/src/services/audiobook/AudiobookVoiceAssetService.ts
server/src/services/audiobook/AudiobookVoiceReadinessService.ts
server/src/services/audiobook/characterVoicePreview.ts          # 默认句、多候选指纹、选优写入
server/src/services/audiobook/designPromptArchetypes.ts
server/src/services/audiobook/designPromptQuirks.ts            # 新建可
server/src/services/audiobook/voiceRefPath.ts / audiobookPaths  # clone 升格 copy
server/src/modules/novel/production/http/novelAudiobookRoutes.ts
client/.../AudiobookVoiceReadinessSection.tsx
client/.../NovelAudiobookPanel.tsx
client API 封装（preview candidates / adopt）
shared/types/audiobook.ts
server/tests/audiobookVoicePlanner.test.js
server/tests/characterVoicePreview*.test.js（扩多抽/默认句）
server/tests/*adopt* / readiness job（可新建）
docs/plans/audiobook-voice-diff-ops-hardening-plan.md
```

### 黑名单

```text
novel/** Profile；prisma 新字段（复用 tts* / preview* / ref）
deliveryStyle 默认；Pipeline 业务大改
MimoChatAudioTTSProvider messages 语义（可加超时/日志，不改协议）
```

---

## 3. 问题：相对「听感」v1.0 文档自身的缺陷

| # | v1.0 问题 | 听感后果 |
|---|-----------|----------|
| D1 | 把 **多抽选优** 写进「不做」 | 官方承认随机性；单次固化 = 把运气当质量 |
| D2 | **Design→Clone 可砍** | 长书 identity 漂 = 成品质量事故 |
| D3 | **零篇幅管试听正文** | 默认「我是这段故事里的角色…」一句产品腔；Skills：太短立不住节奏；clone ref 也废 |
| D4 | sampleText **slice(0,120)** | 2–5 句空间被砍，听感/锁身份都弱 |
| D5 | 阶段按「策略 / 文案装饰 / 可砍 clone」切 | 易交付「策略改了但耳朵仍糊」 |
| D6 | 风格锚+癖好未写 **与三元冲突剥离** | 模型收到矛盾指令 → 平均成糊 |
| D7 | 验收偏工程门 | 「测绿」≠「好听、可辨」 |
| D8 | 强调兼容/省字段名 | 正确，但不得压过听感项 |

---

## 4. 详细设计（听感路径）

### 4.1 smart_fill（路由：谁有资格发出好声）

**文件：** `audiobookVoicePlanner.ts` `planCharacterVoices`

```text
strategy === "auto"（本里程碑起 = smart_fill）：
  lead | cast  → design + minSep=2 + 既有 softCollision
  extra | narrator 角色簇 → preset（分簇池）
  未知簇 → importance≥70 && voiceTexture ? design : preset

prefer_design：保持（overwrite 主配角）
preset_only：保持（调试/回滚用，不是听感主路径）
```

**听感理由：** 中文精品只有 4 个，主配角复用 preset **物理上不可能** 身份可辨。  
**不是**听感完成态：只解决「进对模型」。

**调用方：** prepare / 补齐缺失继续传 `planStrategy: "auto"`，语义变为 smart_fill；**重新差异化** 仍 `prefer_design`。

---

### 4.2 reservedPresets（旁白不抢角色声）

```ts
planCharacterVoices({ ..., reservedPresets?: string[] })
```

- `suggest` 读小说旁白 voice → filter 合法预置 → 传入。  
- 角色 preset 池 `filter(!reserved)`；池空则 lead/cast **强制 design**。  
- usage 预 seed 旁白 voice。

**听感理由：** 旁白茉莉 + 角色茉莉 = 叙事身份与角色身份糊。

---

### 4.3 多抽选优 preview（P0 · 听感核心）

**现状问题：**

```ts
// generateCharacterPreview：一次 synthesize → 立刻写 preview.wav
const sampleText = (input.text?.trim() || DEFAULT_PREVIEW_TEXT).slice(0, 120);
```

**目标行为：**

| 参数 | 默认 | 上限 | 说明 |
|------|------|------|------|
| `candidates` | **3** | 5 | 同 mode/voice/style/design/ref/sampleText 连抽 N 次 |
| 选优 | 人工 UI 必选；无 UI 的 job 见下 | — | |

**prepare / 批量 job（无交互时）：**

```text
对每个需 gen 的角色：
  1) 合成 candidates 条 → 落临时 candidate-0..N-1.wav（同目录或 tmp）
  2) 自动初选策略（工程代理，不代替人耳终验）：
     - 剔除：过短/解码失败/明显 clip（已有 wav 工具则复用；无则仅剔除失败）
     - 其余：取「时长中位数最近」一条作默认固化（避免极短哑火/极长失控）
  3) 写入正式 preview.wav + fingerprint
  4) 可选保留 candidates 列表元数据供 UI「换一条/听备选」（P1 若文件多可只留 winner）

单角色「生成试听」UI：
  - 一次返回 N 条可播放 URL（短时 media-access）
  - 用户点「采用此条」才写正式 preview + fingerprint
  - 未采用不覆盖旧 ready preview（避免误点变差）
```

**API 形态（实现选定一种，契约测锁死）：**

```text
POST .../characters/:id/audiobook/voice/preview/generate
  body: { text?, candidates?: 1..5 }
  → { candidates: [{ id, url, durationMs }], adopted: null }

POST .../characters/:id/audiobook/voice/preview/adopt-candidate
  body: { candidateId }
  → 正式 preview 资产

兼容：旧 generate 一次返回单条 = candidates=1 的退化；产品主按钮默认 3。
```

**听感理由：** Skills 原文级要求；单抽当真理是质量赌博。  
**费用：** 允许 ×3；硬指标是耳朵不是账单。

---

### 4.4 试听正文质量（P0 · 与 Skills 对齐）

**现状：**

```ts
DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT =
  "我是这段故事里的角色，请听听我的声音是否合适。";
// + slice(0, 120)
```

**问题（听感）：**

1. 一句说明体，无情绪弧、无节奏变化 → design/clone **立不住声线**。  
2. Skills：**2–5 句一整段**；太短微妙特质出不来。  
3. Skills：**文本情绪须与音色底色契合**；全员同一句产品腔 → 听感对比失真。  
4. 该句若被 adopt 成 clone ref → **整本书锁在废样本上**。

**规约：**

| 项 | 规则 |
|----|------|
| 默认句库 | 按 **gender×age×cluster** 或 slot energy 选 1 条中性叙事/对白，**不是**产品说明 |
| 句数 | **3–5 句**（中文）；总长目标 **80–160 字**，硬顶放宽到 **200**（改 slice；fingerprint 同步） |
| 内容 | 有标点停顿、少量语气，**禁止**「请听听我的声音是否合适」类 meta |
| 与底色 | heavy 不用尖叫狂欢句；lively 不用纯悼词；冲突则用中性叙事句 |
| 标签 | 固定试听 **默认不** 塞行内表演标签（避免污染身份基线）；成书 delivery 仍正交 |
| prepare | 可用 `previewText` 覆盖；未传则句库 |

**示例方向（定稿时写入 `characterVoicePreview.ts` 常量，可单测长度/句数）：**

```text
// lead-male 中性（示意）
「路是自己选的，就不必再回头望。风从巷口灌进来，我把领口拢了拢，继续往灯火少的那边走。谁先认输，谁就先把今晚的话咽回去。」
```

**单测：** 默认句 ≠ 旧产品腔；字数 ≥80；句号/问号/叹号 ≥2。

---

### 4.5 design 文案：为「耳朵」写，不为「字段齐全」写

**保留：** 可解析三元（onlyMissing seed）、硬顶 200、禁明星/场景/动作、softCollision 短互斥。

**v1.1 听感规约（压过 v1.0「塞满 120–160」）：**

1. **声学可执行优先于字数达标**  
   - 宁短而尖（共鸣靠后、实声偏硬、语速偏慢、句尾轻气声）  
   - **禁止**为凑 `DESIGN_PROMPT_TARGET_MIN` 堆「吐字清楚」「气质克制」同义词  

2. **风格锚**  
   - 1 个，且必须是 **发声/语域** 可映射（法庭陈词、冷感权谋低语、市井快嘴），不是剧情身份空话  
   - 与 lead「忌播音腔」冲突的锚（如「纪录片旁白感」）**禁止用于 lead/cast 对白角色**

3. **癖好**  
   - 1 个；`SPEECH_QUIRK_BY_SLOT` 候选必须先过 `textureConflictsWithSlot` / energy 冲突表  
   - 同书同 slot 用 characterId 稳定 hash 打散  

4. **截断优先级（听感版）：**

```text
三元 core
> 卡面 voiceTexture 兼容片段（最高辨识来源）
> 1 声学癖好
> 1 风格锚/useCase（对白域）
> softCollision 互斥短句（≤16 字；冲预算可砍次句「避免播音腔」保留互斥主句）
> 禁止用 habits 灌水到 160
```

5. **单测听感代理（非人耳）：**  
   - 两角色 prompt 的「质感字面 ∪ 癖好」集合 Jaccard < 1（不完全相同）  
   - 禁止子串列表：`请听`、`合适`、明星名、`在祠堂`、`走上`  

**不改：** delivery / MIMO_USER_MAX 总预算逻辑；identity 仍为表演留余量。

---

### 4.6 Design → Clone（稳定听感 · 阶段 3 · lead 不可砍）

**官方：** design 满意 → 存音频 → voiceclone。  
**我们：** 只允许 **选优后的正式 preview**（或显式 candidateId）升格。

```text
POST .../adopt-preview-clone
前置：preview ready 且来自 adopt-candidate / 多抽 winner
行为：
  copy preview → voice-refs/.../ref.wav
  ttsMode=clone, ttsRefAudioPath=..., 保留 ttsDesignPrompt 审计
  fingerprint 变 → stale → 建议立刻用 clone 再 gen 1 条对照（可自动）
```

**产品：**

- lead：readiness 显示「建议锁定为克隆身份」  
- cast：可选  
- extra：默认隐藏  
- **禁止**半绑定 clone 无 ref  

**听感理由：** 无此步，design 每段重采样，成书质量低于试听页的「一次好运」。

---

### 4.7 明确降级项（不占 P0）

| 项 | 处理 |
|----|------|
| summary.reservedBlockedCount 等 | P2 |
| 长 UI 说明 / toast 润色 | P2；P0 仅需不误导「已保证区分」 |
| auto_legacy 双语义 | 不做；单测锁 smart_fill |
| 跨小说 Voice 表 | 仍 backlog |
| delivery 默认 on | 不做（固定试听纯身份） |

---

## 5. 阶段拆分（每一阶段必须留下「可听」增量）

### 阶段 1 — 路由 + 多抽 + 试听句（听感主闭环）

| 交付 | 验收 |
|------|------|
| smart_fill + reservedPresets | 单测；主配角不再默认共享预置 |
| preview candidates=3 + adopt-candidate | 契约测；Manual 能听 3 条选 1 |
| 新默认试听句库 + 长度门 | 单测；人耳立刻比旧句更有用 |
| prepare 走多抽初选 | 源世界/样书 gen 后可并排听 |

**提交建议：** `feat(phase-1): smart_fill, reserved presets, multi-draw preview corpus`  
**本阶段结束前必须：** 至少 1 次真网 design 多抽（可本地/production），留下 wav 路径供阶段 2 对照——**禁止空跑 mock 宣称阶段 1 听感完成**。

### 阶段 2 — design 文案声学规约

| 交付 | 验收 |
|------|------|
| quirk/锚冲突表 + 截断优先级 | 单测 |
| 弱卡不灌水 | 同书主角色 prompt 人工抽查 |
| 真网：prefer_design 或 smart_fill 重绑后多抽 | Manual §7.2 主表 |

**提交：** `feat(phase-2): acoustic design prompt constraints for ear separation`

### 阶段 3 — 选优样本 Clone 锁定

| 交付 | 验收 |
|------|------|
| adopt-preview-clone | 测 + Manual lead 锁身份后两句对照 |
| UI 引导 lead | 不误导 extra |

**提交：** `feat(phase-3): adopt selected preview as clone identity`  
**若上游 clone 不可用：** 《需人工关注》；阶段 1+2 仍可「有条件可交付」，但文档必须写清长书漂的风险。

---

## 6. 文件级改动清单

### 6.1 阶段 1（必）

| 文件 | 改动 |
|------|------|
| `audiobookVoicePlanner.ts` | smart_fill；reservedPresets；lead/cast important |
| `AudiobookVoiceAssetService.ts` | suggest 旁白 reserved；**多抽 preview / adopt candidate** |
| `characterVoicePreview.ts` | 默认句库；长度上限；fingerprint 与 max 一致 |
| `AudiobookVoiceReadinessService.ts` | prepare：`candidatesPerCharacter` 默认 3；初选 winner |
| `novelAudiobookRoutes.ts` | generate/adopt-candidate schema |
| client readiness / panel | 多候选播放与采用（最小可用） |
| tests | 上列契约 |

### 6.2 阶段 2（必）

| 文件 | 改动 |
|------|------|
| `audiobookVoicePlanner.ts` `buildDesignPromptDetailed` | 声学优先截断；禁灌水 |
| `designPromptQuirks.ts` / archetypes | 冲突表 |
| tests | Jaccard/禁词/parse |

### 6.3 阶段 3（听感稳定 · lead 必做）

| 文件 | 改动 |
|------|------|
| routes + VoiceAssetService | adopt clone |
| voiceRefPath / paths | copy |
| client | lead 按钮 |

### 6.4 不改

`MimoChatAudioTTSProvider` 协议；`deliveryStyle` 默认；prisma schema。

---

## 7. 验收

### 7.1 工程（必要但不充分）

```text
[ ] smart_fill / reserved / prefer_design 回归测绿
[ ] preview candidates 默认 3；adopt 前不覆盖旧 ready（契约）
[ ] 默认试听句：≥80 字、≥2 句末标点、≠旧产品腔
[ ] design prompt：三元可 parse；无灌水强制；冲突癖好不进 prompt
[ ] 隔离门；无「保证区分」话术
[ ] MIMO_TTS_MODELS 仍三件套
```

### 7.2 Manual 听感清单（**硬放行** · 不编造）

样书：优先《源世界》；否则同等「主配角 ≥5、有旁白」小说。

**准备：** smart_fill 或 prefer_design → 多抽 → 人耳选优固化 →（阶段 3）lead clone。

| # | 检查 | 方法 | 通过标准 |
|---|------|------|----------|
| M1 | 旁白隔离 | 听旁白句 + 任一女主/女配 | 不像同一人 |
| M2 | 男主 vs 男配 | 固定试听并排 | 音高/质感/气口至少 1 维稳定可辨 |
| M3 | 女主 vs 女配 | 同上 | 同上 |
| M4 | 声线硬度 | 单条 max 音量听 | 无持续破音；lead 不虚、不死气平板 |
| M5 | 多抽有效 | 同一角色 3 候选 | 至少能挑出 1 条明显更可用；允许 3 条都一般但须记录 |
| M6 | 试听句 | 对比旧产品腔 | 新句更能暴露声线习惯 |
| M7 | 长稳（有阶段 3） | clone 后另抽 1 句 | 身份连续，不换人 |
| M8 | 成书抽检（可选加强） | 同角色 2 章各 1 句 | 不要求完美，记录漂移 |

**记录模板（写入会话/Obsidian，禁止假填）：**

```text
日期 / tip / 小说 / 策略 / candidates
M1-M8：通过|不通过|跳过 + 一句话人耳结论
未通过项：是否阻塞交付
```

### 7.3 交付状态定义（听感优先）

| 状态 | 条件 |
|------|------|
| ✅ 可交付 | P0 工程门 + **M1–M6 通过** |
| ✅ 增强可交付 | 上 + 阶段 3 + **M7 通过** |
| ⚠️ 有条件可交付 | 工程门过、M 有失败但已记录且用户书面接受 |
| ❌ 不可交付 | 仅测绿未听；或主配角仍大面积 preset 撞车；或单抽路径仍是产品默认 |

---

## 8. 回滚

| 风险 | 动作 |
|------|------|
| 多抽打满上游 | candidates 临时降 2；**不**回到「主配角 preset」 |
| design 文案更糊 | 回退 quirk 表；保留 smart_fill + 多抽 |
| clone 升格失败 | 保持 design 选优 preview；文档标长书风险 |
| 新试听句不合适 | 换句库条目，不恢复产品 meta 句为默认 |

---

## 9. Backlog（真·非听感或后置）

1. 跨小说 Voice 资产库  
2. 声学 embedding 碰撞（永不替代 M 表）  
3. delivery 默认策略  
4. m4b / group_by_speaker 吞吐  
5. 自动全员 clone  
6. summary 装饰字段、长文案运营

---

## 10. 与既有计划

| 计划 | 关系 |
|------|------|
| 区分度 plan | 底座；本计划管 **默认听感路径与选优** |
| design-prompt-quality | 三元自然语言；本计划 **反灌水 + 冲突癖好 + 听感截断** |
| preview asset | 固定资产；本计划 **多候选与句库** |
| readiness | prepare 接入 candidates |
| delivery | 正交；固定试听不进表演 |

---

## 11. 实施检查清单

```text
阶段 1
  目标：进对模型 + 多抽可听 + 试听句能鉴声
  听感增量：M5/M6 可做；主配角离开 4 预置撞车
  修改：planner / asset preview / readiness / routes / client 最小选优 / tests

阶段 2
  目标：design 指令可执行、少矛盾
  听感增量：M2/M3/M4 改善空间
  修改：buildDesignPrompt* / quirks / tests + 真网重抽

阶段 3
  目标：lead 身份锁死
  听感增量：M7
  修改：adopt clone + UI
```

---

## 12. 一句话（v1.1）

> **听感唯一：主配角进 VoiceDesign，试听句要能鉴声，同一配置多抽由人（或可解释初选）选定后再固化，满意样本再 Clone 锁长书；旁白预留互斥。一切 UI/summary/省 token 让路。**
