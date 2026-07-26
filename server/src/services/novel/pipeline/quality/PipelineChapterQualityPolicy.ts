import {
  buildChapterQualityLoopAssessment,
  type ChapterQualityLoopAssessment,
} from "@ai-novel/shared/types/chapterQualityLoop";
import {
  buildUnavailableSettingAlignmentAssessment,
  chapterRiskFlagsIndicateSettingAlignmentPass,
} from "@ai-novel/shared/types/settingAlignment";
import { prisma } from "../../../../db/prisma";
import type { PipelinePayload } from "../../novelCoreShared";
import { logPipelineError, logPipelineWarn } from "../../novelCoreShared";
import { createQualityReport } from "../../novelCoreReviewService";
import {
  buildVolumeReplanQualityDebtGate,
  isBlockingReplanQualityDebt,
  noteQualityLoopPersistFailOpen,
} from "../../quality/qualityDebtBoard";
import { chapterQualityLoopService } from "../../quality/ChapterQualityLoopService";
import { assessSettingAlignmentForQualityLoop } from "../../quality/settingAlignmentPipelineHook";
import {
  resolveSettingAlignmentFunctionContext,
  shouldSuppressDeferForSettingAlignment,
} from "../../quality/settingAlignmentWorkspaceLookup";
import type { PipelineRuntimeResult } from "../../runtime/chapterRuntimePipeline";
import { functionAcceptanceStatusService } from "../../volume/FunctionAcceptanceStatusService";
import { NovelVolumeService } from "../../volume/NovelVolumeService";
import { buildQualityLoopRiskFlagsSnapshot } from "../../pipelineExecutionHelpers";

type VolumeDocument = Awaited<ReturnType<NovelVolumeService["getVolumes"]>>;
type RangeDebtRow = { order: number; riskFlags: string | null };

export async function projectPipelineChapterQuality(input: {
  jobId: string;
  novelId: string;
  chapter: { id: string; order: number; content: string | null };
  chapterResult: PipelineRuntimeResult;
  runtimePayload: PipelinePayload;
  settingQualityMode: NonNullable<PipelinePayload["settingQualityMode"]>;
  settingAlignmentVolumeDocument: VolumeDocument | null;
  settingAlignmentWorkspaceUnavailableReason: string | null;
  volumeService: NovelVolumeService;
  rangeDebtByChapterId: Map<string, RangeDebtRow>;
  startOrder: number;
  endOrder: number;
}): Promise<{
  final: Pick<PipelineRuntimeResult, "score" | "issues">;
  settingAlignmentVolumeDocument: VolumeDocument | null;
}> {
  const {
    jobId,
    novelId,
    chapter,
    chapterResult,
    runtimePayload,
    settingQualityMode,
    settingAlignmentWorkspaceUnavailableReason,
    volumeService,
    rangeDebtByChapterId,
    startOrder,
    endOrder,
  } = input;
  let settingAlignmentVolumeDocument = input.settingAlignmentVolumeDocument;
  const final = { score: chapterResult.score, issues: chapterResult.issues };
  if (!chapterResult.reviewExecuted) {
    return { final, settingAlignmentVolumeDocument };
  }

  await createQualityReport(novelId, chapter.id, final.score, final.issues);
  const assessmentSource = chapterResult.retryCountUsed > 0
    ? "repair_recheck"
    : "pipeline_review";
  let settingAlignment = null as ReturnType<typeof assessSettingAlignmentForQualityLoop>
    | ReturnType<typeof buildUnavailableSettingAlignmentAssessment>;
  const finalContent = chapterResult.runtimePackage?.draft?.content
    ?? chapter.content
    ?? "";
  if (
    (settingQualityMode === "enforce" || settingQualityMode === "advisory")
    && settingAlignmentWorkspaceUnavailableReason
    && !settingAlignmentVolumeDocument
  ) {
    settingAlignment = buildUnavailableSettingAlignmentAssessment({
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      mode: settingQualityMode,
      reason: settingAlignmentWorkspaceUnavailableReason,
    });
  } else {
    try {
      settingAlignment = assessSettingAlignmentForQualityLoop({
        novelId,
        chapterId: chapter.id,
        chapterOrder: chapter.order,
        content: typeof finalContent === "string" ? finalContent : "",
        mode: settingQualityMode,
        contextPackage: chapterResult.runtimePackage?.context ?? null,
        mustAvoid: chapterResult.runtimePackage?.context?.chapter?.mustAvoid ?? null,
        volumeDocument: settingAlignmentVolumeDocument,
        includeHighConfidenceInventedTerms: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logPipelineWarn("设定对齐规则段评估失败", {
        jobId,
        novelId,
        chapterId: chapter.id,
        chapterOrder: chapter.order,
        settingQualityMode,
        failClosed: settingQualityMode === "enforce",
        error: message,
      });
      settingAlignment = settingQualityMode === "enforce" || settingQualityMode === "advisory"
        ? buildUnavailableSettingAlignmentAssessment({
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          mode: settingQualityMode,
          reason: `设定对齐规则段评估失败：${message}`,
        })
        : null;
    }
  }

  const suppressDeferForSetting = shouldSuppressDeferForSettingAlignment(settingAlignment);
  const assessmentTerminalAction = chapterResult.pass || suppressDeferForSetting
    ? null
    : "defer_and_continue";
  const memoryAssessment = buildChapterQualityLoopAssessment({
    chapterId: chapter.id,
    chapterOrder: chapter.order,
    score: final.score,
    issues: final.issues,
    runtimePackage: chapterResult.runtimePackage,
    settingAlignment,
  });
  let assessmentForMemory: ChapterQualityLoopAssessment = memoryAssessment;
  let rangeDebtSeededFromFailOpen = false;
  try {
    assessmentForMemory = await chapterQualityLoopService.recordAssessment({
      novelId,
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      score: final.score,
      issues: final.issues,
      runtimePackage: chapterResult.runtimePackage,
      source: assessmentSource,
      terminalAction: assessmentTerminalAction,
      taskId: runtimePayload.workflowTaskId,
      qualityDebtAttribution: chapterResult.qualityDebtAttribution ?? null,
      settingAlignment,
    });
    if (
      settingQualityMode === "enforce"
      && settingAlignment?.status === "pass"
      && settingAlignmentVolumeDocument
    ) {
      try {
        const fnCtx = resolveSettingAlignmentFunctionContext({
          document: settingAlignmentVolumeDocument,
          chapterOrder: chapter.order,
          chapterId: chapter.id,
        });
        if (fnCtx.volumeId && fnCtx.functionIds.length > 0) {
          const assignedOrders = Array.from(new Set(
            fnCtx.functionIds.flatMap((functionId) => {
              const item = fnCtx.functionTable?.items.find((row) => row.id === functionId);
              const stored = item?.assignedChapterOrders ?? [];
              if (stored.length > 0) {
                return stored;
              }
              const volume = settingAlignmentVolumeDocument?.volumes
                .find((row) => row.id === fnCtx.volumeId);
              return (volume?.chapters ?? [])
                .filter((row) => (row.functionIds ?? []).includes(functionId))
                .map((row) => row.chapterOrder);
            }),
          )).filter((order) => Number.isFinite(order) && order > 0);
          const siblingChapters = assignedOrders.length > 0
            ? await prisma.chapter.findMany({
              where: { novelId, order: { in: assignedOrders } },
              select: { order: true, riskFlags: true },
            }).catch(() => [] as Array<{ order: number; riskFlags: string | null }>)
            : [];
          const passedChapterOrders = Array.from(new Set([
            chapter.order,
            ...siblingChapters
              .filter((row) => chapterRiskFlagsIndicateSettingAlignmentPass(row.riskFlags))
              .map((row) => row.order),
          ])).sort((a, b) => a - b);
          const nextDocument = functionAcceptanceStatusService.markSatisfiedFromAlignmentPass({
            document: settingAlignmentVolumeDocument,
            volumeId: fnCtx.volumeId,
            functionIds: fnCtx.functionIds,
            passedChapterOrders,
          });
          if (nextDocument !== settingAlignmentVolumeDocument) {
            await volumeService.updateVolumes(novelId, nextDocument);
            settingAlignmentVolumeDocument = nextDocument;
          }
        }
      } catch (error) {
        logPipelineWarn("功能 satisfied 写回失败（不阻断）", {
          jobId,
          novelId,
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    const memoryRiskFlags = buildQualityLoopRiskFlagsSnapshot(
      assessmentForMemory,
      assessmentSource,
      assessmentTerminalAction,
      settingAlignment,
    );
    const chapterBlocksReplanGate = isBlockingReplanQualityDebt(
      assessmentForMemory as unknown as Record<string, unknown>,
    );
    const settingDebtBlocksProcessed = shouldSuppressDeferForSettingAlignment(settingAlignment)
      || (
        settingQualityMode === "enforce"
        && settingAlignment
        && settingAlignment.status !== "pass"
      );
    const failOpenMetrics = noteQualityLoopPersistFailOpen({
      chapterId: chapter.id,
      jobId,
      chapterBlocksReplanGate,
    });
    const projectedRows = Array.from(rangeDebtByChapterId.entries())
      .filter(([id]) => id !== chapter.id)
      .map(([, row]) => row)
      .concat([{ order: chapter.order, riskFlags: memoryRiskFlags }]);
    const projectedGate = buildVolumeReplanQualityDebtGate({
      chapters: projectedRows,
      startOrder,
      endOrder,
    });
    logPipelineError("记录章节质量闭环状态失败", {
      jobId,
      novelId,
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      failOpen: !settingDebtBlocksProcessed,
      qualityLoopPersistFailed: true,
      chapterBlocksReplanGate,
      settingDebtBlocksProcessed,
      memoryRootCauseCode: assessmentForMemory.rootCauseCode ?? null,
      memoryRecommendedAction: assessmentForMemory.recommendedAction,
      projectedBlockingReplanCount: projectedGate.blockingReplanCount,
      projectedShouldPause: projectedGate.shouldPause,
      failOpenTotal: failOpenMetrics.total,
      failOpenBlockingReplanMemoryCount: failOpenMetrics.blockingReplanMemoryCount,
      failOpenScope: "process_local",
      error: error instanceof Error ? error.message : String(error),
    });
    if (settingDebtBlocksProcessed) {
      try {
        await prisma.chapter.update({
          where: { id: chapter.id },
          data: { riskFlags: memoryRiskFlags, chapterStatus: "needs_repair" },
        });
      } catch (stubError) {
        logPipelineError("设定债 stub riskFlags 二次落库失败", {
          jobId,
          novelId,
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          error: stubError instanceof Error ? stubError.message : String(stubError),
        });
      }
    }
    rangeDebtByChapterId.set(chapter.id, {
      order: chapter.order,
      riskFlags: memoryRiskFlags,
    });
    rangeDebtSeededFromFailOpen = true;
  }

  if (!rangeDebtSeededFromFailOpen) {
    rangeDebtByChapterId.set(chapter.id, {
      order: chapter.order,
      riskFlags: buildQualityLoopRiskFlagsSnapshot(
        assessmentForMemory,
        assessmentSource,
        assessmentTerminalAction,
        settingAlignment,
      ),
    });
  }
  return { final, settingAlignmentVolumeDocument };
}
