import { taskRetentionConfig } from "../../../../config/taskRetention";
import { prisma } from "../../../../db/prisma";
import {
  ACTIVE_WORKFLOW_STATUSES,
  SUPERSEDE_LANE,
  TERMINAL_PIPELINE_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  selectSupersededGenerationJobIds,
  selectSupersededTaskIds,
} from "../domain/retentionPolicy";
import {
  createTaskRetentionSummary,
  type TaskRetentionSummary,
} from "../domain/retentionTypes";
import { TaskRetentionCleanupStore } from "../infrastructure/TaskRetentionCleanupStore";
import { TaskRetentionOrphanStore } from "../infrastructure/TaskRetentionOrphanStore";
import { AutoDirectorRetentionCoordinator } from "./AutoDirectorRetentionCoordinator";

export class TaskRetentionRunner {
  constructor(
    private readonly cleanupStore = new TaskRetentionCleanupStore(),
    private readonly orphanStore = new TaskRetentionOrphanStore(),
    private readonly autoDirectorCoordinator = new AutoDirectorRetentionCoordinator(),
  ) {}

  async runOnce(now = new Date()): Promise<TaskRetentionSummary> {
    const cfg = taskRetentionConfig;
    const summary = createTaskRetentionSummary();

    try {
      await this.orphanStore.purgeStaleNullNovelOrphans(now, cfg, summary);
      summary.zombieRunningCancelled = await this.autoDirectorCoordinator.cancelZombieRunningTasks(now);
      await this.orphanStore.reconcileOrphanAgentRuns(now, cfg, summary);
      await this.autoDirectorCoordinator.projectStaleActiveWorkflowTasks(now, cfg, summary);
      await this.autoDirectorCoordinator.autoRetryTransientFailedWorkflowTasks(now, cfg, summary);

      const activeDirectorTasks = await prisma.novelWorkflowTask.findMany({
        where: {
          lane: SUPERSEDE_LANE,
          status: { in: [...ACTIVE_WORKFLOW_STATUSES] },
        },
        select: { id: true, novelId: true, lane: true, status: true, finishedAt: true, updatedAt: true },
      });
      const activeDirectorNovelIds = Array.from(
        new Set(
          activeDirectorTasks
            .map((row) => row.novelId)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      let supersededIds: string[] = [];
      if (activeDirectorTasks.length > 0) {
        const terminalSiblings = await prisma.novelWorkflowTask.findMany({
          where: {
            lane: SUPERSEDE_LANE,
            status: { in: [...TERMINAL_WORKFLOW_STATUSES] },
            ...(activeDirectorNovelIds.length > 0
              ? { novelId: { in: activeDirectorNovelIds } }
              : { novelId: null }),
          },
          select: { id: true, novelId: true, lane: true, status: true, finishedAt: true, updatedAt: true },
        });
        const hasNullNovelActive = activeDirectorTasks.some((row) => row.novelId == null);
        const nullNovelTerminals = hasNullNovelActive
          ? await prisma.novelWorkflowTask.findMany({
            where: {
              lane: SUPERSEDE_LANE,
              status: { in: [...TERMINAL_WORKFLOW_STATUSES] },
              novelId: null,
            },
            select: { id: true, novelId: true, lane: true, status: true, finishedAt: true, updatedAt: true },
          })
          : [];
        const seenIds = new Set<string>();
        const supersedeRows = [
          ...activeDirectorTasks,
          ...terminalSiblings,
          ...nullNovelTerminals,
        ].filter((row) => {
          if (seenIds.has(row.id)) return false;
          seenIds.add(row.id);
          return true;
        });
        supersededIds = selectSupersededTaskIds(supersedeRows, now, cfg);
        if (supersededIds.length > 0) {
          await this.cleanupStore.deleteWorkflowTasks(supersededIds, summary);
          summary.supersededDeleted = supersededIds.length;
        }
      }

      const workflowDeletable = await this.cleanupStore.selectAgeDeletableIdsBySql({
        table: "NovelWorkflowTask",
        now,
        cfg,
        excludeIds: supersededIds,
      });
      if (workflowDeletable.length > 0) {
        await this.cleanupStore.deleteWorkflowTasks(workflowDeletable, summary);
      }
    } catch (error) {
      console.warn("[task.retention] novel workflow cleanup failed:", error instanceof Error ? error.message : String(error));
    }

    try {
      summary.runtimeRowsDeleted += await this.cleanupStore.cleanupOrphanFollowUpLogs();
    } catch (error) {
      console.warn("[task.retention] orphan follow-up log cleanup failed:", error instanceof Error ? error.message : String(error));
    }

    try {
      const activePipelineJobs = await prisma.generationJob.findMany({
        where: { status: { in: ["queued", "running"] } },
        select: { id: true, novelId: true, status: true, finishedAt: true, updatedAt: true },
      });
      const activeTakeoverNovelIds = new Set(
        (await prisma.novelWorkflowTask.findMany({
          where: { lane: SUPERSEDE_LANE, status: { in: [...ACTIVE_WORKFLOW_STATUSES] } },
          select: { novelId: true },
        })).map((row) => row.novelId).filter((id): id is string => Boolean(id)),
      );
      const activePipelineNovelIds = new Set(
        activePipelineJobs.map((row) => row.novelId).filter((id): id is string => Boolean(id)),
      );
      const supersedeCandidateNovelIds = Array.from(
        new Set([...activePipelineNovelIds, ...activeTakeoverNovelIds]),
      );
      let pipelineSupersededIds: string[] = [];
      if (supersedeCandidateNovelIds.length > 0 || activePipelineJobs.length > 0) {
        const terminalPipelineRows = supersedeCandidateNovelIds.length > 0
          ? await prisma.generationJob.findMany({
            where: {
              status: { in: [...TERMINAL_PIPELINE_STATUSES] },
              novelId: { in: supersedeCandidateNovelIds },
            },
            select: { id: true, novelId: true, status: true, finishedAt: true, updatedAt: true },
          })
          : [];
        const pipelineSupersedeRows = [...activePipelineJobs, ...terminalPipelineRows];
        pipelineSupersededIds = selectSupersededGenerationJobIds(
          pipelineSupersedeRows,
          activeTakeoverNovelIds,
          now,
          cfg,
        );
        if (pipelineSupersededIds.length > 0) {
          await this.cleanupStore.deleteTerminalGenerationJobs(pipelineSupersededIds, summary);
        }
      }

      const pipelineDeletable = await this.cleanupStore.selectAgeDeletableIdsBySql({
        table: "GenerationJob",
        now,
        cfg,
        excludeIds: pipelineSupersededIds,
      });
      if (pipelineDeletable.length > 0) {
        await this.cleanupStore.deleteTerminalGenerationJobs(pipelineDeletable, summary);
      }
    } catch (error) {
      console.warn("[task.retention] generation job cleanup failed:", error instanceof Error ? error.message : String(error));
    }

    try {
      summary.autoArchived = await this.cleanupStore.autoArchiveTerminalTasks(now, cfg);
    } catch (error) {
      console.warn("[task.retention] auto-archive failed:", error instanceof Error ? error.message : String(error));
    }

    console.info("[task.retention] cleanup done", summary);
    return summary;
  }
}
