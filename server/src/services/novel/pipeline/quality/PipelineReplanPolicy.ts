import type { PipelineRuntimeResult } from "../../runtime/chapterRuntimePipeline";
import { logPipelineWarn } from "../../novelCoreShared";
import type { buildVolumeReplanQualityDebtGate } from "../../quality/qualityDebtBoard";

type ReplanRecommendation = NonNullable<PipelineRuntimeResult["runtimePackage"]>["replanRecommendation"];
type RangeGate = ReturnType<typeof buildVolumeReplanQualityDebtGate>;

export function applyPipelineReplanPolicy(input: {
  jobId: string;
  chapterOrder: number;
  recommendation: ReplanRecommendation | null | undefined;
  rangeGate: RangeGate;
  qualityAlertDetails: string[];
  replanAlertDetails: string[];
}): boolean {
  const {
    jobId,
    chapterOrder,
    recommendation,
    rangeGate,
    qualityAlertDetails,
    replanAlertDetails,
  } = input;
  let shouldStop = false;

  if (recommendation?.recommended) {
    const impactedOrders = recommendation.affectedChapterOrders?.length
      ? `影响章节=${recommendation.affectedChapterOrders.join(",")}`
      : `锚点章节=${recommendation.anchorChapterOrder ?? chapterOrder}`;
    const detail = `第${chapterOrder}章${recommendation.action === "stop_for_replan" ? "需要重规划" : "建议局部处理"}（${impactedOrders}；原因=${recommendation.triggerReason ?? recommendation.reason}）`;
    if (recommendation.action === "stop_for_replan") {
      replanAlertDetails.push(detail);
      shouldStop = true;
    } else if (!qualityAlertDetails.includes(detail)) {
      qualityAlertDetails.push(detail);
    }
  }

  if (!shouldStop && rangeGate.shouldPause) {
    const detail = rangeGate.reason ?? "运行范围内 replan 质量债已达熔断阈值。";
    if (!replanAlertDetails.includes(detail)) {
      replanAlertDetails.push(detail);
    }
    shouldStop = true;
    logPipelineWarn("运行范围 replan 质量债熔断，停止后续章节流水线", {
      jobId,
      order: chapterOrder,
      blockingReplanCount: rangeGate.blockingReplanCount,
      threshold: rangeGate.threshold,
      scope: rangeGate.scope,
      startOrder: rangeGate.startOrder,
      endOrder: rangeGate.endOrder,
    });
  }

  return shouldStop;
}
