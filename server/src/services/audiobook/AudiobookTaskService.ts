import type {
  AudiobookTaskDetail,
  AudiobookTaskSummary,
  CreateAudiobookTaskInput,
} from "@ai-novel/shared/types/audiobook";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { toTaskTokenUsageSummary } from "../task/taskTokenUsageSummary";
import { isMissingAudiobookTaskTableError } from "./audiobookErrors";
import { audiobookPrecheckService } from "./AudiobookPrecheckService";
import { ensureAudiobookTaskDir } from "./audiobookPaths";

const AUDIOBOOK_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.AUDIOBOOK_TASK_HEARTBEAT_INTERVAL_MS ?? 10_000) || 10_000,
);

const DEFAULT_MAX_RETRIES = 1;

function parseChapterIds(json: string | null | undefined): string[] {
  if (!json?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function buildTaskTitle(novelTitle: string, scopeMode: string, chapterCount: number): string {
  const scopeLabel = scopeMode === "full"
    ? "全书"
    : scopeMode === "range"
      ? `范围 ${chapterCount} 章`
      : "单章";
  return `有声书：${novelTitle}（${scopeLabel}）`;
}

function buildPrecheckRejectMessage(precheck: Awaited<ReturnType<typeof audiobookPrecheckService.precheck>>): string {
  const parts: string[] = [];
  if (precheck.missingVoices.length > 0) {
    const names = precheck.missingVoices.map((item) => item.characterName).join("、");
    parts.push(`以下角色未配置 ttsVoice：${names}`);
  }
  if (precheck.blockingErrors.length > 0) {
    parts.push(...precheck.blockingErrors);
  }
  return `有声书启动被拒绝：${parts.join("；") || "预检未通过"}。请绑定 MiMo 预置音色后重试。`;
}

type AudiobookTaskRow = {
  id: string;
  novelId: string;
  title: string;
  scopeMode: string;
  chapterIdsJson: string;
  chapterCount: number;
  completedChapterCount: number;
  narratorVoice: string;
  narratorStyle: string;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  status: string;
  progress: number;
  retryCount: number;
  maxRetries: number;
  pendingManualRecovery: boolean;
  heartbeatAt: Date | null;
  currentStage: string | null;
  currentItemKey: string | null;
  currentItemLabel: string | null;
  cancelRequestedAt: Date | null;
  error: string | null;
  summary: string | null;
  annotationsJson: string | null;
  progressJson: string | null;
  resultJson: string | null;
  outputDir: string | null;
  fullAudioPath: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCallCount: number;
  lastTokenRecordedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  novel?: { id: string; title: string } | null;
};

function toSummary(row: AudiobookTaskRow): AudiobookTaskSummary {
  return {
    id: row.id,
    novelId: row.novelId,
    novelTitle: row.novel?.title ?? "",
    title: row.title,
    status: row.status as AudiobookTaskSummary["status"],
    progress: row.progress,
    scopeMode: row.scopeMode as AudiobookTaskSummary["scopeMode"],
    currentStage: row.currentStage,
    currentItemKey: row.currentItemKey,
    currentItemLabel: row.currentItemLabel,
    attemptCount: row.retryCount,
    maxAttempts: row.maxRetries,
    lastError: row.error,
    chapterCount: row.chapterCount,
    completedChapterCount: row.completedChapterCount,
    outputDir: row.outputDir,
    fullAudioPath: row.fullAudioPath,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    tokenUsage: toTaskTokenUsageSummary({
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      llmCallCount: row.llmCallCount,
      lastTokenRecordedAt: row.lastTokenRecordedAt,
    }),
  };
}

function toDetail(row: AudiobookTaskRow): AudiobookTaskDetail {
  return {
    ...toSummary(row),
    chapterIds: parseChapterIds(row.chapterIdsJson),
    narratorVoice: row.narratorVoice,
    narratorStyle: row.narratorStyle,
    provider: row.provider,
    model: row.model,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    summary: row.summary,
    annotationsJson: row.annotationsJson,
    progressJson: row.progressJson,
    resultJson: row.resultJson,
    meta: {
      scopeMode: row.scopeMode,
      chapterCount: row.chapterCount,
      completedChapterCount: row.completedChapterCount,
      pendingManualRecovery: row.pendingManualRecovery,
      temperature: row.temperature,
      outputDir: row.outputDir,
      fullAudioPath: row.fullAudioPath,
    },
  };
}

/**
 * 有声书任务骨架：precheck 硬门禁、创建/取消/恢复、队列占位。
 * 完整 LLM 标注与 TTS 合成流水线留给后续 milestone。
 */
export class AudiobookTaskService {
  private readonly queue: string[] = [];

  private readonly queueSet = new Set<string>();

  private readonly activeControllers = new Map<string, AbortController>();

  private processing = false;

  async precheck(input: CreateAudiobookTaskInput) {
    return audiobookPrecheckService.precheck(input);
  }

  async createTask(input: CreateAudiobookTaskInput) {
    const precheck = await audiobookPrecheckService.precheck(input);
    if (!precheck.ok) {
      throw new AppError(buildPrecheckRejectMessage(precheck), 400);
    }

    const novel = await prisma.novel.findUnique({
      where: { id: precheck.novelId },
      select: { id: true, title: true },
    });
    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    const title = buildTaskTitle(novel.title, precheck.scopeMode, precheck.chapterCount);
    const task = await prisma.audiobookTask.create({
      data: {
        novelId: novel.id,
        title,
        scopeMode: precheck.scopeMode,
        chapterIdsJson: JSON.stringify(precheck.chapterIds),
        chapterCount: precheck.chapterCount,
        completedChapterCount: 0,
        narratorVoice: precheck.narrator.voice,
        narratorStyle: precheck.narrator.style,
        provider: input.provider ?? null,
        model: input.model?.trim() || null,
        temperature: typeof input.temperature === "number" ? input.temperature : null,
        status: "queued",
        progress: 0,
        currentStage: "queued",
        currentItemLabel: "排队中",
        maxRetries: DEFAULT_MAX_RETRIES,
      },
      include: {
        novel: { select: { id: true, title: true } },
      },
    });

    const outputDir = ensureAudiobookTaskDir(novel.id, task.id);
    const updated = await prisma.audiobookTask.update({
      where: { id: task.id },
      data: { outputDir },
      include: {
        novel: { select: { id: true, title: true } },
      },
    });

    this.enqueueTask(updated.id);
    return toDetail(updated as AudiobookTaskRow);
  }

  async getTask(taskId: string): Promise<AudiobookTaskDetail | null> {
    try {
      const row = await prisma.audiobookTask.findUnique({
        where: { id: taskId },
        include: { novel: { select: { id: true, title: true } } },
      });
      return row ? toDetail(row as AudiobookTaskRow) : null;
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return null;
      }
      throw error;
    }
  }

  async listByNovel(novelId: string, take = 50): Promise<AudiobookTaskSummary[]> {
    try {
      const rows = await prisma.audiobookTask.findMany({
        where: { novelId },
        include: { novel: { select: { id: true, title: true } } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: Math.max(1, Math.min(100, take)),
      });
      return rows.map((row) => toSummary(row as AudiobookTaskRow));
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return [];
      }
      throw error;
    }
  }

  async cancelTask(taskId: string): Promise<AudiobookTaskDetail> {
    const task = await prisma.audiobookTask.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
      throw new AppError("仅排队中或运行中的有声书任务可取消。", 400);
    }

    // 无论 queued/running：先从内存队列剔除，并写 cancelRequestedAt + abort
    this.removeFromQueue(taskId);
    await prisma.audiobookTask.update({
      where: { id: taskId },
      data: {
        cancelRequestedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
    this.activeControllers.get(taskId)?.abort();

    if (task.status === "queued") {
      // CAS：仅当仍为 queued 时终态 cancelled，避免与已进入 execute 的 running 打架
      await this.markCancelledIfActive(taskId, task.progress, ["queued"]);
    }

    const detail = await this.getTask(taskId);
    if (!detail) {
      throw new AppError("有声书任务不存在。", 404);
    }
    return detail;
  }

  async retryTask(taskId: string): Promise<AudiobookTaskDetail> {
    const task = await prisma.audiobookTask.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    if (task.status !== "failed" && task.status !== "cancelled") {
      throw new AppError("仅失败或已取消的有声书任务可重试。", 400);
    }
    if (task.retryCount >= task.maxRetries) {
      throw new AppError(
        `有声书任务已达最大重试次数（${task.maxRetries}）。请新建任务或提高 maxRetries。`,
        400,
      );
    }

    await prisma.audiobookTask.update({
      where: { id: taskId },
      data: {
        status: "queued",
        progress: 0,
        error: null,
        finishedAt: null,
        startedAt: null,
        cancelRequestedAt: null,
        pendingManualRecovery: false,
        heartbeatAt: null,
        currentStage: "queued",
        currentItemKey: null,
        currentItemLabel: "排队中",
        retryCount: { increment: 1 },
      },
    });
    this.enqueueTask(taskId);
    const detail = await this.getTask(taskId);
    if (!detail) {
      throw new AppError("有声书任务不存在。", 404);
    }
    return detail;
  }

  /**
   * 运维/测试用：将 in-flight 任务标为 pendingManualRecovery。
   * 生产启动路径走 resumePendingTasks（自动重入队），不调用本方法。
   */
  async markPendingTasksForManualRecovery(): Promise<void> {
    try {
      const rows = await prisma.audiobookTask.findMany({
        where: {
          status: { in: ["queued", "running"] },
          pendingManualRecovery: false,
        },
        select: { id: true, status: true },
        orderBy: { createdAt: "asc" },
      });
      if (rows.length === 0) {
        return;
      }

      const runningIds = rows.filter((item) => item.status === "running").map((item) => item.id);
      if (runningIds.length > 0) {
        await prisma.audiobookTask.updateMany({
          where: { id: { in: runningIds } },
          data: {
            status: "queued",
            pendingManualRecovery: true,
            error: "服务重启后，有声书任务已暂停，等待手动恢复。",
            heartbeatAt: null,
            currentStage: "queued",
            currentItemKey: null,
            cancelRequestedAt: null,
          },
        });
      }

      const queuedIds = rows.filter((item) => item.status === "queued").map((item) => item.id);
      if (queuedIds.length > 0) {
        await prisma.audiobookTask.updateMany({
          where: { id: { in: queuedIds } },
          data: {
            pendingManualRecovery: true,
            error: "服务重启后，有声书任务已暂停，等待手动恢复。",
            heartbeatAt: null,
            cancelRequestedAt: null,
          },
        });
      }
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return;
      }
      throw error;
    }
  }

  async resumePendingTasks(): Promise<void> {
    try {
      const rows = await prisma.audiobookTask.findMany({
        where: { status: { in: ["queued", "running"] } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      if (rows.length === 0) {
        return;
      }
      const ids = rows.map((row) => row.id);
      await prisma.audiobookTask.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "queued",
          pendingManualRecovery: false,
          error: null,
          heartbeatAt: null,
          currentStage: "queued",
          currentItemKey: null,
          cancelRequestedAt: null,
        },
      });
      for (const id of ids) {
        this.enqueueTask(id);
      }
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return;
      }
      throw error;
    }
  }

  async resumeTask(taskId: string): Promise<AudiobookTaskDetail> {
    const task = await prisma.audiobookTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    if (task.status !== "queued" && task.status !== "running") {
      throw new AppError("仅排队中或运行中的有声书任务可恢复。", 400);
    }

    await prisma.audiobookTask.update({
      where: { id: taskId },
      data: {
        status: "queued",
        pendingManualRecovery: false,
        heartbeatAt: null,
        cancelRequestedAt: null,
        error: null,
        currentStage: "queued",
        currentItemLabel: "排队中",
      },
    });
    this.enqueueTask(taskId);
    const detail = await this.getTask(taskId);
    if (!detail) {
      throw new AppError("有声书任务不存在。", 404);
    }
    return detail;
  }

  private removeFromQueue(taskId: string): void {
    if (!this.queueSet.has(taskId)) {
      return;
    }
    this.queueSet.delete(taskId);
    const index = this.queue.indexOf(taskId);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private enqueueTask(taskId: string): void {
    if (this.queueSet.has(taskId)) {
      return;
    }
    this.queue.push(taskId);
    this.queueSet.add(taskId);
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const taskId = this.queue.shift();
        if (!taskId) {
          continue;
        }
        this.queueSet.delete(taskId);
        await this.executeTaskSkeleton(taskId);
      }
    } finally {
      this.processing = false;
      // 执行期间若有新入队，继续消费
      if (this.queue.length > 0) {
        void this.processQueue();
      }
    }
  }

  /**
   * 骨架执行：仅推进到 skeleton_ready。
   * 完整标注与合成在后续 milestone 实现；此处保证任务可创建、可取消、可恢复。
   */
  private async executeTaskSkeleton(taskId: string): Promise<void> {
    const task = await prisma.audiobookTask.findUnique({ where: { id: taskId } });
    if (!task) {
      return;
    }
    if ((task.status !== "queued" && task.status !== "running") || task.pendingManualRecovery) {
      return;
    }
    if (task.cancelRequestedAt) {
      await this.markCancelledIfActive(task.id, task.progress, ["queued", "running"]);
      return;
    }

    const controller = new AbortController();
    this.activeControllers.set(taskId, controller);
    const stopHeartbeat = this.startTaskHeartbeat(taskId);

    try {
      // CAS：仅 queued 可进入 running，避免覆盖 cancelled
      const claimed = await prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: "queued",
          cancelRequestedAt: null,
          pendingManualRecovery: false,
        },
        data: {
          status: "running",
          startedAt: task.startedAt ?? new Date(),
          heartbeatAt: new Date(),
          currentStage: "preparing",
          currentItemLabel: "准备有声书任务",
          progress: 5,
          error: null,
        },
      });
      if (claimed.count === 0) {
        if (await this.isCancelRequested(taskId)) {
          await this.markCancelledIfActive(taskId, task.progress, ["queued", "running"]);
        }
        return;
      }

      if (controller.signal.aborted || (await this.isCancelRequested(taskId))) {
        await this.markCancelledIfActive(taskId, 5, ["running"]);
        return;
      }

      const chapterIds = parseChapterIds(task.chapterIdsJson);
      if (chapterIds.length === 0) {
        await this.markFailedIfRunning(taskId, "任务缺少章节列表，无法继续。");
        return;
      }

      // 骨架：不调用 LLM/TTS。默认 failed 明确未接通流水线；本地可 MARK_SUCCEEDED。
      const markSucceeded = process.env.AUDIOBOOK_SKELETON_MARK_SUCCEEDED === "1"
        || process.env.AUDIOBOOK_SKELETON_MARK_SUCCEEDED === "true";

      const progressUpdated = await prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: "running",
          cancelRequestedAt: null,
        },
        data: {
          currentStage: "skeleton_ready",
          currentItemLabel: "任务底座已就绪（标注/合成待下一阶段）",
          progress: 20,
          heartbeatAt: new Date(),
          summary: markSucceeded
            ? "有声书骨架任务完成（未执行 TTS）。"
            : "有声书任务底座已创建。完整 LLM 标注与 MiMo 合成流水线尚未在本 milestone 实现。",
          progressJson: JSON.stringify({
            phase: "skeleton",
            chapterIds,
            narratorVoice: task.narratorVoice,
          }),
        },
      });
      if (progressUpdated.count === 0) {
        if (await this.isCancelRequested(taskId)) {
          await this.markCancelledIfActive(taskId, 20, ["running", "queued"]);
        }
        return;
      }

      if (controller.signal.aborted || (await this.isCancelRequested(taskId))) {
        await this.markCancelledIfActive(taskId, 20, ["running"]);
        return;
      }

      if (markSucceeded) {
        await prisma.audiobookTask.updateMany({
          where: {
            id: taskId,
            status: "running",
            cancelRequestedAt: null,
          },
          data: {
            status: "succeeded",
            progress: 100,
            finishedAt: new Date(),
            currentStage: "finalizing",
            currentItemLabel: "骨架完成",
            heartbeatAt: new Date(),
          },
        });
      } else {
        await this.markFailedIfRunning(
          taskId,
          "有声书骨架已就位，但标注/合成流水线尚未实现。可在后续 milestone 重试完整生成。",
        );
      }
    } catch (error) {
      if (controller.signal.aborted || (await this.isCancelRequested(taskId))) {
        await this.markCancelledIfActive(taskId, task.progress, ["running", "queued"]);
        return;
      }
      await this.markFailedIfRunning(
        taskId,
        error instanceof Error ? error.message : "有声书任务执行失败。",
      );
    } finally {
      stopHeartbeat();
      this.activeControllers.delete(taskId);
    }
  }

  private startTaskHeartbeat(taskId: string): () => void {
    const timer = setInterval(() => {
      void prisma.audiobookTask.updateMany({
        where: { id: taskId, status: "running" },
        data: { heartbeatAt: new Date() },
      }).catch(() => undefined);
    }, AUDIOBOOK_HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  private async isCancelRequested(taskId: string): Promise<boolean> {
    const row = await prisma.audiobookTask.findUnique({
      where: { id: taskId },
      select: { cancelRequestedAt: true, status: true },
    });
    if (!row) {
      return true;
    }
    if (row.status === "cancelled") {
      return true;
    }
    return Boolean(row.cancelRequestedAt);
  }

  /** CAS 终态 cancelled：仅当 status 仍在允许集合内 */
  private async markCancelledIfActive(
    taskId: string,
    progress: number,
    allowedStatuses: Array<"queued" | "running">,
  ): Promise<void> {
    await prisma.audiobookTask.updateMany({
      where: {
        id: taskId,
        status: { in: allowedStatuses },
      },
      data: {
        status: "cancelled",
        progress,
        finishedAt: new Date(),
        currentStage: "cancelled",
        currentItemLabel: "已取消",
        error: "有声书任务已取消。",
        cancelRequestedAt: null,
        heartbeatAt: new Date(),
      },
    });
  }

  private async markFailedIfRunning(taskId: string, message: string): Promise<void> {
    await prisma.audiobookTask.updateMany({
      where: {
        id: taskId,
        status: "running",
        cancelRequestedAt: null,
      },
      data: {
        status: "failed",
        finishedAt: new Date(),
        currentStage: "failed",
        currentItemLabel: "失败",
        error: message,
        heartbeatAt: new Date(),
      },
    });
  }
}

export const audiobookTaskService = new AudiobookTaskService();
