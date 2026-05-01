import type { ChapterRuntimePackage } from "@ai-novel/shared/types/chapterRuntime";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import {
  buildChapterQualityLoopAssessment,
  type ChapterQualityLoopAssessment,
} from "@ai-novel/shared/types/chapterQualityLoop";
import { prisma } from "../../../db/prisma";
import { directorAutomationLedgerEventService } from "../director/runtime/DirectorAutomationLedgerEventService";

interface RecordChapterQualityLoopInput {
  novelId: string;
  chapterId: string;
  chapterOrder?: number | null;
  score: QualityScore;
  issues: ReviewIssue[];
  runtimePackage?: ChapterRuntimePackage | null;
  source: "manual_review" | "pipeline_review" | "repair_recheck";
  taskId?: string | null;
  runId?: string | null;
}

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
): string {
  const parsed = parseJsonObject(previous);
  return JSON.stringify({
    ...parsed,
    qualityLoop: {
      ...assessment,
      source,
    },
  });
}

function appendRepairHistory(
  previous: string | null | undefined,
  assessment: ChapterQualityLoopAssessment,
): string | undefined {
  if (assessment.recommendedAction === "continue") {
    return undefined;
  }
  const line = [
    `[quality_loop ${assessment.evaluatedAt}]`,
    `status=${assessment.overallStatus}`,
    `action=${assessment.recommendedAction}`,
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
    });
    const nextRepairHistory = appendRepairHistory(chapter.repairHistory, assessment);
    await prisma.chapter.update({
      where: { id: input.chapterId },
      data: {
        riskFlags: serializeRiskFlags(chapter.riskFlags, assessment, input.source),
        ...(nextRepairHistory !== undefined ? { repairHistory: nextRepairHistory } : {}),
        ...(assessment.recommendedAction === "continue"
          ? {}
          : { chapterStatus: "needs_repair" }),
      },
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
