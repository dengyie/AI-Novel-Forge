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
  /**
   * L1 义务/审校硬伤指纹（high/critical issue 稳定键）。
   * 候选相对 baseline **新增** → discard（防止高分补丁抹掉合同硬义务）。
   */
  baselineBlockingL1Codes?: string[];
  candidateBlockingL1Codes?: string[];
  /** 本决策前已连续无改进次数（discard / plateau） */
  consecutiveNoImprove?: number;
  /** 连续无改进上限，默认 2 */
  plateauMaxNoImprove?: number;
  /** overall 允许下降量，默认 0（不得低于 baseline） */
  overallDelta?: number;
  isPassThreshold?: QualityIsPassThreshold;
  /**
   * 调用方无法可靠拿到 baseline L1 指纹时置 true（如 evaluateOnly 失败回退到 columns/ruleScore）。
   * 置 true 时跳过 "候选相对 baseline 新增 L1" 的检查，避免用空集减法把候选自带 L1 全误判为回归。
   * L0 blocking 检查仍生效（L0 走独立探测，不依赖 review issues）。
   */
  skipL1Check?: boolean;
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
  introducedBlockingL1Codes: string[];
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
  const introducedBlockingL1Codes = introducedCodes(
    input.baselineBlockingL1Codes ?? [],
    input.candidateBlockingL1Codes ?? [],
  );
  // L1 计数比较（codeless 指 category 级）：容忍同类硬伤的 evidence 抖动与小幅浮增，
  // 仅当候选硬伤类目数明显膨胀时作为回归信号。baseline 无硬伤时仍严格（见下）。
  const baselineL1Count = (input.baselineBlockingL1Codes ?? []).length;
  const candidateL1Count = (input.candidateBlockingL1Codes ?? []).length;
  const l1CountGrew = candidateL1Count > baselineL1Count;

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
      introducedBlockingL1Codes,
      baselineLiteraryPass,
      candidateLiteraryPass,
    };
  };

  if (introducedBlockingCodes.length > 0) {
    return fail(
      `候选引入新的 L0 硬伤：${introducedBlockingCodes.slice(0, 6).join(",")}`,
    );
  }

  if (!input.skipL1Check) {
    // baseline 本就无 L1 硬伤 → 候选不得新引入任何类别（正回归，硬拒绝）。
    if (baselineL1Count === 0 && introducedBlockingL1Codes.length > 0) {
      return fail(
        `候选引入新的 L1 义务/审校硬伤：${introducedBlockingL1Codes.slice(0, 6).join(",")}`,
      );
    }
    // baseline 有 L1 硬伤：容忍同类硬伤 evidence 抖动；仅当候选硬伤类目数明显膨胀
    // 且 overall 未升、亦无文学门/维度改进时才判回归（保留 anti-regression，不无谓 discard）。
    if (l1CountGrew && scoreDelta.overall <= 0 && !candidateLiteraryPass) {
      const improvedDimension = (
        input.baselineScore.coherence < threshold.coherence
          && input.candidateScore.coherence > input.baselineScore.coherence
        || input.baselineScore.repetition < threshold.repetition
          && input.candidateScore.repetition > input.baselineScore.repetition
        || input.baselineScore.engagement < threshold.engagement
          && input.candidateScore.engagement > input.baselineScore.engagement
      );
      if (!improvedDimension) {
        return fail(
          `候选 L1 硬伤类目膨胀 ${baselineL1Count}->${candidateL1Count}（新增 ${introducedBlockingL1Codes.slice(0, 6).join(",")}）且 overall 未升，拒绝采纳`,
        );
      }
    }
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
      ? "候选通过文学门且无 L0/L1 回归，采纳"
      : "候选相对基线有改进且无 L0/L1 回归，采纳",
    scoreDelta,
    introducedBlockingCodes,
    introducedBlockingL1Codes,
    baselineLiteraryPass,
    candidateLiteraryPass,
  };
}

/**
 * 将 ReviewIssue 中 high/critical 压成 L1 稳定指纹。
 * 供修文 adopt 判定「义务/审校硬伤是否恶化」。
 *
 * 指纹口径：有稳定 code 用 `l1:${code}`；无 code 时用 `l1:${category}`
 * （**不再**把 evidence 全文塞进指纹）。原因：heavy 重写候选 re-review 时，
 * 同一硬伤类别（如 coherence）的 evidence 措辞必然抖动，若用 evidence 摘要作指纹，
 * 则「baseline 写 A 证据、候选 re-review 写 A' 证据」便被误判为候选引入新硬伤，
 * 导致几乎所有 heavy 候选无谓 discard、baseline 永远停在 needs_heavy。
 * 改用 category 作 codeless 指纹后，set-diff 只在「候选出现 baseline 缺失的硬伤类别」
 * 时判 intro——更符合「同类硬伤是否在数量/严重上恶化」的语义，细节严重度由
 * decideRepairContentAdoption 的计数比较兜底。
 */
export function fingerprintReviewIssuesAsL1BlockingCodes(
  issues: Array<{
    severity?: string | null;
    category?: string | null;
    evidence?: string | null;
    code?: string | null;
  }> | null | undefined,
): string[] {
  if (!Array.isArray(issues) || issues.length === 0) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const severity = String(issue?.severity ?? "").toLowerCase();
    if (severity !== "high" && severity !== "critical") {
      continue;
    }
    const code = typeof issue.code === "string" && issue.code.trim()
      ? issue.code.trim()
      : null;
    // L0（prose_*/sot_*）已由 baseline/candidateBlockingCodes 处理，不进 L1 双计
    if (code && (code.startsWith("prose_") || code.startsWith("sot_"))) {
      continue;
    }
    const category = String(issue.category ?? "unknown").trim() || "unknown";
    // 有稳定 code 用精确 l1:${code}；无 code 用 l1:${category}（不掺 evidence 抖动）
    const key = code ? `l1:${code}` : `l1:${category}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 从 repairHistory 文本统计尾部连续 discard/plateau 次数（只认 [repair_adopt] 决策行）。 */
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
    // 旧 quality_loop / 杂行不参与 plateau，避免误提前停自动修
    if (!/\[repair_adopt\b/.test(line)) {
      continue;
    }
    if (/decision=discard\b/.test(line) || /decision=plateau_stop\b/.test(line)) {
      count += 1;
      continue;
    }
    if (/decision=adopt\b/.test(line)) {
      break;
    }
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
