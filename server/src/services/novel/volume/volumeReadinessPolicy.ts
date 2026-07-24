/**
 * Volume Readiness 分类纯函数：章级 signals → verdict。
 * 不读 DB、不调 LLM；阈值由调用方注入（config 默认）。
 */

import {
  PROSE_PAD_HARD_THRESHOLD,
  PROSE_PAD_SOFT_THRESHOLD,
} from "../../../config/proseQuality";

export type VolumeReadinessVerdict =
  | "publish_ready"
  | "needs_re_review"
  | "needs_patch"
  | "needs_polish"
  | "needs_heavy"
  | "needs_manual";

export type VolumeReadinessActionFilter = Exclude<VolumeReadinessVerdict, "publish_ready">;

export interface VolumeReadinessChapterSignals {
  chapterId: string;
  chapterOrder: number;
  title?: string | null;
  chapterStatus: string | null;
  generationState?: string | null;
  /** 文学门；null = 从未真 review / 不可解析 */
  literaryPass: boolean | null;
  /** L0 清净；null = 不可解析 */
  l0Clear: boolean | null;
  /** 文风门；null = 不可解析 */
  styleClear: boolean | null;
  /** 非 defer 硬债条数（sot/critical prose 等） */
  hardDebtCount: number;
  /** 垫长命中；null = 未扫 */
  padHitCount: number | null;
  /** 是否曾跑过真 review（qualityLoop / evaluatedAt 存在） */
  hasTrueReview: boolean;
  contentRevision?: number | null;
  lastReviewedAt?: string | null;
  /** content 空或过短 */
  contentEmpty?: boolean;
}

export interface VolumeReadinessPolicyThresholds {
  padSoftThreshold: number;
  padHardThreshold: number;
}

export const DEFAULT_VOLUME_READINESS_THRESHOLDS: VolumeReadinessPolicyThresholds = {
  padSoftThreshold: PROSE_PAD_SOFT_THRESHOLD,
  padHardThreshold: PROSE_PAD_HARD_THRESHOLD,
};

export interface VolumeReadinessChapterPlan {
  chapterId: string;
  chapterOrder: number;
  title: string | null;
  verdict: VolumeReadinessVerdict;
  reasons: string[];
  signals: VolumeReadinessChapterSignals;
}

/**
 * 单章分类（计划矩阵，fail-closed 倾向 needs_manual / needs_re_review）：
 *
 * content empty → needs_manual
 * 从未真 review → needs_re_review（ops 假 approved 亦此）
 * literaryPass == false → needs_heavy（文学不过，允许激进重写；有硬债时 reasons 注明）
 * hardDebt > 0（文学已过）→ needs_heavy
 * styleClear == false | l0Clear == false | pad ≥ soft|hard → needs_patch
 * 双门全绿 ∧ completed ∧ 0 < pad < soft → needs_patch（轻度垫长走 light_repair，不走 polish 空转）
 * 真 review 后 chapterStatus != completed → needs_re_review 收口双门
 * 信号全 null 不可解析 → needs_manual
 * 全绿 ∧ completed ∧ pad=0 → publish_ready
 * needs_polish 保留类型（executor 可跑 pipeline polish）；当前 pad 残留不分类到 polish
 */
export function classifyChapterReadiness(
  signals: VolumeReadinessChapterSignals,
  thresholds: VolumeReadinessPolicyThresholds = DEFAULT_VOLUME_READINESS_THRESHOLDS,
): VolumeReadinessChapterPlan {
  const reasons: string[] = [];
  const title = signals.title ?? null;

  if (signals.contentEmpty) {
    reasons.push("正文为空或过短，需人工或先生成");
    return plan(signals, title, "needs_manual", reasons);
  }

  const padHits = typeof signals.padHitCount === "number" ? signals.padHitCount : 0;
  const padKnown = typeof signals.padHitCount === "number";
  const hardDebt = Math.max(0, Math.floor(signals.hardDebtCount ?? 0));

  // 从未真 review：不论 ops 假 approved，都要走真 review 过双门
  if (!signals.hasTrueReview) {
    if (signals.chapterStatus === "completed"
      && signals.literaryPass === true
      && signals.l0Clear === true
      && signals.styleClear === true
      && hardDebt === 0
      && (!padKnown || padHits < thresholds.padSoftThreshold)
    ) {
      // 防御：completed + 全绿却无 hasTrueReview 标记
      if (padKnown && padHits > 0) {
        reasons.push(`completed 全绿但垫长残留 ${padHits}，建议 light_repair`);
        return plan(signals, title, "needs_patch", reasons);
      }
      reasons.push("chapterStatus=completed 且双门全绿");
      return plan(signals, title, "publish_ready", reasons);
    }
    reasons.push("尚未跑过真·文学/风格双门 review（含 autoReview=false 假 approved）");
    return plan(signals, title, "needs_re_review", reasons);
  }

  // 有真 review 信号但关键门不可解析 → 人工
  if (signals.literaryPass == null && signals.l0Clear == null && signals.styleClear == null) {
    reasons.push("质量信号不可解析");
    return plan(signals, title, "needs_manual", reasons);
  }

  // 文学不过 + 硬债 → heavy；文学不过也 heavy（允许激进重写差章）
  if (signals.literaryPass === false) {
    if (hardDebt > 0) {
      reasons.push(`文学门未过且存在 ${hardDebt} 条不可 defer 硬债`);
    } else {
      reasons.push("文学门 literaryPass=false");
    }
    return plan(signals, title, "needs_heavy", reasons);
  }

  // 硬债在文学过的情况下仍可能存在（L0 硬）→ heavy
  if (hardDebt > 0) {
    reasons.push(`存在 ${hardDebt} 条不可 defer 硬债`);
    return plan(signals, title, "needs_heavy", reasons);
  }

  // pad 硬阈：按计划升 needs_patch（高量垫长走 light 段内定向；极高可仍 patch，heavy 留给文学/硬债）
  if (padKnown && padHits >= thresholds.padHardThreshold) {
    reasons.push(`垫长/套话命中 ${padHits} ≥ 硬阈 ${thresholds.padHardThreshold}`);
    return plan(signals, title, "needs_patch", reasons);
  }

  if (signals.styleClear === false) {
    reasons.push("文风门 styleClear=false，可局部修");
    return plan(signals, title, "needs_patch", reasons);
  }

  if (signals.l0Clear === false) {
    reasons.push("L0 未清净（l0Clear=false）");
    return plan(signals, title, "needs_patch", reasons);
  }

  if (padKnown && padHits >= thresholds.padSoftThreshold) {
    reasons.push(`垫长/套话命中 ${padHits} ≥ soft 阈 ${thresholds.padSoftThreshold}`);
    return plan(signals, title, "needs_patch", reasons);
  }

  // 已有真 review 但 chapterStatus 未 completed → 再走真 review 收口双门
  if (signals.chapterStatus !== "completed") {
    reasons.push(`chapterStatus=${signals.chapterStatus ?? "null"}，需真 review 收口双门`);
    return plan(signals, title, "needs_re_review", reasons);
  }

  // 部分 null 信号在 completed 下：偏保守 manual
  if (signals.literaryPass == null || signals.l0Clear == null || signals.styleClear == null) {
    reasons.push("部分质量信号缺失，需人工确认");
    return plan(signals, title, "needs_manual", reasons);
  }

  if (
    signals.literaryPass === true
    && signals.l0Clear === true
    && signals.styleClear === true
    && hardDebt === 0
  ) {
    // 双门全绿但仍有轻度垫长残留（低于 soft 阈）→ light_repair 定向清垫长
    // （polish/style finalize 不保证清 pad 词表，避免 outcome polished 空转）
    if (padKnown && padHits > 0 && padHits < thresholds.padSoftThreshold) {
      reasons.push(`双门全绿但垫长残留 ${padHits}（< soft ${thresholds.padSoftThreshold}），建议 light_repair`);
      return plan(signals, title, "needs_patch", reasons);
    }
    reasons.push("正式双门全绿且无硬债");
    return plan(signals, title, "publish_ready", reasons);
  }

  reasons.push("未匹配已知就绪条件");
  return plan(signals, title, "needs_manual", reasons);
}

function plan(
  signals: VolumeReadinessChapterSignals,
  title: string | null,
  verdict: VolumeReadinessVerdict,
  reasons: string[],
): VolumeReadinessChapterPlan {
  return {
    chapterId: signals.chapterId,
    chapterOrder: signals.chapterOrder,
    title,
    verdict,
    reasons,
    signals,
  };
}

export interface VolumeReadinessSummary {
  total: number;
  publishReady: number;
  needsReReview: number;
  needsPatch: number;
  needsPolish: number;
  needsHeavy: number;
  needsManual: number;
  publishReadyRatio: number;
}

export function summarizeReadinessPlans(
  plans: VolumeReadinessChapterPlan[],
): VolumeReadinessSummary {
  const summary: VolumeReadinessSummary = {
    total: plans.length,
    publishReady: 0,
    needsReReview: 0,
    needsPatch: 0,
    needsPolish: 0,
    needsHeavy: 0,
    needsManual: 0,
    publishReadyRatio: 0,
  };
  for (const planItem of plans) {
    switch (planItem.verdict) {
      case "publish_ready":
        summary.publishReady += 1;
        break;
      case "needs_re_review":
        summary.needsReReview += 1;
        break;
      case "needs_patch":
        summary.needsPatch += 1;
        break;
      case "needs_polish":
        summary.needsPolish += 1;
        break;
      case "needs_heavy":
        summary.needsHeavy += 1;
        break;
      case "needs_manual":
        summary.needsManual += 1;
        break;
      default:
        break;
    }
  }
  summary.publishReadyRatio = summary.total > 0
    ? summary.publishReady / summary.total
    : 0;
  return summary;
}

export function filterPlansByAction(
  plans: VolumeReadinessChapterPlan[],
  actionFilter: VolumeReadinessActionFilter[] | null | undefined,
): VolumeReadinessChapterPlan[] {
  if (!actionFilter || actionFilter.length === 0) {
    return plans.filter((planItem) => planItem.verdict !== "publish_ready");
  }
  const set = new Set(actionFilter);
  return plans.filter((planItem) => set.has(planItem.verdict as VolumeReadinessActionFilter));
}

/** 硬债计数：qualityLoop 投影或显式传入。 */
export function countHardDebtFromFlags(input: {
  hardDebtCount?: number | null;
  nonDeferrableIssueCount?: number | null;
}): number {
  if (typeof input.hardDebtCount === "number" && Number.isFinite(input.hardDebtCount)) {
    return Math.max(0, Math.floor(input.hardDebtCount));
  }
  if (
    typeof input.nonDeferrableIssueCount === "number"
    && Number.isFinite(input.nonDeferrableIssueCount)
  ) {
    return Math.max(0, Math.floor(input.nonDeferrableIssueCount));
  }
  return 0;
}
