import type { ChapterRuntimePackage } from "@ai-novel/shared/types/chapterRuntime";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import type { ChapterStatus, Prisma } from "@prisma/client";
import {
  buildChapterQualityLoopAssessment,
  type ChapterQualityLoopAssessment,
} from "@ai-novel/shared/types/chapterQualityLoop";
import type { SettingAlignmentAssessment } from "@ai-novel/shared/types/settingAlignment";
import {
  buildQualityFeedbackPacket,
  extractQualityFeedbackFromRiskFlags,
  mergeQualityFeedbackList,
  type QualityFeedbackPacket,
  type QualityFeedbackRepairDecision,
} from "@ai-novel/shared/types/qualityFeedback";
import { prisma } from "../../../db/prisma";
import { directorAutomationLedgerEventService } from "../director/runtime/DirectorAutomationLedgerEventService";
import type { QualityDebtAttribution } from "../runtime/chapterRuntimePipeline";

interface RecordChapterQualityLoopInput {
  novelId: string;
  chapterId: string;
  chapterOrder?: number | null;
  score: QualityScore;
  issues: ReviewIssue[];
  runtimePackage?: ChapterRuntimePackage | null;
  source: "manual_review" | "pipeline_review" | "repair_recheck";
  terminalAction?: "defer_and_continue" | null;
  taskId?: string | null;
  runId?: string | null;
  /** 阶段0 归因数据：仅在 terminalAction=defer_and_continue 时有意义 */
  qualityDebtAttribution?: QualityDebtAttribution | null;
  /**
   * B3 设定对齐：归并进 qualityLoop signal；完整 assessment 写入 riskFlags.settingAlignment。
   * 缺省不跑设定对齐（与 mode=off 一致）。
   */
  settingAlignment?: SettingAlignmentAssessment | null;
  /**
   * A1/A2 QFP：repair 采纳决策。discard/plateau_stop 会抬 failedPatchCount 并 avoidRetry。
   * 缺省 = 仅按 assessment/归因合成 feedback。
   */
  repairDecision?: QualityFeedbackRepairDecision | null;
}

type ChapterQualityLoopChapter = {
  riskFlags: string | null;
  repairHistory: string | null;
  chapterStatus: string | null;
  generationState?: string | null;
};

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function serializeRiskFlags(
  previous: string | null | undefined,
  assessment: ChapterQualityLoopAssessment,
  source: RecordChapterQualityLoopInput["source"],
  terminalAction?: RecordChapterQualityLoopInput["terminalAction"],
  qualityDebtAttribution?: RecordChapterQualityLoopInput["qualityDebtAttribution"],
  settingAlignment?: SettingAlignmentAssessment | null,
  feedback?: QualityFeedbackPacket[] | null,
): string {
  const parsed = parseJsonObject(previous);
  return JSON.stringify({
    ...parsed,
    qualityLoop: {
      ...assessment,
      source,
      ...(terminalAction ? { terminalAction } : {}),
      ...(qualityDebtAttribution ? { qualityDebtAttribution } : {}),
      // QFP projection only — blocking still via classifyChapterQualityLoopRiskFlags(qualityLoop)
      ...(feedback && feedback.length > 0 ? { feedback } : {}),
    },
    // 详情 only：不参与 hasBlocking*；blocking 只读 qualityLoop
    ...(settingAlignment ? { settingAlignment } : {}),
  });
}

function appendRepairHistory(
  previous: string | null | undefined,
  assessment: ChapterQualityLoopAssessment,
  terminalAction?: RecordChapterQualityLoopInput["terminalAction"],
): string | undefined {
  if (assessment.recommendedAction === "continue") {
    return undefined;
  }
  const line = [
    `[quality_loop ${assessment.evaluatedAt}]`,
    `status=${assessment.overallStatus}`,
    `action=${assessment.recommendedAction}`,
    assessment.budget?.signature ? `signature=${assessment.budget.signature}` : "",
    assessment.budget ? `attempt=${assessment.budget.attempt}/${assessment.budget.maxAttempts}` : "",
    assessment.budget?.nextAction ? `budget=${assessment.budget.nextAction}` : "",
    terminalAction ? `terminal=${terminalAction}` : "",
    assessment.signals
      .filter((signal) => signal.status !== "valid")
      .map((signal) => `${signal.artifactType}:${signal.status}`)
      .join(","),
  ].filter(Boolean).join(" ");
  const lines = [
    ...(previous?.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) ?? []),
    line,
  ].slice(-12);
  return lines.join("\n");
}

/**
 * continue / defer 后运营态。
 * A6：defer_and_continue 记非阻塞债，**不得**写成 completed（!literaryPass 不可质量过审）。
 * 仅 recommendedAction=continue（文学门已过）且 generation 已 approved/published 时收尾 completed。
 */
function resolveContinuableChapterStatus(
  chapter: Pick<ChapterQualityLoopChapter, "chapterStatus" | "generationState">,
  options: {
    recommendedAction: ChapterQualityLoopAssessment["recommendedAction"];
    terminalAction?: RecordChapterQualityLoopInput["terminalAction"];
  },
): ChapterStatus | undefined {
  if (chapter.chapterStatus !== "needs_repair") {
    return undefined;
  }
  // 耗尽后 defer：可读可继续，但不是质量过审
  if (options.terminalAction === "defer_and_continue") {
    return "pending_review";
  }
  if (options.recommendedAction !== "continue") {
    return "pending_review";
  }
  if (chapter.generationState === "approved" || chapter.generationState === "published") {
    return "completed";
  }
  return "pending_review";
}

export function buildChapterQualityLoopChapterUpdate(
  chapter: ChapterQualityLoopChapter,
  assessment: ChapterQualityLoopAssessment,
  source: RecordChapterQualityLoopInput["source"],
  terminalAction?: RecordChapterQualityLoopInput["terminalAction"],
  qualityDebtAttribution?: RecordChapterQualityLoopInput["qualityDebtAttribution"],
  settingAlignment?: SettingAlignmentAssessment | null,
  feedback?: QualityFeedbackPacket[] | null,
): Prisma.ChapterUpdateInput {
  const nextRepairHistory = appendRepairHistory(chapter.repairHistory, assessment, terminalAction);
  const shouldContinueChapter = assessment.recommendedAction === "continue" || terminalAction === "defer_and_continue";
  const nextChapterStatus: ChapterStatus | undefined = shouldContinueChapter
    ? resolveContinuableChapterStatus(chapter, {
      recommendedAction: assessment.recommendedAction,
      terminalAction,
    })
    : "needs_repair";
  return {
    riskFlags: serializeRiskFlags(
      chapter.riskFlags,
      assessment,
      source,
      terminalAction,
      qualityDebtAttribution,
      settingAlignment,
      feedback,
    ),
    ...(nextRepairHistory !== undefined ? { repairHistory: nextRepairHistory } : {}),
    ...(nextChapterStatus ? { chapterStatus: nextChapterStatus } : {}),
  };
}

export class ChapterQualityLoopService {
  async recordAssessment(input: RecordChapterQualityLoopInput): Promise<ChapterQualityLoopAssessment> {
    const chapter = await prisma.chapter.findFirst({
      where: { id: input.chapterId, novelId: input.novelId },
      select: {
        id: true,
        order: true,
        riskFlags: true,
        repairHistory: true,
        chapterStatus: true,
        generationState: true,
      },
    });
    if (!chapter) {
      throw new Error("章节不存在，无法记录质量闭环状态。");
    }

    const assessment = buildChapterQualityLoopAssessment({
      chapterId: input.chapterId,
      chapterOrder: input.chapterOrder ?? chapter.order,
      score: input.score,
      issues: input.issues,
      runtimePackage: input.runtimePackage,
      previousRepairHistory: chapter.repairHistory,
      settingAlignment: input.settingAlignment,
    });

    const previousFeedback = extractQualityFeedbackFromRiskFlags(chapter.riskFlags);
    const nextPacket = buildQualityFeedbackPacket({
      assessment,
      qualityDebtAttribution: input.qualityDebtAttribution,
      previousFeedback,
      repairDecision: input.repairDecision ?? null,
      terminalAction: input.terminalAction ?? null,
    });
    const feedback = nextPacket
      ? mergeQualityFeedbackList(previousFeedback, nextPacket)
      : previousFeedback;

    await prisma.chapter.update({
      where: { id: input.chapterId },
      data: buildChapterQualityLoopChapterUpdate(
        chapter,
        assessment,
        input.source,
        input.terminalAction ?? null,
        input.qualityDebtAttribution,
        input.settingAlignment,
        feedback,
      ),
    });
    await directorAutomationLedgerEventService.recordQualityLoopAssessment({
      taskId: input.taskId,
      runId: input.runId,
      novelId: input.novelId,
      assessment,
    }).catch(() => null);
    return assessment;
  }
}

export const chapterQualityLoopService = new ChapterQualityLoopService();
