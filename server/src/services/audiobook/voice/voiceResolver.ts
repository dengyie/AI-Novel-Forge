/**
 * VoiceResolver —— L2 Voice 层的「读侧门面」（= CosyVoice spk2info 的解析器）。
 *
 * 定位（对照 docs/plans/audiobook-synthesis-layering-refactor-design.md §4.1 / §7 M5）：
 *   - 把一个段（已经过 `materializeAnnotationSegments` / `reconcileAnnotationSegmentsWithVoices`
 *     绑定）解析成**冻结的 `VoiceProfile`**，供 L1 SynthesisBuilder 一次消费；
 *   - 绑定优先级在此「一处」显式定义：
 *       *已有完整 clone(ref) > 角色卡 mode(preset/design/clone) > guest 路人预置 > narrator 兜底*
 *     —— 对齐旧 reconcile/materialize 的隐式约定。
 *   - 取代 M3 SynthesisBuilder 内的 ad-hoc `inferVoiceProfileSource` 临时映射。
 *
 * 收编范围（M5）：
 *   - 段绑定字段 → `VoiceProfile` 的读侧映射（mode/voice/ref/base/source/speakerKey…）。
 *   - 写侧（决定角色卡内容）仍归 planner/library/brief，不在此层。
 *
 * 回滚：旧 `reconcileAnnotationSegmentsWithVoices` / `materializeAnnotationSegments` 留存，
 *   它们产出的 bound segment 喂给 `resolveVoiceProfileForSegment` 即等价于旧链路。
 *
 * SoT: docs/plans/audiobook-synthesis-layering-refactor-design.md §4.1 / §7 M5
 */

import type { AudiobookTtsMode } from "@ai-novel/shared/types/audiobook";
import type { AudiobookDialogueSegment } from "@ai-novel/shared/types/audiobook";
import { speakerKeyFromSegment } from "../audiobookGap";
import type { VoiceProfile, VoiceProfileSource } from "./voiceProfile";

/** normalize 段 ttsMode 到合法 AudiobookTtsMode（与旧链路一致：缺省 preset）。 */
function normalizeTtsMode(raw: string | null | undefined): AudiobookTtsMode {
  const trimmed = raw?.trim();
  return trimmed === "design" || trimmed === "clone" ? trimmed : "preset";
}

/**
 * 绑定优先级 → VoiceProfileSource 的显式映射。
 *
 * 优先序（对齐旧 materialize/reconcile 的隐式约定）：
 *   1) narrator：`speakerKind === "narrator"` → source `"narrator"`
 *      （旁白恒 preset；orphan 角色在 reconcile 阶段已被强制降级为 narrator，故走此分支）
 *   2) guest：未对账到角色卡的 `character` 段（`speakerUnresolved === true`）→ source `"guest"`
 *      （materialize 阶段点路人预置音色；style 亦为路人基线）
 *   3) card：对账到角色卡的 `character` 段 → source `"card"`
 *   （`"library"` 预留给未来 VoiceLibrary 注入的 clone ref；现链路暂无生产 caller）
 */
function resolveVoiceProfileSource(segment: AudiobookDialogueSegment): VoiceProfileSource {
  if (segment.speakerKind === "narrator") {
    return "narrator";
  }
  if (segment.speakerUnresolved) {
    return "guest";
  }
  return "card";
}

/**
 * 段（reconcile/materialize 后的绑定视图）→ 冻结 `VoiceProfile`。
 *
 * 这是 L2 → L1 的唯一说话人契约出口：
 *   - 一次解析，调用方只读不改；
 *   - 所有字段直接读绑定结果，不再二次决策 mode/voice/ref；
 *   - delivery 不在此层处理（由 L1 SynthesisBuilder 一次编译进 base 字段）。
 *
 * 与旧的等价性（M5 golden 门）：本函数产出的 `mode/voice/refAudioPath/baseStyle/
 * baseDesignPrompt/characterId/speakerLabel/speakerKey/source` 与旧 reconcile/materialize
 * 写入 segment 的对应字段、以及 M3 builder 内 `inferVoiceProfileSource` 的映射逐字段一致。
 */
export function resolveVoiceProfileForSegment(
  segment: AudiobookDialogueSegment,
): VoiceProfile {
  return {
    speakerKey: speakerKeyFromSegment(segment),
    mode: normalizeTtsMode(segment.ttsMode),
    voice: segment.voice?.trim() || null,
    refAudioPath: segment.refAudioPath?.trim() || null,
    baseStyle: segment.baseStyle ?? null,
    baseDesignPrompt: segment.baseDesignPrompt ?? null,
    source: resolveVoiceProfileSource(segment),
    speakerKind: segment.speakerKind === "character" ? "character" : "narrator",
    characterId: segment.characterId ?? null,
    speakerLabel: segment.speakerLabel,
  };
}

export interface VoiceResolver {
  resolve(segment: AudiobookDialogueSegment): VoiceProfile;
}

/** 默认实例：直接委派 `resolveVoiceProfileForSegment`。便于将来注入缓存/库门。 */
export const defaultVoiceResolver: VoiceResolver = {
  resolve: resolveVoiceProfileForSegment,
};
