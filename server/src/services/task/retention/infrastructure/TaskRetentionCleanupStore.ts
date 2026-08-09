import { Prisma } from "@prisma/client";
import type { TaskRetentionConfig } from "../../../../config/taskRetention";
import { prisma } from "../../../../db/prisma";
import {
  NULL_NOVEL_BUCKET,
  TERMINAL_PIPELINE_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
} from "../domain/retentionPolicy";
import type { TaskRetentionSummary } from "../domain/retentionTypes";

export class TaskRetentionCleanupStore {
  /**
   * Delete workflow rows before their dependent runtime/archive rows. The
   * terminal recheck prevents a selected task that became active from being removed.
   */
  async deleteWorkflowTasks(ids: string[], summary: TaskRetentionSummary): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const deleted = await prisma.$transaction(async (tx) => {
      const eligible = await tx.novelWorkflowTask.findMany({
        where: { id: { in: ids }, status: { in: [...TERMINAL_WORKFLOW_STATUSES] } },
        select: { id: true },
      });
      const eligibleIds = eligible.map((row) => row.id);
      if (eligibleIds.length === 0) {
        return { workflow: 0, runtime: 0, followUp: 0, archive: 0 };
      }
      const workflowDeleteResult = await tx.novelWorkflowTask.deleteMany({
        where: { id: { in: eligibleIds }, status: { in: [...TERMINAL_WORKFLOW_STATUSES] } },
      });
      if (workflowDeleteResult.count === 0) {
        return { workflow: 0, runtime: 0, followUp: 0, archive: 0 };
      }
      let deletedIds = eligibleIds;
      if (workflowDeleteResult.count !== eligibleIds.length) {
        const remaining = await tx.novelWorkflowTask.findMany({
          where: { id: { in: eligibleIds } },
          select: { id: true },
        });
        const remainingIds = new Set(remaining.map((row) => row.id));
        deletedIds = eligibleIds.filter((id) => !remainingIds.has(id));
      }
      const runtimeDeleteResults = await Promise.all([
        tx.directorRuntimeEvent.deleteMany({ where: { workflowTaskId: { in: deletedIds } } }),
        tx.directorRuntimeExecution.deleteMany({ where: { workflowTaskId: { in: deletedIds } } }),
        tx.directorRuntimeCommand.deleteMany({ where: { workflowTaskId: { in: deletedIds } } }),
        tx.directorRuntimeInstance.deleteMany({ where: { workflowTaskId: { in: deletedIds } } }),
        tx.autoDirectorFollowUpActionLog.deleteMany({ where: { taskId: { in: deletedIds } } }),
        tx.autoDirectorFollowUpNotificationLog.deleteMany({ where: { taskId: { in: deletedIds } } }),
      ]);
      const archiveWorkflowResult = await tx.taskCenterArchive.deleteMany({
        where: { taskKind: "novel_workflow", taskId: { in: deletedIds } },
      });
      return {
        workflow: workflowDeleteResult.count,
        runtime: runtimeDeleteResults.slice(0, 4).reduce((sum, result) => sum + result.count, 0),
        followUp: runtimeDeleteResults.slice(4).reduce((sum, result) => sum + result.count, 0),
        archive: archiveWorkflowResult.count,
      };
    });
    summary.novelWorkflowDeleted += deleted.workflow;
    summary.runtimeRowsDeleted += deleted.runtime + deleted.followUp;
    summary.archiveRowsDeleted += deleted.archive;
  }

  async deleteTerminalGenerationJobs(ids: string[], summary: TaskRetentionSummary): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const deleted = await prisma.$transaction(async (tx) => {
      const eligible = await tx.generationJob.findMany({
        where: { id: { in: ids }, status: { in: [...TERMINAL_PIPELINE_STATUSES] } },
        select: { id: true },
      });
      const eligibleIds = eligible.map((row) => row.id);
      if (eligibleIds.length === 0) {
        return { jobs: 0, archives: 0 };
      }
      const result = await tx.generationJob.deleteMany({
        where: { id: { in: eligibleIds }, status: { in: [...TERMINAL_PIPELINE_STATUSES] } },
      });
      if (result.count === 0) {
        return { jobs: 0, archives: 0 };
      }
      let deletedIds = eligibleIds;
      if (result.count !== eligibleIds.length) {
        const remaining = await tx.generationJob.findMany({
          where: { id: { in: eligibleIds } },
          select: { id: true },
        });
        const remainingIds = new Set(remaining.map((row) => row.id));
        deletedIds = eligibleIds.filter((id) => !remainingIds.has(id));
      }
      const archive = await tx.taskCenterArchive.deleteMany({
        where: { taskKind: "novel_pipeline", taskId: { in: deletedIds } },
      });
      return { jobs: result.count, archives: archive.count };
    });
    summary.generationJobDeleted += deleted.jobs;
    summary.archiveRowsDeleted += deleted.archives;
    return deleted.jobs;
  }

  async selectAgeDeletableIdsBySql(input: {
    table: "NovelWorkflowTask" | "GenerationJob";
    now: Date;
    cfg: TaskRetentionConfig;
    excludeIds?: string[];
  }): Promise<string[]> {
    const succeededCutoff = new Date(
      input.now.getTime() - input.cfg.succeededDays * 24 * 60 * 60 * 1000,
    );
    const failedCutoff = new Date(
      input.now.getTime() - input.cfg.failedDays * 24 * 60 * 60 * 1000,
    );
    const tableIdent = input.table === "NovelWorkflowTask"
      ? Prisma.raw(`"NovelWorkflowTask"`)
      : Prisma.raw(`"GenerationJob"`);
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH ranked AS (
        SELECT
          id,
          status,
          "finishedAt",
          "updatedAt",
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE("novelId", ${NULL_NOVEL_BUCKET})
            ORDER BY COALESCE("finishedAt", "updatedAt") DESC, id ASC
          ) AS rn
        FROM ${tableIdent}
        WHERE status IN ('succeeded', 'failed', 'cancelled')
      )
      SELECT id
      FROM ranked
      WHERE rn > ${input.cfg.keepPerNovel}
        AND (
          (status = 'failed' AND COALESCE("finishedAt", "updatedAt") < ${failedCutoff})
          OR (status <> 'failed' AND COALESCE("finishedAt", "updatedAt") < ${succeededCutoff})
        )
    `);
    if (!input.excludeIds || input.excludeIds.length === 0) {
      return rows.map((row) => row.id);
    }
    const excluded = new Set(input.excludeIds);
    return rows.map((row) => row.id).filter((id) => !excluded.has(id));
  }

  async cleanupOrphanFollowUpLogs(): Promise<number> {
    const orphanActionDelete = await prisma.$executeRaw`
      DELETE FROM "AutoDirectorFollowUpActionLog" AS log
      WHERE NOT EXISTS (
        SELECT 1 FROM "NovelWorkflowTask" AS task WHERE task.id = log."taskId"
      )
    `;
    const orphanNotificationDelete = await prisma.$executeRaw`
      DELETE FROM "AutoDirectorFollowUpNotificationLog" AS log
      WHERE NOT EXISTS (
        SELECT 1 FROM "NovelWorkflowTask" AS task WHERE task.id = log."taskId"
      )
    `;
    return Number(orphanActionDelete) + Number(orphanNotificationDelete);
  }

  async autoArchiveTerminalTasks(now: Date, cfg: TaskRetentionConfig): Promise<number> {
    const statuses: Array<{ status: "succeeded" | "failed" | "cancelled"; cutoff: Date | null }> = [
      {
        status: "succeeded",
        cutoff: cfg.autoArchiveSucceededHours > 0
          ? new Date(now.getTime() - cfg.autoArchiveSucceededHours * 60 * 60 * 1000)
          : null,
      },
      {
        status: "cancelled",
        cutoff: cfg.autoArchiveSucceededHours > 0
          ? new Date(now.getTime() - cfg.autoArchiveSucceededHours * 60 * 60 * 1000)
          : null,
      },
      {
        status: "failed",
        cutoff: cfg.autoArchiveFailedDays > 0
          ? new Date(now.getTime() - cfg.autoArchiveFailedDays * 24 * 60 * 60 * 1000)
          : null,
      },
    ];

    let archived = 0;
    type TerminalStatus = "succeeded" | "failed" | "cancelled";
    const archivePairs: Array<{ taskKind: "novel_workflow" | "agent_run"; ids: string[] }> = [];
    const kinds: Array<{
      taskKind: "novel_workflow" | "agent_run";
      findMany: (status: TerminalStatus, cutoff: Date) => Promise<Array<{ id: string }>>;
    }> = [
      {
        taskKind: "novel_workflow",
        findMany: (status, cutoff) => prisma.novelWorkflowTask.findMany({
          where: { status, finishedAt: { not: null, lt: cutoff } },
          select: { id: true },
          take: 2000,
        }),
      },
      {
        taskKind: "agent_run",
        findMany: (status, cutoff) => prisma.agentRun.findMany({
          where: { status, finishedAt: { not: null, lt: cutoff } },
          select: { id: true },
          take: 2000,
        }),
      },
    ];

    for (const { status, cutoff } of statuses) {
      if (!cutoff) continue;
      for (const { taskKind, findMany } of kinds) {
        const rows = await findMany(status, cutoff);
        if (rows.length === 0) continue;
        const pair = archivePairs.find((candidate) => candidate.taskKind === taskKind);
        if (pair) {
          pair.ids.push(...rows.map((row) => row.id));
        } else {
          archivePairs.push({ taskKind, ids: rows.map((row) => row.id) });
        }
      }
    }
    for (const { taskKind, ids } of archivePairs) {
      for (const taskId of ids) {
        const didArchive = await prisma.$transaction(async (tx) => {
          const current = taskKind === "novel_workflow"
            ? await tx.novelWorkflowTask.findFirst({
              where: { id: taskId, status: { in: [...TERMINAL_WORKFLOW_STATUSES] } },
              select: { id: true },
            })
            : await tx.agentRun.findFirst({
              where: { id: taskId, status: { in: [...TERMINAL_WORKFLOW_STATUSES] } },
              select: { id: true },
            });
          if (!current) return false;
          await tx.taskCenterArchive.upsert({
            where: { taskKind_taskId: { taskKind, taskId } },
            create: { taskKind, taskId },
            update: { archivedAt: now },
          });
          return true;
        });
        if (didArchive) archived += 1;
      }
    }
    return archived;
  }
}
