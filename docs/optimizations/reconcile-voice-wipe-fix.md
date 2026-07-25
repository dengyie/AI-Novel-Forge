# Reconcile Guest Voice Wipe Fix - 优化分析

## 改动概要
修复了 `AudiobookPipelineService.ts` 中 reconcile 阶段会错误地将未匹配的路人声线洗成旁白的问题，并优化了重复函数调用。

## 核心优化点

### 1. 性能优化：避免重复函数调用

**改动位置**：`reconcileAnnotationSegmentsWithVoices` 函数开头

```typescript
// 优化前：在多个分支中重复调用
const baseStyle = peelCompiledDeliveryMarks(input.narrator.style || null);

// 优化后：提取为变量，只调用一次
const narratorBaseStyle = peelCompiledDeliveryMarks(input.narrator.style || null);
const narratorVoice = (input.narrator.voice ?? "").trim();
```

**优化收益**：
- 减少函数调用次数，特别是在处理大量 segment 时
- 避免重复的字符串处理和标记剥离操作
- 提升代码可读性

### 2. 功能优化：保留未匹配路人的预置声线

**新增函数**：`isNamelessQuoteOrphanUnresolved`

```typescript
function isNamelessQuoteOrphanUnresolved(seg: AudiobookDialogueSegment): boolean {
  if (!seg.speakerUnresolved) return false;
  const rawName = (seg.unresolvedSpeakerName ?? "").trim();
  if (rawName) return false;
  const label = (seg.speakerLabel ?? "").trim();
  return !label || label === "旁白" || label === "narrator";
}
```

**新增分支逻辑**：在 `reconcileAnnotationSegmentsWithVoices` 中添加了对 "named unmatched passersby" 的特殊处理

```typescript
// 有名未匹配路人：materialize/ruleAssembly 已点 guest 预置。
// 旧 bug 会在此分支洗成旁白；现保留 guest，并对「声=旁白」的脏标注自愈重点。
// 仅当没有对账到角色卡时走 guest：带 characterId 且卡仍在时优先匹配清 unresolved。
const hasMatchingCard =
  Boolean(seg.characterId) && byId.has(seg.characterId as string);
if (
  seg.speakerUnresolved
  && !isNamelessQuoteOrphanUnresolved(seg)
  && !hasMatchingCard
) {
  // 保留 / 重选 guest 预置声线…
}
```

**优先级（必须）**：
1. 有 `characterId` 且卡仍在 → **角色卡匹配**（清 `speakerUnresolved`）
2. 有名 unresolved 且无卡 → **guest 保留/重选**
3. 无名旁白 orphan / 真旁白 → 旁白声

**优化收益**：
- **Bug 修复**：防止未匹配但已命名角色的声线被错误地洗成旁白
- **自愈能力**：自动检测并修复声线被错误设置为旁白的脏标注
- **智能重选**：仅在必要时才重新选择 guest 预置声线
- **表演一致性**：路人使用 `narrator kind + unresolved` 承载，禁止串戏 delivery

### 3. 数据一致性优化：Orphan 标记清理

**改动位置**：orphan 处理分支

```typescript
// 优化后：显式清理 unresolved 标记
speakerUnresolved: false,
unresolvedSpeakerName: null,
```

**优化收益**：
- 确保失去角色的 orphan 不会保持 unresolved 状态
- 避免数据不一致导致下游逻辑误判
- 符合业务语义：已确定为 orphan 的对话不应再被视为 unresolved

## 影响范围

### 直接影响
1. **未匹配路人生成**：现在会正确保留 guest 预置声线，不再被洗成旁白
2. **Orphan 检测**：更准确地识别需要登记的 orphan
3. **性能**：减少了重复的 `peelCompiledDeliveryMarks` 调用

### 间接影响
1. **声线一致性**：避免同一角色在不同段落使用不同声线
2. **用户体验**：减少因声线突变导致的听觉困惑
3. **调试追踪**：更清晰的状态标记有助于问题排查

## 依赖项

新增了对以下模块的依赖：
- `guestStyleForUnresolvedName` - 从 `./diarize/guestVoice` 导入
- `pickGuestPresetVoice` - 从 `./diarize/guestVoice` 导入

## 测试建议

1. **功能测试**：
   - 测试未匹配命名角色的声线保留
   - 测试脏标注自愈能力
   - 测试 orphan 检测准确性

2. **回归测试**：
   - 确保现有旁白生成逻辑不受影响
   - 确保正常角色匹配逻辑正常工作

3. **性能测试**：
   - 对比大量 segment 处理时的性能提升

## 深度修复（review 收口）

| 项 | 改动 |
|---|---|
| P1 警告文案 | `已用旁白音色` → 有名：`路人预置音色`；仅 orphan：`未命名对白/旁白声回退` |
| P2 过期 characterId + unresolved | guest 保留声线，**同时** `noteOrphanCharacter` |
| P2 nameless 判定 | `unresolvedSpeakerName∈{旁白,narrator}` 也算 nameless；helper 上提到 `guestVoice.ts` |
| P2 speakerKey | 有名 guest → `guest:<name>`，无名 orphan/真旁白 → `narrator` |
| P2 resolver source | 有名 guest → `guest`；nameless orphan → `narrator`（声线一致） |
| 公共 SoT | `isNarratorLikeSpeakerLabel` / `isNamelessQuoteOrphanUnresolved` / `namedGuestSpeakerName` |

## 相关任务
- #94 Fix reconcile guest voice wipe ✅
- #95 Fix unresolved 旁白 in warnings ✅
- #96 Run audiobook regression tests ✅
- #97–#100 深度修复 + 边界单测 ✅
