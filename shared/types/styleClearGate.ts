/**
 * 去 AI 味 / 文风清净门（styleClear）。
 * 与 literaryPass（文学三维）正交：高分 + 句首他堆叠 / 开篇残留 risk 仍可 styleClear=false。
 *
 * 规则（冻结）：
 * - hasBlockingPronounProse → false（全书硬门）
 * - 关键章（order ≤ styleGateMaxOrder）且 residualRiskScore ≥ residualRiskHard → false
 * - 关键章 residual 未知（null）→ false（防 no-rewrite 假 true）
 * - 非关键章仅 residual 高 → true（可记债，不挡 completed 的 style 维；blocking pronoun 仍 false）
 */

export const DEFAULT_STYLE_GATE_MAX_ORDER = 3;
/** 与首轮改写门 FIRST_ROUND_REWRITE_THRESHOLD 对齐。 */
export const DEFAULT_RESIDUAL_RISK_HARD = 35;

export type ProjectStyleClearInput = {
  residualRiskScore: number | null;
  hasBlockingPronounProse: boolean;
  chapterOrder: number;
  /** 开篇 / 关键章上限（含）；默认 3。 */
  styleGateMaxOrder?: number;
  /** 关键章 residual 硬阈；默认 35。 */
  residualRiskHard?: number;
};

/**
 * 投影 styleClear：true 表示文风门可通过（不单独保证 literary / L0）。
 */
export function projectStyleClear(input: ProjectStyleClearInput): boolean {
  if (input.hasBlockingPronounProse) {
    return false;
  }
  const maxOrder = input.styleGateMaxOrder ?? DEFAULT_STYLE_GATE_MAX_ORDER;
  const residualHard = input.residualRiskHard ?? DEFAULT_RESIDUAL_RISK_HARD;
  const order = Number.isFinite(input.chapterOrder) ? input.chapterOrder : 0;
  const isGatedChapter = order > 0 && order <= maxOrder;

  if (!isGatedChapter) {
    // 非关键章：仅 residual 不挡 styleClear；blocking 已在上面处理
    return true;
  }

  // 关键章：未知 residual 不可假 true（no-rewrite 必须把 entry report 写入 residual）
  if (input.residualRiskScore == null || !Number.isFinite(input.residualRiskScore)) {
    return false;
  }
  if (input.residualRiskScore >= residualHard) {
    return false;
  }
  return true;
}

/**
 * 从 styleReview 包与 openIssues 投影 hasBlockingPronounProse。
 * hard 码：prose_pronoun_subject_stack / prose_pronoun_density（不含 soft）。
 */
export function hasBlockingPronounProseFromIssueCodes(
  codes: ReadonlyArray<string | null | undefined>,
): boolean {
  for (const code of codes) {
    if (code === "prose_pronoun_subject_stack" || code === "prose_pronoun_density") {
      return true;
    }
  }
  return false;
}

/**
 * residual risk：优先 residualReport.riskScore；否则 report.riskScore；皆无 → null。
 */
export function projectResidualRiskScore(styleReview: {
  residualReport?: { riskScore?: number | null } | null;
  report?: { riskScore?: number | null } | null;
} | null | undefined): number | null {
  if (!styleReview) {
    return null;
  }
  const residual = styleReview.residualReport?.riskScore;
  if (typeof residual === "number" && Number.isFinite(residual)) {
    return residual;
  }
  const entry = styleReview.report?.riskScore;
  if (typeof entry === "number" && Number.isFinite(entry)) {
    return entry;
  }
  return null;
}
