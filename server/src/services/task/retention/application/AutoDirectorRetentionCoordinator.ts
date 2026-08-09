import { Prisma } from "@prisma/client";
import type { TaskRetentionConfig } from "../../../../config/taskRetention";
import { prisma } from "../../../../db/prisma";
import { isStrictTransientTaskRetryError } from "../../../../llm/transportRetry";
import {
  STALE_AUTO_DIRECTOR_RUNNING_MESSAGE,
  isAutoResumableStaleAutoDirectorTask,
  isStaleAutoDirectorRunningTaskBroad,
  resolveStaleRunningTaskMs,
} from "../../../novel/workflow/recovery";
import { NovelWorkflowTaskAdapter } from "../../adapters/NovelWorkflowTaskAdapter";
import { SUPERSEDE_LANE } from "../domain/retentionPolicy";
import type { TaskRetentionSummary } from "../domain/retentionTypes";

type WorkflowTaskAdapter = Pick<NovelWorkflowTaskAdapter, "retry" | "resumeStaleAutoDirectorTask">;

export class AutoDirectorRetentionCoordinator {
  // Tests replace this with a lightweight adapter; production uses the stable retry chain.
  workflowTaskAdapter: WorkflowTaskAdapter = new NovelWorkflowTaskAdapter();

  async cancelZombieRunningTasks(now: Date): Promise<number> {
    const staleCutoff = new Date(now.getTime() - resolveStaleRunningTaskMs());
    const runningRows = await prisma.novelWorkflowTask.findMany({
      where: {
        lane: SUPERSEDE_LANE,
        status: "running",
        pendingManualRecovery: false,
        cancelRequestedAt: null,
      },
      select: {
        id: true,
        lane: true,
        status: true,
        pendingManualRecovery: true,
        cancelRequestedAt: true,
        heartbeatAt: true,
        updatedAt: true,
        seedPayloadJson: true,
      },
    });
    const zombieRows = runningRows.filter((row) => isStaleAutoDirectorRunningTaskBroad(row, now));
    let cancelled = 0;
    for (const row of zombieRows) {
      const staleGuardWhere: Prisma.NovelWorkflowTaskWhereInput = {
        id: row.id,
        lane: SUPERSEDE_LANE,
        status: "running",
        pendingManualRecovery: false,
        cancelRequestedAt: null,
        OR: [
          { heartbeatAt: null },
          { heartbeatAt: { lt: staleCutoff } },
        ],
        updatedAt: { lt: staleCutoff },
      };
      if (isAutoResumableStaleAutoDirectorTask(row)) {
        try {
          await this.workflowTaskAdapter.resumeStaleAutoDirectorTask(row.id, {
            status: "running",
            updatedAt: row.updatedAt,
            heartbeatAt: row.heartbeatAt,
          });
        } catch (error) {
          console.warn("[task.retention] zombie auto-resume enqueue failed", {
            taskId: row.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      const result = await prisma.novelWorkflowTask.updateMany({
        where: staleGuardWhere,
        data: {
          status: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          heartbeatAt: now,
          lastError: STALE_AUTO_DIRECTOR_RUNNING_MESSAGE,
        },
      });
      cancelled += result.count;
    }
    return cancelled;
  }

  async projectStaleActiveWorkflowTasks(
    now: Date,
    cfg: TaskRetentionConfig,
    summary: TaskRetentionSummary,
  ): Promise<void> {
    const staleRunningCutoff = new Date(now.getTime() - cfg.staleRunningProjectionMs);
    const staleRunning = await prisma.novelWorkflowTask.findMany({
      where: {
        status: "running",
        lane: { not: SUPERSEDE_LANE },
        pendingManualRecovery: false,
        cancelRequestedAt: null,
        updatedAt: { lt: staleRunningCutoff },
        OR: [
          { heartbeatAt: null },
          { heartbeatAt: { lt: staleRunningCutoff } },
        ],
      },
      select: { id: true },
      take: 500,
    });
    if (staleRunning.length > 0) {
      const ids = staleRunning.map((row) => row.id);
      const projected = await prisma.novelWorkflowTask.updateMany({
        where: {
          id: { in: ids },
          status: "running",
          lane: { not: SUPERSEDE_LANE },
          pendingManualRecovery: false,
          cancelRequestedAt: null,
          updatedAt: { lt: staleRunningCutoff },
          OR: [
            { heartbeatAt: null },
            { heartbeatAt: { lt: staleRunningCutoff } },
          ],
        },
        data: {
          status: "failed",
          finishedAt: now,
          heartbeatAt: now,
          pendingManualRecovery: true,
          lastError: "任务长时间没有心跳，可能已因服务重启或执行器异常中断。可在恢复候选中继续或重试。",
        },
      });
      summary.staleRunningProjected += projected.count;
      if (projected.count > 0) {
        console.warn("[task.retention] stale running workflow tasks projected to failed", {
          count: projected.count,
          taskIds: ids,
        });
      }
    }

    const attentionCutoff = new Date(now.getTime() - cfg.waitingApprovalAttentionHours * 60 * 60 * 1000);
    const staleApproval = await prisma.novelWorkflowTask.findMany({
      where: {
        status: "waiting_approval",
        pendingManualRecovery: false,
        cancelRequestedAt: null,
        updatedAt: { lt: attentionCutoff },
      },
      select: { id: true },
      take: 500,
    });
    if (staleApproval.length > 0) {
      const ids = staleApproval.map((row) => row.id);
      const flagged = await prisma.novelWorkflowTask.updateMany({
        where: { id: { in: ids }, status: "waiting_approval", pendingManualRecovery: false },
        data: { pendingManualRecovery: true },
      });
      summary.waitingApprovalFlagged += flagged.count;
      if (flagged.count > 0) {
        console.warn("[task.retention] waiting_approval tasks flagged for attention", {
          count: flagged.count,
          taskIds: ids,
        });
      }
    }
  }

  async autoRetryTransientFailedWorkflowTasks(
    now: Date,
    cfg: TaskRetentionConfig,
    summary: TaskRetentionSummary,
  ): Promise<void> {
    if (!cfg.autoRetryTransientEnabled) {
      return;
    }
    const cooldownCutoff = new Date(now.getTime() - cfg.autoRetryCooldownMinutes * 60 * 1000);
    const candidates = await prisma.novelWorkflowTask.findMany({
      where: {
        status: "failed",
        lane: SUPERSEDE_LANE,
        pendingManualRecovery: false,
        cancelRequestedAt: null,
        novelId: { not: null },
        updatedAt: { lt: cooldownCutoff },
      },
      select: {
        id: true,
        novelId: true,
        attemptCount: true,
        maxAttempts: true,
        lastError: true,
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    const retryable = candidates.filter((row) => (
      row.attemptCount < row.maxAttempts
      && isStrictTransientTaskRetryError(row.lastError ?? "")
    ));
    if (retryable.length === 0) {
      return;
    }

    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const novelIds = Array.from(new Set(retryable.map((row) => row.novelId).filter((id): id is string => Boolean(id))));
    const usageByNovel = new Map<string, number>();
    if (cfg.dailyTokenBudgetPerNovel > 0 && novelIds.length > 0) {
      const usageRows = await prisma.directorLlmUsageRecord.groupBy({
        by: ["novelId"],
        where: {
          novelId: { in: novelIds },
          recordedAt: { gte: dayStart },
        },
        _sum: { totalTokens: true },
      });
      for (const row of usageRows) {
        if (row.novelId) {
          usageByNovel.set(row.novelId, row._sum.totalTokens ?? 0);
        }
      }
    }

    let started = 0;
    for (const row of retryable) {
      if (started >= cfg.autoRetryMaxPerRun) {
        break;
      }
      if (
        cfg.dailyTokenBudgetPerNovel > 0
        && row.novelId
        && (usageByNovel.get(row.novelId) ?? 0) >= cfg.dailyTokenBudgetPerNovel
      ) {
        const flagged = await prisma.novelWorkflowTask.updateMany({
          where: { id: row.id, status: "failed", pendingManualRecovery: false },
          data: { pendingManualRecovery: true },
        });
        if (flagged.count > 0) {
          summary.autoRetryBudgetSkipped += 1;
          console.warn("[task.retention] auto retry skipped: daily token budget reached", {
            taskId: row.id,
            novelId: row.novelId,
            usedTokens: usageByNovel.get(row.novelId),
            budget: cfg.dailyTokenBudgetPerNovel,
          });
        }
        continue;
      }

      try {
        await this.workflowTaskAdapter.retry({ id: row.id, resume: true });
        started += 1;
        summary.autoRetried += 1;
        console.warn("[task.retention] transient-failed workflow task auto retried", {
          taskId: row.id,
          novelId: row.novelId,
          attempt: row.attemptCount + 1,
          maxAttempts: row.maxAttempts,
          lastError: row.lastError?.slice(0, 200) ?? null,
        });
      } catch (error) {
        console.warn("[task.retention] auto retry continue failed:", error instanceof Error ? error.message : String(error));
      }
    }
  }
}
