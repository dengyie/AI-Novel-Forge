import type { QualityScore } from "./novel.js";
import {
  DEFAULT_QUALITY_IS_PASS_THRESHOLD,
  isLiteraryQualityPass,
  type QualityIsPassThreshold,
} from "./literaryQualityPass.js";

export type RepairContentAdoptKind = "adopt" | "discard" | "plateau_stop";

export interface RepairContentAdoptInput {
  baselineScore: QualityScore;
  candidateScore: QualityScore;
  /** baseline 已有的 L0 blocking codes（high/critical） */
  baselineBlockingCodes: string[];
  /** candidate 的 L0 blocking codes */
  candidateBlockingCodes: string[];
  /** 本决策前已连续无改进次数（discard / plateau） */
  consecutiveNoImprove?: number;
  /** 连续无改进上限，默认 2 */
  plateauMaxNoImprove?: number;
  /** overall 允许下降量，默认 0（不得低于 baseline） */
  overallDelta?: number;
  isPassThreshold?: QualityIsPassThreshold;
}

export interface RepairContentAdoptResult {
  decision: RepairContentAdoptKind;
  reason: string;
  scoreDelta: {
    overall: number;
    coherence: number;
    repetition: number;
    engagement: number;
  };
  introducedBlockingCodes: string[];
  baselineLiteraryPass: boolean;
  candidateLiteraryPass: boolean;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function introducedCodes(baseline: string[], candidate: string[]): string[] {
  const base = new Set(baseline);
  return uniqueStrings(candidate.filter((code) => !base.has(code)));
}

/**
 * 自动修文可用性评估：candidate 相对 baseline 是否可采纳。
 * 纯函数；不落库。
 */
export function decideRepairContentAdoption(
  input: RepairContentAdoptInput,
): RepairContentAdoptResult {
  const threshold = input.isPassThreshold ?? DEFAULT_QUALITY_IS_PASS_THRESHOLD;
  const overallDelta = input.overallDelta ?? 0;
  const plateauMax = input.plateauMaxNoImprove ?? 2;
  const consecutiveNoImprove = Math.max(0, input.consecutiveNoImprove ?? 0);

  const baselineLiteraryPass = isLiteraryQualityPass(input.baselineScore, threshold);
  const candidateLiteraryPass = isLiteraryQualityPass(input.candidateScore, threshold);
  const scoreDelta = {
    overall: input.candidateScore.overall - input.baselineScore.overall,
    coherence: input.candidateScore.coherence - input.baselineScore.coherence,
    repetition: input.candidateScore.repetition - input.baselineScore.repetition,
    engagement: input.candidateScore.engagement - input.baselineScore.engagement,
  };
  const introducedBlockingCodes = introducedCodes(
    input.baselineBlockingCodes,
    input.candidateBlockingCodes,
  );

  const fail = (reason: string): RepairContentAdoptResult => {
    const nextNoImprove = consecutiveNoImprove + 1;
    const decision: RepairContentAdoptKind = nextNoImprove >= plateauMax
      ? "plateau_stop"
      : "discard";
    return {
      decision,
      reason: decision === "plateau_stop"
        ? `${reason}；连续无改进已达 ${nextNoImprove}/${plateauMax}，停止自动修。`
        : reason,
      scoreDelta,
      introducedBlockingCodes,
      baselineLiteraryPass,
      candidateLiteraryPass,
    };
  };

  if (introducedBlockingCodes.length > 0) {
    return fail(
      `候选引入新的 L0 硬伤：${introducedBlockingCodes.slice(0, 6).join(",")}`,
    );
  }

  if (input.candidateScore.overall < input.baselineScore.overall - overallDelta) {
    return fail(
      `overall 从 ${input.baselineScore.overall} 降至 ${input.candidateScore.overall}，anti-regression 拒绝采纳`,
    );
  }

  if (baselineLiteraryPass && !candidateLiteraryPass) {
    return fail("基线已 isPass，候选未达文学门，拒绝采纳");
  }

  if (!baselineLiteraryPass && !candidateLiteraryPass) {
    const improvedDimension = (
      (input.baselineScore.coherence < threshold.coherence
        && input.candidateScore.coherence > input.baselineScore.coherence)
      || (input.baselineScore.repetition < threshold.repetition
        && input.candidateScore.repetition > input.baselineScore.repetition)
      || (input.baselineScore.engagement < threshold.engagement
        && input.candidateScore.engagement > input.baselineScore.engagement)
    );
    if (!improvedDimension && scoreDelta.overall <= 0) {
      return fail("未 isPass 且无门槛维提升、overall 未升，拒绝采纳");
    }
  }

  return {
    decision: "adopt",
    reason: candidateLiteraryPass
      ? "候选通过文学门且无 L0 回归，采纳"
      : "候选相对基线有改进且无 L0 回归，采纳",
    scoreDelta,
    introducedBlockingCodes,
    baselineLiteraryPass,
    candidateLiteraryPass,
  };
}

/** 从 repairHistory 文本统计尾部连续 discard/plateau 次数。 */
export function countTrailingRepairNoImprove(repairHistory: string | null | undefined): number {
  if (!repairHistory?.trim()) {
    return 0;
  }
  const lines = repairHistory
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let count = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (
      /decision=discard\b/.test(line)
      || /decision=plateau_stop\b/.test(line)
      || /\[repair_adopt[^\]]*decision=discard/.test(line)
      || /\[repair_adopt[^\]]*decision=plateau_stop/.test(line)
    ) {
      count += 1;
      continue;
    }
    if (/decision=adopt\b/.test(line) || /\[repair_adopt[^\]]*decision=adopt/.test(line)) {
      break;
    }
    // 非 adopt 决策行不打断连续 discard 计数（兼容旧 quality_loop 行）
  }
  return count;
}

export function formatRepairAdoptHistoryLine(input: {
  decision: RepairContentAdoptKind;
  reason: string;
  baselineOverall: number;
  candidateOverall: number;
  baselineHash?: string | null;
  candidateHash?: string | null;
  evaluatedAt?: string;
}): string {
  const at = input.evaluatedAt ?? new Date().toISOString();
  return [
    `[repair_adopt ${at}]`,
    `decision=${input.decision}`,
    `overall=${input.baselineOverall}->${input.candidateOverall}`,
    input.baselineHash ? `base=${input.baselineHash.slice(0, 12)}` : "",
    input.candidateHash ? `cand=${input.candidateHash.slice(0, 12)}` : "",
    `reason=${input.reason}`,
  ].filter(Boolean).join(" ");
}

export function appendRepairAdoptHistoryLine(
  previous: string | null | undefined,
  line: string,
  maxLines = 12,
): string {
  const lines = [
    ...(previous?.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) ?? []),
    line.trim(),
  ].filter(Boolean).slice(-maxLines);
  return lines.join("\n");
}
