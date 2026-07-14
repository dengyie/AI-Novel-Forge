import type { TaskStatus, UnifiedTaskDetail, UnifiedTaskSummary } from "@ai-novel/shared/types/task";
import { prisma } from "../../../db/prisma";
import { AppError } from "../../../middleware/errorHandler";
import { audiobookTaskService } from "../../audiobook/AudiobookTaskService";
import {
  AUDIOBOOK_TASK_STEPS,
  buildSteps,
  toLegacyTaskStatus,
} from "../taskCenter.shared";
import {
  buildTaskRecoveryHint,
  isArchivableTaskStatus,
  normalizeFailureSummary,
  resolveStructuredFailureSummary,
} from "../taskSupport";
import { toTaskTokenUsageSummary } from "../taskTokenUsageSummary";
import {
  archiveTask as recordTaskArchive,
  getArchivedTaskIds,
  isTaskArchived,
} from "../taskArchive";

function buildTitle(row: { title: string; novel?: { title: string } | null }): string {
  if (row.title?.trim()) {
    return row.title;
  }
  const novelTitle = row.novel?.title?.trim();
  return novelTitle ? `有声书：${novelTitle}` : "有声书任务";
}

function buildSourceRoute(novelId: string): string {
  return `/novels/${novelId}/edit?stage=basic`;
}

export class AudiobookTaskAdapter {
  async list(input: {
    status?: TaskStatus;
    keyword?: string;
    take: number;
  }): Promise<UnifiedTaskSummary[]> {
    if (input.status === "waiting_approval") {
      return [];
    }
    const status = toLegacyTaskStatus(input.status);
    const archivedIds = await getArchivedTaskIds("novel_audiobook");
    const rows = await prisma.audiobookTask.findMany({
      where: {
        ...(archivedIds.length ? { id: { notIn: archivedIds } } : {}),
        ...(status ? { status } : {}),
        ...(input.keyword
          ? {
              OR: [
                { title: { contains: input.keyword } },
                { novel: { title: { contains: input.keyword } } },
                { narratorVoice: { contains: input.keyword } },
              ],
            }
          : {}),
      },
      include: {
        novel: { select: { id: true, title: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: input.take,
    });

    return rows.map((row) => {
      const structuredFailure = resolveStructuredFailureSummary(row.error);
      const novelTitle = row.novel?.title?.trim() || "未命名小说";
      const route = buildSourceRoute(row.novelId);
      return {
        id: row.id,
        kind: "novel_audiobook",
        title: buildTitle(row),
        status: row.status as TaskStatus,
        pendingManualRecovery: row.pendingManualRecovery,
        progress: row.progress,
        currentStage: row.currentStage,
        currentItemKey: row.currentItemKey,
        currentItemLabel: row.currentItemLabel,
        attemptCount: row.retryCount,
        maxAttempts: row.maxRetries,
        lastError: row.error,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
        ownerId: row.novelId,
        ownerLabel: novelTitle,
        sourceRoute: route,
        failureCode: row.status === "failed"
          ? (structuredFailure.failureCode ?? "AUDIOBOOK_FAILED")
          : null,
        failureSummary: row.status === "failed"
          ? (structuredFailure.failureSummary ?? normalizeFailureSummary(row.error, "有声书任务失败。"))
          : row.error,
        recoveryHint: buildTaskRecoveryHint("novel_audiobook", row.status as TaskStatus),
        tokenUsage: toTaskTokenUsageSummary({
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          llmCallCount: row.llmCallCount,
          lastTokenRecordedAt: row.lastTokenRecordedAt,
        }),
        sourceResource: {
          type: "novel",
          id: row.novelId,
          label: novelTitle,
          route,
        },
        targetResources: row.outputDir
          ? [{
              type: "task",
              id: row.id,
              label: "有声书产物",
              route: `/tasks?kind=novel_audiobook&id=${row.id}`,
            }]
          : [],
      } satisfies UnifiedTaskSummary;
    });
  }

  async detail(id: string): Promise<UnifiedTaskDetail | null> {
    if (await isTaskArchived("novel_audiobook", id)) {
      return null;
    }

    const row = await prisma.audiobookTask.findUnique({
      where: { id },
      include: { novel: { select: { id: true, title: true } } },
    });
    if (!row) {
      return null;
    }

    const structuredFailure = resolveStructuredFailureSummary(row.error);
    const novelTitle = row.novel?.title?.trim() || "未命名小说";
    const route = buildSourceRoute(row.novelId);
    const summary: UnifiedTaskSummary = {
      id: row.id,
      kind: "novel_audiobook",
      title: buildTitle(row),
      status: row.status as TaskStatus,
      pendingManualRecovery: row.pendingManualRecovery,
      progress: row.progress,
      currentStage: row.currentStage,
      currentItemKey: row.currentItemKey,
      currentItemLabel: row.currentItemLabel,
      attemptCount: row.retryCount,
      maxAttempts: row.maxRetries,
      lastError: row.error,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
      ownerId: row.novelId,
      ownerLabel: novelTitle,
      sourceRoute: route,
      failureCode: row.status === "failed"
        ? (structuredFailure.failureCode ?? "AUDIOBOOK_FAILED")
        : null,
      failureSummary: row.status === "failed"
        ? (structuredFailure.failureSummary ?? normalizeFailureSummary(row.error, "有声书任务失败。"))
        : row.error,
      recoveryHint: buildTaskRecoveryHint("novel_audiobook", row.status as TaskStatus),
      tokenUsage: toTaskTokenUsageSummary({
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        llmCallCount: row.llmCallCount,
        lastTokenRecordedAt: row.lastTokenRecordedAt,
      }),
      sourceResource: {
        type: "novel",
        id: row.novelId,
        label: novelTitle,
        route,
      },
      targetResources: row.fullAudioPath
        ? [{
            type: "task",
            id: row.id,
            label: "全书音频",
            route: `/tasks?kind=novel_audiobook&id=${row.id}`,
          }]
        : [],
    };

    return {
      ...summary,
      provider: row.provider,
      model: row.model,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      retryCountLabel: `${row.retryCount}/${row.maxRetries}`,
      meta: {
        scopeMode: row.scopeMode,
        chapterCount: row.chapterCount,
        completedChapterCount: row.completedChapterCount,
        narratorVoice: row.narratorVoice,
        narratorStyle: row.narratorStyle,
        outputDir: row.outputDir,
        fullAudioPath: row.fullAudioPath,
        cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
        summary: row.summary,
        chapterIdsJson: row.chapterIdsJson,
      },
      steps: buildSteps(
        AUDIOBOOK_TASK_STEPS,
        summary.status,
        summary.currentStage,
        summary.createdAt,
        summary.updatedAt,
      ),
      failureDetails: row.error,
    };
  }

  async retry(id: string): Promise<UnifiedTaskDetail> {
    if (await isTaskArchived("novel_audiobook", id)) {
      throw new AppError("Task not found.", 404);
    }
    const task = await audiobookTaskService.retryTask(id);
    const detail = await this.detail(task.id);
    if (!detail) {
      throw new AppError("Task not found after retry.", 404);
    }
    return detail;
  }

  async cancel(id: string): Promise<UnifiedTaskDetail> {
    if (await isTaskArchived("novel_audiobook", id)) {
      throw new AppError("Task not found.", 404);
    }
    const task = await audiobookTaskService.cancelTask(id);
    const detail = await this.detail(task.id);
    if (!detail) {
      throw new AppError("Task not found after cancellation.", 404);
    }
    return detail;
  }

  async archive(id: string): Promise<UnifiedTaskDetail | null> {
    if (await isTaskArchived("novel_audiobook", id)) {
      return null;
    }
    const task = await prisma.audiobookTask.findUnique({ where: { id } });
    if (!task) {
      throw new AppError("Task not found.", 404);
    }
    if (!isArchivableTaskStatus(task.status as TaskStatus)) {
      throw new AppError("Only completed, failed, or cancelled tasks can be archived.", 400);
    }
    await recordTaskArchive("novel_audiobook", id);
    return null;
  }
}
