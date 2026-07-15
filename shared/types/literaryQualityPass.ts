import type { QualityScore } from "./novel.js";

/** 文学 isPass 默认阈值（与现网 novelCoreShared 一致；监管契约勿改数字）。 */
export const DEFAULT_QUALITY_IS_PASS_THRESHOLD = {
  coherence: 80,
  repetition: 75,
  engagement: 75,
} as const;

export type QualityIsPassThreshold = {
  coherence: number;
  repetition: number;
  engagement: number;
};

/**
 * 文学可读门：coherence ∧ repetition ∧ engagement。
 * overall / pacing / voice 不单独决定 isPass（不机械控节奏）。
 */
export function isLiteraryQualityPass(
  score: Pick<QualityScore, "coherence" | "repetition" | "engagement">,
  threshold: QualityIsPassThreshold = DEFAULT_QUALITY_IS_PASS_THRESHOLD,
): boolean {
  return score.coherence >= threshold.coherence
    && score.repetition >= threshold.repetition
    && score.engagement >= threshold.engagement;
}
