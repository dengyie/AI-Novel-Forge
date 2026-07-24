/**
 * VoiceProfile —— L2 → L1 之间唯一的说话人契约（= CosyVoice spk2info 的冻结产物）。
 *
 * 设计纪律（对照 CosyVoice `frontend` 持有 `spk2info`）：
 *   - 一个段落的「说话人 → 音色」一旦解析，就冻结成不可变对象；
 *   - L1 SynthesisBuilder / L3 Engine 只读不改；
 *   - 取代 planner / materialize / reconcile / resolveChunkSynthesizeFields 四处
 *     各自摸 segment.ttsMode/voice/refAudioPath/style/designPrompt 的隐式约定。
 *
 * 这是「读侧门面」：决定角色卡写什么归 planner（不在本层），消费角色卡归这儿。
 * SoT: docs/plans/audiobook-synthesis-layering-refactor-design.md §4.1
 */

import type { AudiobookTtsMode } from "@ai-novel/shared/types/audiobook";

/**
 * 冻结后的说话人音色条件。null 字段的语义见各注释。
 * 一经 VoiceResolver.resolve 产出，调用方不得就地修改；需变则重生新 profile。
 */
export interface VoiceProfile {
  /** 稳定 speaker key（合并/缓存/日志用，对齐 audiobookGap.speakerKeyFromSegment） */
  speakerKey: string;
  /** 合成模态。缺省 preset。旁白仅 preset。 */
  mode: AudiobookTtsMode;
  /**
   * preset：预置音色名（须在 MIMO 预置表内）；
   * design：可空；
   * clone：可空（走 refAudioPath）。
   */
  voice: string | null;
  /** clone：已 sandbox 校验的可读参考音频路径；preset/design 为 null。 */
  refAudioPath: string | null;
  /** preset/clone 的基线 style（未叠 delivery）。 */
  baseStyle: string | null;
  /** design 的基线 designPrompt（未叠 delivery）。 */
  baseDesignPrompt: string | null;
  /** 审计来源：card | guest | narrator | library。 */
  source: VoiceProfileSource;
  /** 旁白为 true；影响 delivery 走「本句叙述」轻量通道。 */
  speakerKind: "narrator" | "character";
  /** 角色卡 id（narrator 为 null）。 */
  characterId: string | null;
  /** 展示名（审计/UI）。 */
  speakerLabel: string;
}

export type VoiceProfileSource = "card" | "guest" | "narrator" | "library";
