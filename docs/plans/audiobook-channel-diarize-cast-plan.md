# 有声书 · 通道感知说话人分割 + 角色音色分配

> 状态：**v1.0 实施中**（Phase 0–1 落地；Phase 2+ 登记）· 2026-07-23  
> 依据：源世界 v2 ch1 实产（引号 recall 低、手机打字被念、整章旁白回退仍 `succeeded`）  
> 正交：`audiobook-character-voice-differentiation-plan.md`（卡上音色差）· `audiobook-segment-delivery-style-plan.md`（段表演）

---

## 0. 目标

把「能出音频」升级为「能出对的有声书」：

1. **通道优先**：先判出声/通道，再判说话人  
2. **Diarize 与 Delivery 拆域**：delivery 挂死不得整章旁白  
3. **skip 通道不进 TTS**（typed / 默认 chat / on_screen）  
4. **假成功禁止**：整章旁白兜底不得宣称 cast 成功  

---

## 1. 领域模型

### 1.1 segmentKind

`speech | narration | typed | chat | on_screen | phone | broadcast | inner | quote_read | sfx_cue`

### 1.2 renderPolicy

`tts | tts_neutral | skip | beep`

默认：

| kind | policy |
|---|---|
| speech / narration / phone / broadcast / inner / quote_read | tts |
| typed | **skip** |
| chat / on_screen | **skip**（可配置） |
| sfx_cue | skip |

### 1.3 章级 diarizeStats

`quoteSpanCount / quoteCoveredCount / quoteCoverage / typedSkippedCount / chatSkippedCount / wholeChapterNarratorFallback / castOk / failReasons`

### 1.4 兼容

旧 annotation 无 `segmentKind`：按 `speakerKind` 推断 `speech|narration`，`renderPolicy=tts`。

---

## 2. 管线

```text
Rule Span Pass → Diarize (L0 LLM / L1 rules / L2 chunk / L3 narrator)
  → Cast resolve → coverage gate → Delivery(optional) → TTS(filter skip)
  → task qualityFlags + label
```

Fallback 阶梯：

- **L0** LLM diarize（Phase 2）  
- **L1** Rule assembly（Phase 1，产品化人工注入路径）  
- **L2** 分块 diarize（Phase 3）  
- **L3** 整章旁白 + `wholeChapterNarratorFallback=true`（不得 castOk）

---

## 3. 质量门禁

### 3.1 castOk（默认阈值）

- `wholeChapterNarratorFallback === false`
- `spokenQuoteCoverage >= 0.85`（无应出声 quote 时豁免）
- unresolved / speechCharacter ≤ 0.15（无角色段豁免）

### 3.2 任务语义

- `qualityFlags`: `narrator_fallback` | `low_quote_coverage` | `high_unresolved` | `cast_ok` | `cast_degraded`
- 完成文案强制区分「多角色」vs「降级：N 章旁白回退 / 覆盖不足」
- 一期仍用 `status=succeeded` + flags/label（避免破坏旧客户端）；strict fail-closed 留 Phase 2 配置项

---

## 4. 分阶段

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | wholeChapterNarratorFallback、qualityFlags、完成标签、短句 normalize | **done** |
| 1 | 类型扩展、ruleSpanPass、L1 assembly、expand 过滤 skip、typed 不念 | **done** |
| 2 | 专用 `audiobook.chapter.diarize@v1`（先于 annotate）；失败 → annotate → rules → narrator | **done（本批）** |
| 2.1 | delivery 独立 job（diarize 成功后再填表演；缓存指纹拆分） | backlog |
| 3 | 分块 L2、路人 temp_preset、Patrol 扩展、队列 HA | backlog |
| 4 | 标注可视化、alias 快捷、通道渲染开关 UI | backlog |

> Phase 2 说明：主路径先跑 diarize（无 delivery 字段）。成功则段上 delivery 为空，`deliveryStyleMode` 快照仍记用户请求值。表演二段式见 2.1。

---

## 5. 验收（源世界 ch1）

- [x] 单测：rule span / typed skip / coverage / fallback 标记 / chunk filter（`server/tests/audiobookChannelDiarize.test.js`）
- [x] spokenQuoteCoverage 可计算且 L1 明显高于整章旁白（pxed 规则装配：spokenQuoteCoverage≈0.993 vs 整章旁白 0）
- [x] chat/typed/on_screen 进 skip 段（pxed 注入：typed=2 chat=6 on_screen=2；TTS jobs 不含「截图发你了」「对方正在输入」）
- [x] 重合成整章 wav/m4b 完成并可听验（task `cmrwokz840000l39kjhks1p55` **succeeded**；229/229；`chapter.wav` + `full-book.wav` + `full-book.m4b` ready）
- [x] 降级文案含「降级」（本任务 label：`完成（降级：1 章旁白回退，含 m4b）`；注：`wholeChapterNarratorFallback=false`，实为 L1 rules + `castOk=false`/`unresolved_ratio`，文案偏粗，待收紧）

### 5.1 实产注记（2026-07-23）

- diarize prompt 漏注册：`audiobook.chapter.diarize@v1` 已补 `prompting/registry.ts`（`1aa02c4`）
- resynthesize 缓存失效条件：`deliveryStyleMode` 必须与任务一致（characters），且 `contentSha1` 对齐
- L1 规则路径 speaker 归属仍弱（大量 speech 落旁白 / 误切「笑着」等）→ 听感上角色差仍依赖后续 L0 diarize 或规则加强；本验收优先验证 **skip 通道不念**
- ch1 规则路径终验（task `cmrwokz840000l39kjhks1p55`）：
  - `assemblySource=rules`，`deliveryStyleMode=characters`，`contentSha1=02d08381ae989c31`
  - segments 414 / skip 10（typed2+chat6+on_screen2）；spokenQuoteCoverage≈0.9926；castOk=false（unresolved_ratio 0.53）
  - 关键 skip 在 skip 段：「截图发你了」「对方正在输入」「收到」；「在吗」仍可能出现在 TTS 段（叙述语境）
  - 产物：`full-book.wav` ~146MB、`full-book.m4b` ~35MB、`chapters/.../chapter.wav`  

---

## 6. 关键文件

```text
docs/plans/audiobook-channel-diarize-cast-plan.md
shared/types/audiobook.ts
server/src/services/audiobook/diarize/ruleSpanPass.ts
server/src/services/audiobook/diarize/ruleAssembly.ts
server/src/services/audiobook/diarize/diarizeQualityGate.ts
server/src/services/audiobook/diarize/ttsTextSanitize.ts
server/src/services/audiobook/audiobookChunk.ts
server/src/services/audiobook/AudiobookAnnotationService.ts
server/src/services/audiobook/AudiobookTaskService.ts
server/tests/audiobookChannelDiarize.test.js
```

---

## 7. 明确不做（本 PR）

- 专用 diarize LLM prompt 全量上线（Phase 2）  
- 改 DB schema / 任务 status 枚举扩展  
- drama TTS / 写文线  
- ASR 反标 / 声学聚类  
