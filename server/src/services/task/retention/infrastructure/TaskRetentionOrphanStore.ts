import type { TaskRetentionConfig } from "../../../../config/taskRetention";
import { prisma } from "../../../../db/prisma";
import { deleteWorkflowTasksHard } from "../../../novel/novelDeleteCascade";
import { ACTIVE_AGENT_STATUSES, ACTIVE_WORKFLOW_STATUSES } from "../domain/retentionPolicy";
import type { TaskRetentionSummary } from "../domain/retentionTypes";

const NULL_NOVEL_ORPHAN_MESSAGE = "空小说引用任务已过期，由任务保留策略清理。";
const ORPHAN_AGENT_RUN_MESSAGE = "宿主已终态或删除，孤儿运行由任务保留策略自动取消。";
const WRITING_CHAPTER_STATUSES = new Set(["generating", "pending_generation"]);

export class TaskRetentionOrphanStore {
  async purgeStaleNullNovelOrphans(
    now: Date,
    cfg: TaskRetentionConfig,
    summary: TaskRetentionSummary,
  ): Promise<void> {
    const cutoff = new Date(now.getTime() - cfg.nullNovelStaleHours * 60 * 60 * 1000);
    const staleWorkflows = await prisma.novelWorkflowTask.findMany({
      where: {
        novelId: null,
        status: { in: [...ACTIVE_WORKFLOW_STATUSES] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true },
    });
    if (staleWorkflows.length > 0) {
      const ids = staleWorkflows.map((row) => row.id);
      const cancelled = await prisma.novelWorkflowTask.updateMany({
        where: {
          id: { in: ids },
          novelId: null,
          status: { in: [...ACTIVE_WORKFLOW_STATUSES] },
          updatedAt: { lt: cutoff },
        },
        data: {
          status: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          heartbeatAt: now,
          lastError: NULL_NOVEL_ORPHAN_MESSAGE,
          ownershipVersion: { increment: 1 },
        },
      });
      if (cancelled.count > 0) {
        const cancelledIds = (
          await prisma.novelWorkflowTask.findMany({
            where: {
              id: { in: ids },
              novelId: null,
              status: "cancelled",
              cancelRequestedAt: now,
              lastError: NULL_NOVEL_ORPHAN_MESSAGE,
            },
            select: { id: true },
          })
        ).map((row) => row.id);
        const cascadeSummary = await deleteWorkflowTasksHard(cancelledIds, undefined, {
          novelId: null,
          statuses: ["cancelled"],
        });
        summary.novelWorkflowDeleted += cascadeSummary.workflowTasksDeleted;
        summary.runtimeRowsDeleted += cascadeSummary.runtimeRowsDeleted + cascadeSummary.followUpRowsDeleted;
        summary.archiveRowsDeleted += cascadeSummary.archiveRowsDeleted;
        summary.nullNovelOrphansDeleted += cascadeSummary.workflowTasksDeleted;
      }
    }

    const staleAgents = await prisma.agentRun.findMany({
      where: {
        novelId: null,
        status: { in: [...ACTIVE_AGENT_STATUSES] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true },
    });
    if (staleAgents.length === 0) {
      return;
    }
    const agentIds = staleAgents.map((row) => row.id);
    const deleted = await prisma.$transaction(async (tx) => {
      const eligible = await tx.agentRun.findMany({
        where: {
          id: { in: agentIds },
          novelId: null,
          status: { in: [...ACTIVE_AGENT_STATUSES] },
          updatedAt: { lt: cutoff },
        },
        select: { id: true },
      });
      const eligibleIds = eligible.map((row) => row.id);
      if (eligibleIds.length === 0) {
        return { ids: [] as string[], archives: 0 };
      }
      await tx.agentApproval.updateMany({
        where: { runId: { in: eligibleIds }, status: "pending" },
        data: {
          status: "expired",
          decisionNote: NULL_NOVEL_ORPHAN_MESSAGE,
          decidedAt: now,
        },
      });
      const result = await tx.agentRun.deleteMany({
        where: {
          id: { in: eligibleIds },
          novelId: null,
          status: { in: [...ACTIVE_AGENT_STATUSES] },
          updatedAt: { lt: cutoff },
        },
      });
      if (result.count === 0) {
        return { ids: [] as string[], archives: 0 };
      }

      let deletedIds = eligibleIds;
      if (result.count !== eligibleIds.length) {
        const remaining = await tx.agentRun.findMany({
          where: { id: { in: eligibleIds } },
          select: { id: true },
        });
        const remainingIds = new Set(remaining.map((row) => row.id));
        deletedIds = eligibleIds.filter((id) => !remainingIds.has(id));
      }
      const archiveAgent = await tx.taskCenterArchive.deleteMany({
        where: { taskKind: "agent_run", taskId: { in: deletedIds } },
      });
      return { ids: deletedIds, archives: archiveAgent.count };
    });
    summary.archiveRowsDeleted += deleted.archives;
    summary.nullNovelAgentRunsDeleted += deleted.ids.length;
  }

  async reconcileOrphanAgentRuns(
    now: Date,
    cfg: TaskRetentionConfig,
    summary: TaskRetentionSummary,
  ): Promise<void> {
    const cutoff = new Date(now.getTime() - cfg.orphanAgentRunStaleHours * 60 * 60 * 1000);
    const activeRuns = await prisma.agentRun.findMany({
      where: {
        status: { in: [...ACTIVE_AGENT_STATUSES] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, novelId: true, chapterId: true },
      take: 1000,
    });
    if (activeRuns.length === 0) {
      return;
    }

    const novelIds = Array.from(new Set(activeRuns.map((row) => row.novelId).filter((id): id is string => Boolean(id))));
    const chapterIds = Array.from(new Set(activeRuns.map((row) => row.chapterId).filter((id): id is string => Boolean(id))));
    const [existingNovels, existingChapters] = await Promise.all([
      novelIds.length > 0
        ? prisma.novel.findMany({ where: { id: { in: novelIds } }, select: { id: true } })
        : Promise.resolve([]),
      chapterIds.length > 0
        ? prisma.chapter.findMany({ where: { id: { in: chapterIds } }, select: { id: true, chapterStatus: true } })
        : Promise.resolve([]),
    ]);
    const liveNovelIds = new Set(existingNovels.map((row) => row.id));
    const chapterStatusById = new Map<string, string>(
      existingChapters.map((row) => [row.id, row.chapterStatus ?? "unplanned"]),
    );

    const orphanIds: string[] = [];
    for (const run of activeRuns) {
      if (run.novelId && !liveNovelIds.has(run.novelId)) {
        orphanIds.push(run.id);
        continue;
      }
      if (run.chapterId) {
        const chapterStatus = chapterStatusById.get(run.chapterId);
        if (chapterStatus === undefined || !WRITING_CHAPTER_STATUSES.has(chapterStatus)) {
          orphanIds.push(run.id);
        }
      }
    }
    if (orphanIds.length === 0) {
      return;
    }

    await prisma.agentApproval.updateMany({
      where: { runId: { in: orphanIds }, status: "pending" },
      data: {
        status: "expired",
        decisionNote: ORPHAN_AGENT_RUN_MESSAGE,
        decidedAt: now,
      },
    });
    const cancelled = await prisma.agentRun.updateMany({
      where: { id: { in: orphanIds }, status: { in: [...ACTIVE_AGENT_STATUSES] } },
      data: {
        status: "cancelled",
        finishedAt: now,
        currentStep: "cancelled",
        error: ORPHAN_AGENT_RUN_MESSAGE,
      },
    });
    for (const taskId of orphanIds) {
      await prisma.taskCenterArchive.upsert({
        where: { taskKind_taskId: { taskKind: "agent_run", taskId } },
        create: { taskKind: "agent_run", taskId },
        update: { archivedAt: now },
      });
    }
    summary.orphanAgentRunsCancelled += cancelled.count;
    if (cancelled.count > 0) {
      console.warn("[task.retention] orphan agent runs auto-cancelled", {
        count: cancelled.count,
        runIds: orphanIds,
      });
    }
  }
}
