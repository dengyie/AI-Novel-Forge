import { prisma } from "../../../../db/prisma";
import { AppError } from "../../../../middleware/errorHandler";
import type { NovelWorkflowStoreService } from "../NovelWorkflowStoreService";

type WorkflowRow = Awaited<ReturnType<typeof prisma.novelWorkflowTask.findUnique>>;

/** Owns workflow retry claiming and the CAS cleanup for a failed retry dispatch. */
export class WorkflowRetryService {
  constructor(private readonly workflow: NovelWorkflowStoreService) {}

  async retry(taskId: string, row: WorkflowRow = null) {
    const existing = row ?? await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!existing) {
      throw new AppError("Task not found.", 404);
    }
    if (!["failed", "cancelled"].includes(existing.status)) {
      return null;
    }
    const claimed = await prisma.novelWorkflowTask.updateMany({
      where: {
        id: taskId,
        status: existing.status,
        pendingManualRecovery: false,
        cancelRequestedAt: existing.cancelRequestedAt,
        updatedAt: existing.updatedAt,
        attemptCount: existing.attemptCount,
      },
      data: {
        status: existing.checkpointType ? "waiting_approval" : "queued",
        pendingManualRecovery: false,
        attemptCount: existing.attemptCount + 1,
        lastError: null,
        finishedAt: null,
        cancelRequestedAt: null,
        heartbeatAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      return null;
    }
    const next = await prisma.novelWorkflowTask.findUnique({
      where: { id: taskId },
      include: { novel: { select: { title: true } } },
    });
    if (!next) {
      return null;
    }
    await this.workflow.notifyAutoDirectorTaskTransition({ before: existing, after: next });
    return next;
  }

  async markDispatchFailed(taskId: string, claimedAttemptCount: number, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const existing = await this.workflow.getTaskByIdWithoutHealing(taskId);
    const updated = await this.workflow.updateTaskManyWithRetry({
      where: {
        id: taskId,
        status: { in: ["queued", "waiting_approval"] },
        pendingManualRecovery: false,
        cancelRequestedAt: null,
        attemptCount: claimedAttemptCount,
      },
      data: {
        status: "failed",
        pendingManualRecovery: true,
        lastError: `重试任务入队失败：${message}`.slice(0, 2000),
        finishedAt: null,
        heartbeatAt: new Date(),
      },
    });
    if (updated.count === 0) {
      return null;
    }
    const next = await this.workflow.getTaskById(taskId);
    if (next) {
      await this.workflow.notifyAutoDirectorTaskTransition({ before: existing, after: next });
    }
    return next;
  }
}
