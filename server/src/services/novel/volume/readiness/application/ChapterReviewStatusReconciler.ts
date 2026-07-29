import { prisma } from "../../../../../db/prisma";
import type { ChapterStatus } from "@prisma/client";
import { chapterStatePairAfterManualQualityReview } from "../../../chapterLifecycleState";
import type { VolumeReadinessChapterOutcome } from "../../volumeReadinessRunStore";
import type {
  VolumeReadinessChapterSignals,
  VolumeReadinessVerdict,
} from "../../volumeReadinessPolicy";
import { volumeReadinessService } from "../../VolumeReadinessService";

export function shouldReconcileChapterStatusAfterReview(
  outcome: VolumeReadinessChapterOutcome,
  verdictAfter: VolumeReadinessVerdict | null,
  signals: VolumeReadinessChapterSignals | undefined,
): signals is VolumeReadinessChapterSignals & { contentRevision: number } {
  return (
    outcome === "re_reviewed"
    && verdictAfter === "needs_re_review"
    && signals != null
    && signals.hasTrueReview === true
    && signals.literaryPass === true
    && signals.l0Clear === true
    && signals.styleClear === true
    && Math.max(0, Math.floor(signals.hardDebtCount ?? 0)) === 0
    && signals.chapterStatus !== "completed"
    && typeof signals.contentRevision === "number"
    && Number.isInteger(signals.contentRevision)
    && signals.contentRevision >= 0
  );
}

export interface ChapterReviewStatusReconcileResult {
  verdictAfter: VolumeReadinessVerdict | null;
  message: string | null;
}

export class ChapterReviewStatusReconciler {
  async reconcile(input: {
    novelId: string;
    chapterId: string;
    chapterOrder: number;
    outcome: VolumeReadinessChapterOutcome;
    verdictAfter: VolumeReadinessVerdict | null;
    signals: VolumeReadinessChapterSignals | undefined;
    message: string | null;
    runWithDeadline: <T>(operation: () => Promise<T>, label: string) => Promise<T>;
  }): Promise<ChapterReviewStatusReconcileResult> {
    const signals = input.signals;
    if (!shouldReconcileChapterStatusAfterReview(
      input.outcome,
      input.verdictAfter,
      signals,
    )) {
      return { verdictAfter: input.verdictAfter, message: input.message };
    }

    try {
      const projected = await input.runWithDeadline(
        () => prisma.chapter.updateMany({
          where: {
            id: input.chapterId,
            contentRevision: signals.contentRevision,
            // signals.chapterStatus 来源是 Prisma Chapter 行的 enum 字段，类型被 policy/service
            // 宽松成 string|null；收窄回 ChapterStatus 让 where CAS 合法（null → Prisma 的 IS NULL）。
            chapterStatus: signals.chapterStatus as ChapterStatus | null,
          },
          data: chapterStatePairAfterManualQualityReview({
            literaryPass: true,
            styleClear: true,
          }),
        }),
        "reconcileChapterStatusAfterReview",
      );
      if (projected.count === 0) {
        return {
          verdictAfter: input.verdictAfter,
          message: `${input.message ?? "true review executed (dual gate)"} → 正文或章节状态已并发变化，保留 needs_re_review`,
        };
      }
      const report = await input.runWithDeadline(
        () => volumeReadinessService.assess(input.novelId, {
          fromOrder: input.chapterOrder,
          toOrder: input.chapterOrder,
          refresh: true,
        }),
        "reconcileChapterStatusAfterReview.assess",
      );
      const reconciled = report.chapters.find((chapter) => chapter.chapterId === input.chapterId);
      return {
        verdictAfter: reconciled?.verdict ?? input.verdictAfter,
        message: reconciled
          ? `${input.message ?? "true review executed (dual gate)"} → 收口 chapterStatus=completed`
          : input.message,
      };
    } catch {
      return { verdictAfter: input.verdictAfter, message: input.message };
    }
  }
}

export const chapterReviewStatusReconciler = new ChapterReviewStatusReconciler();
