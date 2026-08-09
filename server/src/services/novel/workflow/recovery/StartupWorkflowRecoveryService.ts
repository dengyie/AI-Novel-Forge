import { prisma } from "../../../../db/prisma";
import { AppError } from "../../../../middleware/errorHandler";
import { buildRestoreTaskToCheckpointResult } from "../novelWorkflowCheckpoint";
import {
  NovelWorkflowStoreService,
  type NovelWorkflowRecoveryTaskSnapshot,
} from "../NovelWorkflowStoreService";

type WorkflowRow = Awaited<ReturnType<typeof prisma.novelWorkflowTask.findUnique>>;

function hasMatchingSnapshot(
  row: NonNullable<WorkflowRow>,
  expectedState: NovelWorkflowRecoveryTaskSnapshot,
): boolean {
  return row.status === expectedState.status
    && (row.cancelRequestedAt?.getTime() ?? null) === (expectedState.cancelRequestedAt?.getTime() ?? null)
    && row.updatedAt.getTime() === expectedState.updatedAt.getTime()
    && row.attemptCount === expectedState.attemptCount
    && row.pendingManualRecovery === expectedState.pendingManualRecovery;
}

function snapshotWhere(taskId: string, expectedState: NovelWorkflowRecoveryTaskSnapshot) {
  return {
    id: taskId,
    status: expectedState.status,
    cancelRequestedAt: expectedState.cancelRequestedAt,
    updatedAt: expectedState.updatedAt,
    attemptCount: expectedState.attemptCount,
    pendingManualRecovery: expectedState.pendingManualRecovery,
  };
}

/**
 * Owns startup recovery writes. Every write starts from an unhealed task read and
 * verifies the scanner snapshot so an older recovery pass cannot replace a cancel,
 * retry, completion, or newer runtime projection.
 */
export class StartupWorkflowRecoveryService {
  constructor(private readonly workflow: NovelWorkflowStoreService) {}

  async requeue(
    taskId: string,
    message: string,
    expectedState: NovelWorkflowRecoveryTaskSnapshot,
  ) {
    const existing = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!existing) {
      throw new AppError("Task not found.", 404);
    }
    if (!hasMatchingSnapshot(existing, expectedState)) {
      return null;
    }
    const claimed = await this.workflow.updateTaskManyWithRetry({
      where: snapshotWhere(taskId, expectedState),
      data: {
        status: "queued",
        pendingManualRecovery: true,
        finishedAt: null,
        heartbeatAt: null,
        lastError: message.trim(),
      },
    });
    return this.readAndNotify(taskId, existing, claimed.count);
  }

  async markFailed(
    taskId: string,
    message: string,
    expectedState: NovelWorkflowRecoveryTaskSnapshot,
  ) {
    const existing = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!existing || !hasMatchingSnapshot(existing, expectedState)) {
      return null;
    }
    const claimed = await this.workflow.updateTaskManyWithRetry({
      where: snapshotWhere(taskId, expectedState),
      data: {
        status: "failed",
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        lastError: message.trim(),
      },
    });
    return this.readAndNotify(taskId, existing, claimed.count);
  }

  async restoreCheckpoint(taskId: string, expectedState: NovelWorkflowRecoveryTaskSnapshot) {
    const existing = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!existing || !hasMatchingSnapshot(existing, expectedState)) {
      return null;
    }
    const restored = buildRestoreTaskToCheckpointResult({
      taskId,
      existing,
      buildResumeTarget: (params) => this.workflow.buildResumeTarget(params),
    });
    if (!restored) {
      return existing;
    }
    const claimed = await this.workflow.updateTaskManyWithRetry({
      where: snapshotWhere(taskId, expectedState),
      data: restored.data,
    });
    return this.readAndNotify(taskId, existing, claimed.count);
  }

  private async readAndNotify(taskId: string, before: NonNullable<WorkflowRow>, count: number) {
    if (count === 0) {
      return null;
    }
    const next = await this.workflow.getTaskByIdWithoutHealing(taskId);
    if (!next) {
      return null;
    }
    await this.workflow.notifyAutoDirectorTaskTransition({ before, after: next });
    return next;
  }
}
