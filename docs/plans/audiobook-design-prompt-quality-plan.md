# 有声书 · Design Prompt 质量（Voice Design 文案升级）开发计划

> 状态：**实现完成（2026-07-17）** · 分支 `feat/audiobook-design-prompt-quality` @ 待交付 tip · **未 merge / 未部署**  
> 前置已上线：音色区分度 + 分簇 v2（`8acd1a6`）+ 工作台 UI（`dcfc946`）+ multi-backend fallback 分支 `8b31fcb`（**并行、不叠合**）  
> 调研依据：MiMo-V2.5-TTS 官方样例、阿里 CosyVoice/Qwen Voice Design 七维原则、ASLP VoiceSculptor 中文规范、TTS-Story/RoleBank 形态对照  
> 产品 SoT：Obsidian `ainovel 小说转有声书 产品形态` · 协议：`ainovel 小说转有声书 TTS 经验`  
> 工程基线：`server/src/services/audiobook/audiobookVoicePlanner.ts` 的 `buildDesignPrompt` / `planCharacterVoices`  
> 相邻硬约束：`deliveryStyle.ts` 的 `MIMO_USER_MAX=280`（identity + 表演 + guard 总预算）  
> 本计划 **只改身份 design 文案质量与可维护模板**，不换供应商、不新建 Voice 表、不通读正文、不碰写文线。

### 冻结决议（2026-07-17 · v1.1 修订）

| # | 项 | 决议 |
|---|---|---|
| 1 | 句式 | **3.A 自然语言一段** + 短互斥尾句（**不**保留【身份】【声线】等标签主结构） |
| 2 | 长度 | **`DESIGN_PROMPT_MAX = 200`**；**目标 120–160**（280 是 MIMO user **总**预算，非 identity 独占） |
| 3 | 可解析锚点 | 句中**强制**嵌入现网 `音高{PITCH_ZH}` / `质感{TEXTURE_ZH}` / `气息{ENERGY_ZH}` 字面；旧【声线】仍兼容 |
| 4 | 范围 | **阶段 1+2+3 全做**（组装 + archetype + UI 展开 + 文档） |
| 5 | 分支 | 从 **main（生产 tip 以索引为准，曾 `dcfc946`）** 拉 `feat/audiobook-design-prompt-quality`；**不**叠 multi-backend |
| 6 | Manual 样书 | **任意样书** ≥3 主角色并排试听（不强制源世界） |
| 7 | buildStyle | **默认不动** preset style 路径 |
| 8 | UI | 规划草稿 design **默认截断 80 + 可展开全文**（阶段 2） |
| 9 | 专名 | identity **默认不写角色专名**；role 短标签可保留 |
| 10 | softCollision | 互斥**首句** hard-keep；次句/气质/archetype 可截 |
| 11 | 回退 | 阶段 1 若 fixture parse 明显退化或人工试听明显更糊 → 停阶段 2，回退 3.B/3.C |

---

## 0. 执行契约（Codex · 已冻结 v1.1）

```text
Milestone：Design Prompt 质量（卡驱动 VoiceDesign 文案 v2）
目标：
  1) 角色卡 → ttsDesignPrompt 升级为自然语言多维句（§3.A），服务 MiMo design（user=designPrompt）
  2) 保留分簇 v2 与槽位防撞（lead/cast design + minSep；extra/narrator preset）
  3) 固定试听仍是唯一听感验收门；不写「听感已区分」产品话术
  4) 单测可回归：可解析三元、长度≤200、互斥、槽位扰动不自相矛盾、clone skip、parse 双格式
  5) identity 为 delivery 合并预留余量（MIMO_USER_MAX=280）

P0：
  - 重写 buildDesignPrompt → 3.A；DESIGN_PROMPT_MAX=200；目标 120–160
  - 句中强制 音高/质感/气息 = 现网 PITCH_ZH / TEXTURE_ZH / ENERGY_ZH
  - 保留 slot / cluster / softCollision 输入契约；lead 忌死气；soft 互斥首句 hard-keep
  - parseSlotFromDesignPrompt：旧【声线】+ 新自然语言（含上列字面）；失败 → null → seed:inferred
  - 单测迁移：删【声线】硬匹配 → 三元可解析 + 长度常量 + 两角色用词可辨 + 旧 bound 仍 parse
  - 不改 Mimo 请求协议；不改 delivery 业务默认

P1：
  - designPromptArchetypes.ts（先 ~24 条中文种子，上限 40）；仅弱卡补质感短语，不盖 slot
  - summary 可选 designPromptAvgLen / archetypeHitCount（可砍，非阻断）
  - 工作台草稿：design 截断 80 + 展开全文
  - 本 plan 收口 + Obsidian TTS 经验「design 文案原则」

不做的 P2/P3：
  - 多厂商 UI；旁白 design/clone；声学 A/B；通读正文；Profile
  - delivery 长笔记写入 identity；明星模仿；新 Prisma 字段
  - 叠 multi-backend 同分支；编造听感
  - 改 prefer_design / 分簇策略矩阵；改 buildStyle（除非另令）

Manual-required：
  - 任意样书：prefer_design → apply → 就绪/重生 preview → 人工并排听 ≥3 主角色
  - 可选：同角色旧/新 prompt 对比（只记用户结论）

阶段上限：3
  1) buildDesignPrompt 3.A + parse 双格式 + 单测迁移
  2) archetype(~24) + 可选 summary + UI 展开
  3) 文档/Obsidian + 审查收口
验收：§7
停止：P0/P1 完成；或阶段用尽；或 MiMo 对新句式明显退化 → 人工报告
禁止：自动下一 milestone；为声学分析开新阶段
```

---

## 1. 问题与动机

### 1.1 现状（代码锚点）

当前 `buildDesignPrompt`（`audiobookVoicePlanner.ts`）输出类似：

```text
【身份】青年男性，叙事身份：主角「林某某」
【声线】音高中等，质感中性干净，气息平稳克制，…
【气质】…
【表达】语速中等…中文普通话
【互斥】与同书其他角色…
【禁止】不要模仿旁白…
```

优点：可解析、可截断、与 slot 绑定、互斥显式。  
问题（对照调研）：

| 点 | 现状 | 业界/MiMo 官方 |
|----|------|----------------|
| 句式 | 标签块 + 工程词（音高/质感/气息） | 自然语言「像给配音导演的描述」 |
| 维度 | 3 槽 + 可选 texture | 七维：性别年龄音调语速情绪质感场景 |
| 场景 | 「适合小说对白」偏泛 | 纪录片旁白 / 角色对白 / 广播 等具体 use case |
| 缺卡 | 空 personality → 模板同质 | archetype / 人设种子补全 |
| 互斥 | 中文指令「可辨」 | 有用但应短；主信号应是声线本身可执行 |
| 长度 | max 480 | VoiceSculptor ≤200；Cosy ≤500；实践 40–120 字常更稳；**本项目 identity 须让出 delivery 余量** |

### 1.2 产品一句话

**在不动协议与分簇策略的前提下，把 design 的 user 文案升级成「多维、可听、可防撞、可 seed 解析」的中文 Voice Design 句，仍只读角色卡。**

### 1.3 成功标准（可验证）

| 类型 | 标准 |
|------|------|
| 工程 | 单测绿；prefer_design 仍 lead/cast design、extra/narrator preset |
| 文案 | **自然语言一段**；句中含 **音高/质感/气息** 现网中文表；年龄/性别/use case/气质中 ≥4 维可读 |
| 长度 | identity ≤ **200**；典型样例落在 **120–160** |
| 防撞 | 同性别两角色 slot 不同 → 文案中音高/质感用词不同；softCollision 时出现「区别于…」类短句（首句 hard-keep） |
| seed | 新旧 prompt 均可被 `parseSlotFromDesignPrompt` 解析成功（fixture）；失败路径仍安全 |
| 听感 | Manual：**任意样书** ≥3 主角色并排试听，用户主观「比旧版更好区分或至少不更差」——**不编造** |

---

## 2. 与既有能力边界

```text
身份音色（本计划）     → Character.ttsDesignPrompt / preset / clone
段级表演（已上线）     → deliveryStyle；MIMO_USER_MAX=280；禁止把长导演笔记写进 identity
固定试听（已上线）     → preview.wav 门禁；apply 后 stale 逻辑不改语义
multi-backend fallback → 端点链；与文案正交
分簇 v2（已上线）      → resolveVoiceCluster + minSep；本计划只消费 cluster/slot
onlyMissing seed       → parseSlotFromDesignPrompt 字面三元；失败 seed:inferred
```

**隔离白名单**

```text
server/src/services/audiobook/audiobookVoicePlanner.ts
server/src/services/audiobook/designPromptArchetypes.ts   # 新建：种子表纯数据
server/tests/audiobookVoicePlanner.test.js
server/tests/designPromptQuality.test.js                 # 新建可
client/src/pages/novels/components/NovelAudiobookPanel.tsx  # 仅草稿展开/文案
shared/types/audiobook.ts                                # 仅当加 optional summary 字段
server/src/services/audiobook/AudiobookVoiceAssetService.ts # 仅 summarizePlan 透传可选字段
docs/plans/audiobook-design-prompt-quality-plan.md
（可选）Obsidian TTS 经验 / 产品形态交叉链
```

**黑名单**：`services/novel/**`、Prisma migrate、deliveryStyle 业务默认 / `MIMO_USER_MAX` 语义大改、Pipeline 合成路径、Mimo 协议字段、multi-backend 同 PR。

---

## 3. 目标句式（冻结）

### 3.A **已选（冻结 v1.1）**：**自然语言一段 + 可解析三元锚点 + 短互斥尾句**

句式包装自由，**slot 中文不可自由换词**：

```text
{年龄标签}{性别}，标准普通话，音高{PITCH_ZH}，质感{TEXTURE_ZH}，气息{ENERGY_ZH}，
{可选：语速/气质一句}，适合{useCase}。
{可选：与「邻居槽描述」明显区分；避免播音腔与空壳标准声。}
```

**与现网表对齐（实现必须用同一常量）：**

| 维 | 词表 |
|----|------|
| 音高 | 偏高 / 中等 / 偏低 |
| 质感 | 明亮清脆 / 中性干净 / 偏低略沙哑 / 偏气声轻柔 |
| 气息 | 活泼有弹性 / 平稳克制 / 沉稳有分量 |

**示例（主角 lead）**

```text
青年男性，标准普通话，音高中等，质感明亮清脆，气息沉稳有分量，吐字利落有主心骨，适合都市修真男主对白。与同书沙哑低沉角色明显区分；避免软糯甜感和播音腔。
```

**示例（反派 cast）**

```text
中年男性，标准普通话，音高偏低，质感偏低略沙哑，气息沉稳有分量，语速偏慢句尾压低，气质阴冷从容，适合权谋反派对白。避免尖锐尖叫与卡通感。
```

> 注：示例**不写专名**；「音调/音色」等口语可作修饰，但 **parse 成功依赖「音高…质感…气息…」子串**。

### 3.B 备选：**保留 【声线】标签块**

工程解析友好；听感可能略「说明书」。仅阶段 1 失败回退。

### 3.C 折中

主输出自然语言 + 文末 `[slot:…]`（默认不 strip）。**本轮不实现**，除非 3.A 锚点路径失败。

> **已冻结为 3.A + 强制三元锚点。** B/C 仅回退备选。

---

## 4. 算法设计

### 4.1 输入（不变）

`character` 卡字段 + `gender/age/slot/cluster` + `softCollision/neighbor`（现有 `planCharacterVoices` 已有）。

### 4.2 维度填充优先级

| 维 | 来源优先级 |
|----|------------|
| 性别/年龄 | `inferGenderBucket` / `inferAgeBucket` → 中文标签 |
| 音高 | `slot.pitchBand` → **PITCH_ZH 字面**（槽位优先，防撞 + parse） |
| 质感 | **TEXTURE_ZH 字面** +（无冲突时）`voiceTexture` 极短片段 |
| 气息/能量 | **ENERGY_ZH 字面**；lead 禁止「死气平板」类措辞；slot 侧 lead even→heavy 行为保留 |
| 气质 | personality / firstImpression / role 压缩；**不写专名** |
| 场景 use case | cluster + role 启发：男主对白 / 反派对白 / 配角对白… |
| 口音 | 默认「标准普通话」；卡面方言线索覆盖（弱，可后置） |
| 互斥 | 短句；softCollision 时 **首句**「明显区别于{neighbor}」**不可丢** |
| archetype | 仅当 `voiceTexture` 空且 personality 弱时，补 1 个质感短语（**不盖** 三元锚点） |

### 4.3 截断

- `DESIGN_PROMPT_MAX`：**200（冻结）**  
- 组装目标：**120–160**（优先自然完整，非硬凑满）  
- 丢弃顺序：archetype 附加 → 气质细节 → 互斥**次**句 → use case 缩短 → 仍超长则压气质/use case  
- **hard-keep**：`性别年龄 + 音高/质感/气息三元 + softCollision 互斥首句`  
- **禁止** identity 顶满 280 再靠 delivery 层砍前缀

### 4.4 `parseSlotFromDesignPrompt`

1. **旧格式**：`【声线】` 行内 `音高{PITCH_ZH}` / `质感{TEXTURE_ZH}` / `气息{ENERGY_ZH}`  
2. **新格式**：全文 `includes` 同上三元（顺序不强制相邻）  
3. 可选别名：`音调偏高` 等 **不**替代 `音高…` 主路径；实现以现网字面为准  
4. 缺任一维 → `null` → onlyMissing `seed:inferred`（安全，不崩溃）

### 4.5 Archetype 种子表（P1）

新建 `designPromptArchetypes.ts`：

```text
id, gender, age, cluster?, roleHints[], texturePhrase, energyBias?, useCase
```

规模：**先 ~24 条**，上限 40；覆盖男主/女主/反派/军师/老人/少年/弱特征配角等。  
选择：`match score = gender + age + role 关键词 + cluster`；同分取表序稳定项。  
**禁止**明星名；**禁止**覆盖 slot 三元。

### 4.6 与 prefer_design / auto / delivery

- **策略矩阵不改**（分簇 v2 已冻结）  
- 仅替换 design 文案生成；`buildStyle` **不动**  
- delivery 仍独立合并；identity 长度已按 `MIMO_USER_MAX` 预留

---

## 5. 阶段拆分

### 阶段 1 — Prompt 组装 v2 + parse + 测试（P0）

**目标**：`buildDesignPrompt` 输出 3.A；三元可解析；槽位/互斥/lead 规则保留。

**改动**：

- `buildDesignPrompt` 重写；导出 `DESIGN_PROMPT_MAX`（或同文件常量供测引用）  
- `parseSlotFromDesignPrompt` 双格式  
- 单测迁移（工作量主体）：  
  - 删/改所有 `【声线】` 硬匹配 → 三元可解析断言  
  - `≤480` → `≤ DESIGN_PROMPT_MAX`（200）  
  - 新旧 parse round-trip；softCollision；lead 忌死气；两角色用词可辨；clone skip；策略矩阵  

**验证**：`pnpm -C server run build` + 相关 test + tsc。  
**提交**：`feat(phase-1): design prompt natural multi-dimension builder`

### 阶段 2 — Archetype + UI 展开（P1）

**目标**：弱卡不空壳；用户能在工作台读全文案。

**改动**：

- `designPromptArchetypes.ts` + 选择函数（~24）  
- `summarizePlan` / types：可选 `designPromptAvgLen` / `archetypeHitCount`（可砍）  
- `NovelAudiobookPanel`：design 草稿 80 截断 + 「展开/收起」  

**验证**：archetype 命中稳定单测；client 类型检查。  
**提交**：`feat(phase-2): design prompt archetypes and full-text draft UI`

### 阶段 3 — 文档与收口（P1）

**目标**：SoT 可查；审查通过；停止。

**改动**：

- 本 plan 状态 → 实现完成  
- Obsidian：`ainovel 小说转有声书 TTS 经验` 增加「design 文案原则」+ 链到本 plan  
- production-code-quality-review 本分支增量  

**不做**：生产部署；真网 A/B；改旧「区分度 plan」全文状态（可 backlog 一行「文档陈旧」）。

---

## 6. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 新句式 MiMo 听感变差 | 固定试听对比；git 回滚 `buildDesignPrompt` |
| parseSlot 失败增多 | 强制三元字面 + 双格式；失败 seed:inferred |
| identity 过长挤掉 delivery | max 200 + 目标 120–160 + 单测 |
| 试听 base ≠ 成书 user | identity 预留余量，避免顶满 280 |
| archetype 同质 | 分性别年龄；slot 三元仍主控 |
| 单测大面积红 | 阶段 1 把迁移列为主工作量，非附带 |

回滚：还原 `buildDesignPrompt` + parse + 删 archetype；角色卡已写入的 prompt **不**自动回写（用户可再点重新差异化）。

**阶段 1 失败触发器（停阶段 2）：**

```text
fixture 上新句式 parse 成功率明显低于旧【声线】路径
或 人工试听主观「明显更糊 / 更同质」
→ 回退 3.B 或 3.C，输出《需人工关注报告》
```

---

## 7. 验收清单

```text
[ ] 白名单 diff；audiobook 路径无 CharacterVisibleProfile
[ ] prefer_design：lead/cast → design；extra/narrator → preset
[ ] buildDesignPrompt：自然语言；含音高/质感/气息现网字面；长度 ≤200
[ ] 典型样例多落在 120–160（抽检/单测辅助）
[ ] parse 旧【声线】与新自然语言均成功；失败不崩溃
[ ] softCollision 含「区别于」类首句；lead 无死气/平板默认
[ ] 两角色 slot 不同 → 中文音高/质感用词不同
[ ] UI 可展开完整 design 文案（阶段 2）
[ ] Manual：任意样书 ≥3 主角色试听结论由人记录
[ ] 不编造听感；产品文案无「已保证区分」
```

---

## 8. 明确不做（复述）

- 多厂商；旁白 design；声学碰撞检测；正文挖声线  
- 把 MiMo 官方「整页导演笔记」写入 Character 身份  
- identity 独占 280 / 顶满 MIMO user  
- 本里程碑强制 merge multi-backend 或生产 cutover  
- 改分簇 / prefer_design 策略；默认打开 delivery  

---

## 9. 决议记录

| 问 | 决 | 时点 |
|----|----|------|
| 句式 | **A 自然语言** | 2026-07-17 |
| 长度（初） | 280 | 2026-07-17 初冻 |
| 长度（修订） | **硬顶 200，目标 120–160**（服务 delivery 总预算 280） | 2026-07-17 review |
| 可解析 | **强制 音高/质感/气息 + 现网中文表** | 2026-07-17 review |
| 范围 | **阶段 1+2+3** | 2026-07-17 |
| UI 展开 | **要**（截断+展开；复制非必须） | 2026-07-17 |
| buildStyle | **不动** | 2026-07-17 |
| 分支 | **main → feat/audiobook-design-prompt-quality** | 2026-07-17 |
| Manual | **任意样书 ≥3 主角色** | 2026-07-17 |
| 专名 | **默认不写** | 2026-07-17 review |
| archetype 条数 | **先 ~24，上限 40** | 2026-07-17 review |

仍可在实现中微调、不改契约的：展开 UI 控件样式、use case 中文措辞、archetype 具体条目文案。

---

## 10. 开工路径（待你说「开始做」）

```text
git checkout main && pull → 拉 feat/audiobook-design-prompt-quality
→ 阶段 1：buildDesignPrompt 3.A + 三元锚点 + parse 双格式 + 单测迁移 → 审查 → commit
→ 阶段 2：archetype(~24) + 可选 summary + UI 展开 → 测 → commit
→ 阶段 3：Obsidian/plan 收口 + 审查 → 《项目交付总结》停止
→ 你令后再 merge / 部署 / Manual 听感
```

**阶段 1–3 已实现并提交。** merge / 部署 / Manual 听感另令。

---

## 11. 实现记录（2026-07-17）

| 阶段 | Commit | 内容 |
|------|--------|------|
| 1 | `6f02a89` | `buildDesignPrompt` 自然语言 + `DESIGN_PROMPT_MAX=200` + 单测迁移 |
| 2 | `c47c69f` | `designPromptArchetypes` ~24 + summary 可选字段 + UI 展开全文 |
| 3 | （本收口） | plan 状态完成 + Obsidian TTS 经验「Design 身份文案原则」+ 整体审查 |

验证：`pnpm -C shared/server build`；`node --test` planner+quality **36/36**；client `tsc --noEmit` 通过。
