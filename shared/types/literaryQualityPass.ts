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

/**
 * 列表/DTO 投影：由完整文学三维算 literaryPass。
 * qualityScore（overall 列）≠ literaryPass，勿混用。
 */
export function projectLiteraryPassFromScore(
  score: Pick<QualityScore, "coherence" | "repetition" | "engagement"> | null | undefined,
  threshold: QualityIsPassThreshold = DEFAULT_QUALITY_IS_PASS_THRESHOLD,
): boolean | null {
  if (
    score == null
    || typeof score.coherence !== "number"
    || typeof score.repetition !== "number"
    || typeof score.engagement !== "number"
  ) {
    return null;
  }
  return isLiteraryQualityPass(score, threshold);
}

/**
 * 从 qualityLoop signals 投影 literaryPass（literary_score 为 SoT 时优先）。
 * status === valid → true；其余 signal status → false；无 signal → null。
 */
export function projectLiteraryPassFromQualityLoopSignals(
  signals: Array<{ artifactType?: string | null; status?: string | null }> | null | undefined,
): boolean | null {
  if (!Array.isArray(signals) || signals.length === 0) {
    return null;
  }
  const literary = signals.find((signal) => signal?.artifactType === "literary_score");
  if (!literary || typeof literary.status !== "string") {
    return null;
  }
  return literary.status === "valid";
}

/**
 * 从章行 riskFlags JSON 中解析 literaryPass（优先 qualityLoop.signals.literary_score）。
 */
export function projectLiteraryPassFromRiskFlags(
  riskFlags: string | null | undefined,
): boolean | null {
  if (!riskFlags?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(riskFlags) as {
      qualityLoop?: { signals?: Array<{ artifactType?: string; status?: string }> };
    };
    return projectLiteraryPassFromQualityLoopSignals(parsed?.qualityLoop?.signals);
  } catch {
    return null;
  }
}
