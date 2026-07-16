# 有声书听感与可用性 P0

**分支**：`feat/audiobook-design-prompt-quality`（基 tip cea1f2a design-prompt v1.2）  
**状态**：已完成（分支 tip，未 merge/deploy）  
**不做**：multi-backend 合并、merge/deploy、readiness 落库、响度 loudnorm 大改

## 目标

关闭全栈 review 中最高 ROI 的听感/可用性问题：说话人静默旁白、合成双路径、delivery 默认 off 导致「像念字」。

## 阶段

1. **Speaker 可见**：段级 `speakerUnresolved` + 章 stats + qualityWarnings + 标注 UI
2. **合成 SoT + delivery UX**：`resolveChunkSynthesizeFields` 始终干净 base±delivery；UI 默认 `characters` + 试听≠成书文案
3. **切句 P1 + 门禁测试**：`splitTextForTts` 硬标点优先；单测；审查停

## 验收

- 未匹配角色名落段可追踪，不静默
- 合成不盲信含「本句表演」的脏缓存串（无 delivery 时剥回 base）
- 新建任务默认角色表演；文案标明固定试听只用基线
- 相关单测绿

## Manual-required

- ≥3 主角真机试听（成书路径，characters 模式）
- 生产 cutover / merge 另令


## 交付提交

- `cb69031` feat(phase-1): surface unresolved speakers
- `e56085e` feat(phase-2): synth SoT + default characters
- `b033e90` feat(phase-3): hard punctuation split preference

验证：shared/server build 绿；audiobook 相关 node:test 109 pass。
