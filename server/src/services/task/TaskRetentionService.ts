import type { TaskRetentionConfig } from "../../config/taskRetention";
import { TASK_RETENTION_INTERVAL_MS, taskRetentionConfig } from "../../config/taskRetention";
import { prisma } from "../../db/prisma";

const TERMINAL_WORKFLOW_STATUSES = ["succeeded", "failed", "cancelled"] as const;
const TERMINAL_PIPELINE_STATUSES = ["succeeded", "failed", "cancelled"] as const;

export interface TaskRetentionRow {
  id: string;
  novelId: string | null;
  status: string;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface TaskRetentionSummary {
  novelWorkflowDeleted: number;
  generationJobDeleted: number;
  archiveRowsDeleted: number;
  runtimeRowsDeleted: number;
}

const NULL_NOVEL_BUCKET = "__none__";

export function selectDeletableTaskIds(
  rows: TaskRetentionRow[],
  now: Date,
  cfg: TaskRetentionConfig,
): string[] {
  const nowMs = now.getTime();
  const succeededCutoffMs = cfg.succeededDays * 24 * 60 * 60 * 1000;
  const failedCutoffMs = cfg.failedDays * 24 * 60 * 60 * 1000;

  const buckets = new Map<string, TaskRetentionRow[]>();
  for (const row of rows) {
    const key = row.novelId ?? NULL_NOVEL_BUCKET;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(row);
  }

  const deletable: string[] = [];

  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => {
      const aTime = a.finishedAt?.getTime() ?? a.updatedAt.getTime();
      const bTime = b.finishedAt?.getTime() ?? b.updatedAt.getTime();
      // id tiebreaker keeps the deletion set deterministic when batch tasks
      // share an identical timestamp.
      return bTime - aTime || a.id.localeCompare(b.id);
    });

    for (let i = 0; i < bucket.length; i++) {
      if (i < cfg.keepPerNovel) continue;
      const row = bucket[i];
      const effectiveTime = row.finishedAt?.getTime() ?? row.updatedAt.getTime();
      const ageMs = nowMs - effectiveTime;
      if (row.status === "failed") {
        if (ageMs > failedCutoffMs) deletable.push(row.id);
      } else {
        if (ageMs > succeededCutoffMs) deletable.push(row.id);
      }
    }
  }

  return deletable;
}

export class TaskRetentionService {
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs = TASK_RETENTION_INTERVAL_MS): void {
    if (this.timer) return;
    void this.runOnce().catch((error) => {
      console.warn("[task.retention] initial cleanup failed:", error instanceof Error ? error.message : String(error));
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        console.warn("[task.retention] periodic cleanup failed:", error instanceof Error ? error.message : String(error));
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<TaskRetentionSummary> {
    const cfg = taskRetentionConfig;
    const summary: TaskRetentionSummary = {
      novelWorkflowDeleted: 0,
      generationJobDeleted: 0,
      archiveRowsDeleted: 0,
      runtimeRowsDeleted: 0,
    };

    // --- NovelWorkflowTask ---
    try {
      const workflowRows = await prisma.novelWorkflowTask.findMany({
        where: { status: { in: [...TERMINAL_WORKFLOW_STATUSES] } },
        select: { id: true, novelId: true, status: true, finishedAt: true, updatedAt: true },
      });
      const workflowDeletable = selectDeletableTaskIds(workflowRows, now, cfg);

      if (workflowDeletable.length > 0) {
        // Runtime tables without FK — delete by workflowTaskId before the main row
        const runtimeDeleteResults = await Promise.all([
          prisma.directorRuntimeEvent.deleteMany({ where: { workflowTaskId: { in: workflowDeletable } } }),
          prisma.directorRuntimeExecution.deleteMany({ where: { workflowTaskId: { in: workflowDeletable } } }),
          prisma.directorRuntimeCommand.deleteMany({ where: { workflowTaskId: { in: workflowDeletable } } }),
          prisma.directorRuntimeInstance.deleteMany({ where: { workflowTaskId: { in: workflowDeletable } } }),
        ]);
        summary.runtimeRowsDeleted = runtimeDeleteResults.reduce((sum, r) => sum + r.count, 0);

        // Main delete — Prisma emulates declared onDelete (Cascade/SetNull)
        const workflowDeleteResult = await prisma.novelWorkflowTask.deleteMany({
          where: { id: { in: workflowDeletable } },
        });
        summary.novelWorkflowDeleted = workflowDeleteResult.count;

        // Archive rows
        const archiveWorkflowResult = await prisma.taskCenterArchive.deleteMany({
          where: { taskKind: "novel_workflow", taskId: { in: workflowDeletable } },
        });
        summary.archiveRowsDeleted += archiveWorkflowResult.count;
      }
    } catch (error) {
      console.warn("[task.retention] novel workflow cleanup failed:", error instanceof Error ? error.message : String(error));
    }

    // --- GenerationJob ---
    try {
      const pipelineRows = await prisma.generationJob.findMany({
        where: { status: { in: [...TERMINAL_PIPELINE_STATUSES] } },
        select: { id: true, novelId: true, status: true, finishedAt: true, updatedAt: true },
      });
      const pipelineDeletable = selectDeletableTaskIds(pipelineRows, now, cfg);

      if (pipelineDeletable.length > 0) {
        const pipelineDeleteResult = await prisma.generationJob.deleteMany({
          where: { id: { in: pipelineDeletable } },
        });
        summary.generationJobDeleted = pipelineDeleteResult.count;

        const archivePipelineResult = await prisma.taskCenterArchive.deleteMany({
          where: { taskKind: "novel_pipeline", taskId: { in: pipelineDeletable } },
        });
        summary.archiveRowsDeleted += archivePipelineResult.count;
      }
    } catch (error) {
      console.warn("[task.retention] generation job cleanup failed:", error instanceof Error ? error.message : String(error));
    }

    console.info("[task.retention] cleanup done", summary);
    return summary;
  }
}

export const taskRetentionService = new TaskRetentionService();
