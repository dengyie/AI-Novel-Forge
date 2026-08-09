import { isDirectorRecoveryNotNeededError } from "../director/runtime/novelDirectorErrors";
import { DirectorCommandService } from "../director/commands/DirectorCommandService";
import { NovelWorkflowService } from "./NovelWorkflowService";
import { AppError } from "../../../middleware/errorHandler";
import type { NovelWorkflowRecoveryTaskSnapshot } from "./NovelWorkflowStoreService";
import type { DirectorCommandPayload } from "../director/commands/DirectorCommandServiceHelpers";

const SERVER_RESTART_RECOVERY_MESSAGE = "自动导演任务因服务重启中断，正在尝试恢复。";
const STALE_RUNNING_RECOVERY_MESSAGE = "自动导演任务长时间没有心跳，可能已因服务重启或内存不足中断。请检查后继续或重试。";

interface WorkflowRecoveryPort {
  listRecoverableAutoDirectorTasks(options?: { includeStaleRunningFlag?: boolean }): Promise<Array<NovelWorkflowRecoveryTaskSnapshot & { stale?: boolean }>>;
  requeueTaskForRecovery(taskId: string, message: string, expectedState: NovelWorkflowRecoveryTaskSnapshot): Promise<unknown>;
  restoreTaskToCheckpoint(taskId: string): Promise<unknown>;
  restoreTaskToCheckpointForRecovery?: (taskId: string, expectedState: NovelWorkflowRecoveryTaskSnapshot) => Promise<unknown>;
  markTaskFailed(taskId: string, message: string): Promise<unknown>;
  markTaskFailedForRecovery?: (taskId: string, message: string, expectedState: NovelWorkflowRecoveryTaskSnapshot) => Promise<unknown>;
}

interface DirectorRecoveryPort {
  enqueueRecoveryCommand?: (taskId: string, input?: DirectorCommandPayload, options?: {
    expectedTaskState?: NovelWorkflowRecoveryTaskSnapshot;
  }) => Promise<unknown>;
  continueTask?: (taskId: string, options?: { expectedTaskState?: NovelWorkflowRecoveryTaskSnapshot }) => Promise<unknown>;
}

function createWorkflowService(): WorkflowRecoveryPort {
  return new NovelWorkflowService();
}

function createDirectorService(): DirectorRecoveryPort {
  return new DirectorCommandService();
}

export class NovelWorkflowRuntimeService {
  constructor(
    private readonly workflowService: WorkflowRecoveryPort = createWorkflowService(),
    private readonly directorService: DirectorRecoveryPort = createDirectorService(),
  ) {}

  async resumePendingAutoDirectorTasks(): Promise<void> {
    const rows = await this.workflowService.listRecoverableAutoDirectorTasks();
    for (const row of rows) {
      let expectedState: NovelWorkflowRecoveryTaskSnapshot = row;
      try {
        if (row.status === "running") {
          const requeued = await this.workflowService.requeueTaskForRecovery(
            row.id,
            SERVER_RESTART_RECOVERY_MESSAGE,
            row,
          );
          if (requeued === null) {
            continue;
          }
          const requeuedUpdatedAt = requeued
            && typeof requeued === "object"
            && "updatedAt" in requeued
            && (requeued as { updatedAt?: unknown }).updatedAt instanceof Date
            ? (requeued as { updatedAt: Date }).updatedAt
            : row.updatedAt;
          expectedState = {
            ...row,
            status: "queued",
            pendingManualRecovery: true,
            cancelRequestedAt: null,
            heartbeatAt: null,
            updatedAt: requeuedUpdatedAt,
          };
        }
        await this.enqueueRecoveryCommand(row.id, {}, { expectedTaskState: expectedState });
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 409) {
          continue;
        }
        if (isDirectorRecoveryNotNeededError(error)) {
          if (this.workflowService.restoreTaskToCheckpointForRecovery) {
            await this.workflowService.restoreTaskToCheckpointForRecovery(row.id, expectedState);
          } else {
            await this.workflowService.restoreTaskToCheckpoint(row.id);
          }
          continue;
        }
        const message = error instanceof Error ? error.message : "自动导演任务在服务重启后恢复失败。";
        if (this.workflowService.markTaskFailedForRecovery) {
          await this.workflowService.markTaskFailedForRecovery(
            row.id,
            `服务重启后恢复失败：${message}`,
            expectedState,
          );
        } else {
          await this.workflowService.markTaskFailed(row.id, `服务重启后恢复失败：${message}`);
        }
      }
    }
  }

  async markPendingAutoDirectorTasksForManualRecovery(options: {
    staleRunningAsFailed?: boolean;
  } = {}): Promise<void> {
    const rows = await this.workflowService.listRecoverableAutoDirectorTasks({
      includeStaleRunningFlag: options.staleRunningAsFailed === true,
    });
    for (const row of rows) {
      if (options.staleRunningAsFailed === true && row.stale) {
        if (this.workflowService.markTaskFailedForRecovery) {
          await this.workflowService.markTaskFailedForRecovery(row.id, STALE_RUNNING_RECOVERY_MESSAGE, row);
        } else {
          await this.workflowService.markTaskFailed(row.id, STALE_RUNNING_RECOVERY_MESSAGE);
        }
        continue;
      }
      await this.workflowService.requeueTaskForRecovery(
        row.id,
        "服务重启后任务已暂停，等待手动恢复。",
        row,
      );
    }
  }

  private enqueueRecoveryCommand(
    taskId: string,
    input: Record<string, unknown> = {},
    options: { expectedTaskState?: NovelWorkflowRecoveryTaskSnapshot } = {},
  ): Promise<unknown> {
    if (this.directorService.enqueueRecoveryCommand) {
      return this.directorService.enqueueRecoveryCommand(taskId, input, options);
    }
    if (this.directorService.continueTask) {
      return this.directorService.continueTask(taskId, options);
    }
    throw new Error("Auto director recovery command service is unavailable.");
  }
}
