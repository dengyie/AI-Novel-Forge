/**
 * Volume Readiness 信号投影纯函数：
 * - hardDebt 单一来源（shared isNonDeferrableProseOrSotIssueCode）
 * - evaluateOnly review 返回值 → 临时 signals（不依赖写库）
 */

import {
  hasNonDeferrableProseOrSotDebt,
  isNonDeferrableProseOrSotIssueCode,
} from "@ai-novel/shared/types/chapterQualityLoop";
import { isLiteraryQualityPass } from "@ai-novel/shared/types/literaryQualityPass";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import {
  hasBlockingPronounProseFromIssueCodes,
  projectStyleClear,
} from "@ai-novel/shared/types/styleClearGate";
import { computeDeterministicResidualRiskScore } from "../../styleEngine/StyleDetectionService";
import { detectProseQuality } from "../runtime/proseQuality/ProseQualityDetector";
import type { VolumeReadinessChapterSignals } from "./volumeReadinessPolicy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * 从 qualityLoop 计不可 defer 硬债条数。
 * 主路径：prose_quality invalid 至少 1；再叠加 non-deferrable issueCodes。
 * 与 hasNonDeferrableProseOrSotDebt 同源（isNonDeferrableProseOrSotIssueCode）。
 */
export function countHardDebtFromQualityLoop(
  qualityLoop: Record<string, unknown> | null | undefined,
): number {
  if (!qualityLoop || !hasNonDeferrableProseOrSotDebt(qualityLoop)) {
    return 0;
  }
  const signals = Array.isArray(qualityLoop.signals) ? qualityLoop.signals : [];
  let count = 0;
  let hasInvalidProse = false;
  for (const signal of signals) {
    if (!isRecord(signal)) {
      continue;
    }
    if (signal.artifactType === "prose_quality" && signal.status === "invalid") {
      hasInvalidProse = true;
    }
    const codes = Array.isArray(signal.issueCodes) ? signal.issueCodes : [];
    for (const code of codes) {
      if (typeof code === "string" && isNonDeferrableProseOrSotIssueCode(code)) {
        count += 1;
      }
    }
  }
  if (hasInvalidProse && count === 0) {
    return 1;
  }
  return Math.max(hasInvalidProse ? 1 : 0, count);
}

/** 从 review issues + 正文 prose 扫计 hardDebt。 */
export function countHardDebtFromReviewIssues(
  issues: Array<{ code?: string | null } | ReviewIssue>,
  content?: string | null,
): number {
  let count = 0;
  for (const issue of issues) {
    const code = typeof (issue as { code?: string | null }).code === "string"
      ? (issue as { code: string }).code
      : null;
    if (isNonDeferrableProseOrSotIssueCode(code)) {
      count += 1;
    }
  }
  if (content && content.trim()) {
    const prose = detectProseQuality(content);
    for (const finding of prose.findings) {
      if (
        (finding.severity === "high" || finding.severity === "critical")
        && isNonDeferrableProseOrSotIssueCode(finding.code)
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function projectL0ClearFromIssuesAndContent(
  issues: Array<{ code?: string | null } | ReviewIssue>,
  content: string,
): boolean {
  const issueCodes = issues
    .map((issue) => {
      const code = (issue as { code?: string | null }).code;
      return typeof code === "string" && code.length > 0 ? code : null;
    })
    .filter((code): code is string => code != null);
  if (issueCodes.some((code) => isNonDeferrableProseOrSotIssueCode(code))) {
    return false;
  }
  const prose = detectProseQuality(content);
  return !prose.findings.some(
    (finding) =>
      (finding.severity === "high" || finding.severity === "critical")
      && isNonDeferrableProseOrSotIssueCode(finding.code),
  );
}

/**
 * 确定性 styleClear（与 manual review 路径对齐：L0 pronoun + residual floor）。
 * 避免 volume 层 import novelCoreReviewService 造成环依赖，这里内联同语义。
 */
export function projectStyleClearFromContentAndIssues(input: {
  content: string;
  issues: Array<{ code?: string | null } | ReviewIssue>;
  chapterOrder: number;
}): boolean {
  const issueCodes = input.issues
    .map((issue) => {
      const code = (issue as { code?: string | null }).code;
      return typeof code === "string" && code.length > 0 ? code : null;
    })
    .filter((code): code is string => code != null);
  const proseCodes = detectProseQuality(input.content).findings.map((finding) => finding.code);
  const hasBlockingPronounProse = hasBlockingPronounProseFromIssueCodes([
    ...issueCodes,
    ...proseCodes,
  ]);
  const residualRiskScore = computeDeterministicResidualRiskScore(input.content);
  return projectStyleClear({
    residualRiskScore,
    hasBlockingPronounProse,
    chapterOrder: input.chapterOrder,
  });
}

export interface EvaluateOnlyReviewLike {
  score: Pick<QualityScore, "coherence" | "repetition" | "engagement">;
  issues: Array<{ code?: string | null } | ReviewIssue>;
}

/**
 * 用 evaluateOnly 返回值覆盖/合成 signals（不写 DB）。
 * 保留 contentEmpty / padHitCount / contentRevision 等结构字段。
 *
 * 注意：evaluateOnly **不落** literary_score / style_residual artifact，
 * 故 hasTrueReview **保持 base**（通常 false），避免 plan 把「仅内存补算」当成已真审，
 * 与 executor re-assess（refresh:false 读 DB）判决分叉。
 */
export function synthesizeSignalsFromEvaluateOnly(input: {
  base: VolumeReadinessChapterSignals;
  content: string;
  review: EvaluateOnlyReviewLike;
}): VolumeReadinessChapterSignals {
  const { base, content, review } = input;
  const literaryPass = isLiteraryQualityPass(review.score);
  const styleClear = projectStyleClearFromContentAndIssues({
    content,
    issues: review.issues,
    chapterOrder: base.chapterOrder,
  });
  const hardDebtCount = countHardDebtFromReviewIssues(review.issues, content);
  const l0Clear = projectL0ClearFromIssuesAndContent(review.issues, content);

  return {
    ...base,
    literaryPass,
    styleClear,
    l0Clear,
    hardDebtCount,
    // 不伪造成真 review：artifact 未写库
    hasTrueReview: base.hasTrueReview,
    lastReviewedAt: new Date().toISOString(),
  };
}

/**
 * 真 review 只认 literary_score / style_residual。
 * evaluatedAt 只作 stale 时钟，不作真伪（ops 假路径也可能 stamp）。
 */
export function hasTrueReviewMarker(
  qualityLoop: Record<string, unknown> | null | undefined,
): boolean {
  if (!qualityLoop) {
    return false;
  }
  const signals = Array.isArray(qualityLoop.signals) ? qualityLoop.signals : [];
  return signals.some((signal) => {
    if (!isRecord(signal)) {
      return false;
    }
    return signal.artifactType === "literary_score"
      || signal.artifactType === "style_residual";
  });
}
