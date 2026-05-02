import { prisma } from "../../../db/prisma";
import { NovelWorkflowService } from "../workflow/NovelWorkflowService";
import { DirectorCommandService } from "./DirectorCommandService";

const TERMINAL_TASK_STATUSES = ["cancelled", "failed", "succeeded"] as const;
const ACTIVE_COMMAND_STATUSES = ["queued", "leased", "running"] as const;
const RECOVERABLE_COMMAND_STATUSES = ["failed", "stale"] as const;

export interface DirectorWorkerReconciliationResult {
  staleLeaseCount: number;
  closedStepCount: number;
  requeuedDanglingTaskCount: number;
}

function sumUpdateCounts(results: Array<{ count: number } | null | undefined>): number {
  return results.reduce((total, result) => total + (result?.count ?? 0), 0);
}

export class DirectorWorkerReconciliationService {
  constructor(
    private readonly commandService = new DirectorCommandService(),
    private readonly workflowService = new NovelWorkflowService(),
  ) {}

  async reconcile(now = new Date()): Promise<DirectorWorkerReconciliationResult> {
    const staleLeaseCount = await this.commandService.recoverStaleLeases(now);
    const [closedStepCount, requeuedDanglingTaskCount] = await Promise.all([
      this.closeTerminalTaskSteps(now),
      this.requeueRecoverableDanglingTasks(),
    ]);
    return {
      staleLeaseCount,
      closedStepCount,
      requeuedDanglingTaskCount,
    };
  }

  private async closeTerminalTaskSteps(now: Date): Promise<number> {
    const terminalTasks = await prisma.novelWorkflowTask.findMany({
      where: {
        lane: "auto_director",
        status: { in: [...TERMINAL_TASK_STATUSES] },
      },
      select: {
        id: true,
        status: true,
        lastError: true,
      },
    });
    if (terminalTasks.length === 0) {
      return 0;
    }

    const cancelledIds = terminalTasks
      .filter((task) => task.status === "cancelled")
      .map((task) => task.id);
    const failedIds = terminalTasks
      .filter((task) => task.status === "failed")
      .map((task) => task.id);
    const succeededIds = terminalTasks
      .filter((task) => task.status === "succeeded")
      .map((task) => task.id);

    const updates = await Promise.all([
      cancelledIds.length > 0
        ? prisma.directorStepRun.updateMany({
          where: { taskId: { in: cancelledIds }, status: "running" },
          data: {
            status: "failed",
            finishedAt: now,
            error: "自动导演任务已取消，后台步骤已停止。",
          },
        })
        : null,
      failedIds.length > 0
        ? prisma.directorStepRun.updateMany({
          where: { taskId: { in: failedIds }, status: "running" },
          data: {
            status: "failed",
            finishedAt: now,
            error: "自动导演任务已暂停，后台步骤已停止。",
          },
        })
        : null,
      succeededIds.length > 0
        ? prisma.directorStepRun.updateMany({
          where: { taskId: { in: succeededIds }, status: "running" },
          data: {
            status: "succeeded",
            finishedAt: now,
            error: null,
          },
        })
        : null,
    ]);
    return sumUpdateCounts(updates);
  }

  private async requeueRecoverableDanglingTasks(): Promise<number> {
    const runningTasks = await prisma.novelWorkflowTask.findMany({
      where: {
        lane: "auto_director",
        status: "running",
        pendingManualRecovery: false,
      },
      orderBy: { updatedAt: "asc" },
      take: 50,
      select: {
        id: true,
      },
    });
    let requeuedCount = 0;
    for (const task of runningTasks) {
      const activeCommand = await prisma.directorRunCommand.findFirst({
        where: {
          taskId: task.id,
          status: { in: [...ACTIVE_COMMAND_STATUSES] },
        },
        select: { id: true },
      });
      if (activeCommand) {
        continue;
      }
      const latestCommand = await prisma.directorRunCommand.findFirst({
        where: { taskId: task.id },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: {
          status: true,
          errorMessage: true,
        },
      });
      if (!latestCommand || !RECOVERABLE_COMMAND_STATUSES.includes(latestCommand.status as typeof RECOVERABLE_COMMAND_STATUSES[number])) {
        continue;
      }
      await this.workflowService.requeueTaskForRecovery(
        task.id,
        latestCommand.errorMessage?.trim() || "后台执行器中断，任务等待恢复。",
      ).catch(() => null);
      requeuedCount += 1;
    }
    return requeuedCount;
  }
}
