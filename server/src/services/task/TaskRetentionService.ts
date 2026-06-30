import type { TaskRetentionConfig } from "../../config/taskRetention";
import { TASK_RETENTION_INTERVAL_MS, taskRetentionConfig } from "../../config/taskRetention";
import { prisma } from "../../db/prisma";
import {
  STALE_AUTO_DIRECTOR_RUNNING_MESSAGE,
  isStaleAutoDirectorRunningTask,
} from "../novel/workflow/autoDirectorStaleTaskRecovery";

const TERMINAL_WORKFLOW_STATUSES = ["succeeded", "failed", "cancelled"] as const;
const TERMINAL_PIPELINE_STATUSES = ["succeeded", "failed", "cancelled"] as const;
const ACTIVE_WORKFLOW_STATUSES = ["queued", "running", "waiting_approval"] as const;
const SUPERSEDE_LANE = "auto_director";

export interface TaskRetentionRow {
  id: string;
  novelId: string | null;
  status: string;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface SupersededCandidateRow {
  id: string;
  novelId: string | null;
  lane: string;
  status: string;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface TaskRetentionSummary {
  novelWorkflowDeleted: number;
  generationJobDeleted: number;
  archiveRowsDeleted: number;
  runtimeRowsDeleted: number;
  supersededDeleted: number;
  zombieRunningCancelled: number;
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

/**
 * 选出"被取代的死任务"——同一 (novelId, lane=auto_director) 桶内已有活跃任务接管时，
 * 桶内所有终态旧任务即视为已被取代，可清理。
 *
 * 与按年龄清理（selectDeletableTaskIds）正交：年龄清理保护最近 N 条做历史参考，
 * 但被新任务接管的旧失败/取消任务没有参考价值，且常驻前端"异常/P0"位置形成噪音。
 *
 * 安全边界：
 * - 桶内无活跃任务（唯一 failed 无接替者）→ 整桶跳过，不误删。
 * - 活跃任务自身（含刚接管的替代任务）→ 非 TERMINAL，永不选中。
 * - 仅处理 auto_director lane；其他 lane 不受影响。
 * - supersededMinAgeMs 给一个可选兜底存活窗口（默认 0 = 立刻可清）。
 */
export function selectSupersededTaskIds(
  rows: SupersededCandidateRow[],
  now: Date,
  cfg: { supersededMinAgeMs: number },
): string[] {
  const nowMs = now.getTime();
  const activeStatuses = new Set<string>(ACTIVE_WORKFLOW_STATUSES);
  const terminalStatuses = new Set<string>(TERMINAL_WORKFLOW_STATUSES);

  const buckets = new Map<string, SupersededCandidateRow[]>();
  for (const row of rows) {
    if (row.lane !== SUPERSEDE_LANE) {
      continue;
    }
    const key = `${row.novelId ?? NULL_NOVEL_BUCKET}::${row.lane}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(row);
  }

  const deletable: string[] = [];
  for (const bucket of buckets.values()) {
    const hasActive = bucket.some((row) => activeStatuses.has(row.status));
    if (!hasActive) {
      continue;
    }
    for (const row of bucket) {
      if (!terminalStatuses.has(row.status)) {
        continue;
      }
      const effectiveTime = row.finishedAt?.getTime() ?? row.updatedAt.getTime();
      if (nowMs - effectiveTime < cfg.supersededMinAgeMs) {
        continue;
      }
      deletable.push(row.id);
    }
  }

  // deterministic output (id ascending) so the deletion set is stable across runs
  return deletable.sort((a, b) => a.localeCompare(b));
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

  /**
   * Delete a set of NovelWorkflowTask rows plus their dependent rows.
   * Shared by the age-based sweep and the supersede sweep so both take the same
   * path: runtime tables (no FK, by workflowTaskId) → main row (Prisma-emulated
   * onDelete cascade) → archive rows. Status is re-filtered at delete time to
   * guard against a row flipping back to active between selection and deletion.
   */
  private async deleteWorkflowTasks(ids: string[], summary: TaskRetentionSummary): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const runtimeDeleteResults = await Promise.all([
      prisma.directorRuntimeEvent.deleteMany({ where: { workflowTaskId: { in: ids } } }),
      prisma.directorRuntimeExecution.deleteMany({ where: { workflowTaskId: { in: ids } } }),
      prisma.directorRuntimeCommand.deleteMany({ where: { workflowTaskId: { in: ids } } }),
      prisma.directorRuntimeInstance.deleteMany({ where: { workflowTaskId: { in: ids } } }),
    ]);
    summary.runtimeRowsDeleted += runtimeDeleteResults.reduce((sum, r) => sum + r.count, 0);

    const workflowDeleteResult = await prisma.novelWorkflowTask.deleteMany({
      where: { id: { in: ids }, status: { in: [...TERMINAL_WORKFLOW_STATUSES] } },
    });
    summary.novelWorkflowDeleted += workflowDeleteResult.count;

    const archiveWorkflowResult = await prisma.taskCenterArchive.deleteMany({
      where: { taskKind: "novel_workflow", taskId: { in: ids } },
    });
    summary.archiveRowsDeleted += archiveWorkflowResult.count;
  }

  /**
   * Mark zombie auto_director running tasks (heartbeat stale, no manual-recovery
   * flag) as cancelled — two-step: this cycle only cancels, a later cycle's
   * supersede sweep deletes them. Reuses the conservative isStaleAutoDirectorRunningTask
   * guard so a task mid-respawn (recent heartbeat) or stuck in a non-structured
   * step is never touched.
   */
  private async cancelZombieRunningTasks(now: Date): Promise<number> {
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
        currentItemKey: true,
        pendingManualRecovery: true,
        cancelRequestedAt: true,
        heartbeatAt: true,
        updatedAt: true,
      },
    });
    const zombieIds = runningRows
      .filter((row) => isStaleAutoDirectorRunningTask(row, now))
      .map((row) => row.id);
    if (zombieIds.length === 0) {
      return 0;
    }
    await prisma.novelWorkflowTask.updateMany({
      where: { id: { in: zombieIds } },
      data: {
        status: "cancelled",
        cancelRequestedAt: now,
        finishedAt: now,
        heartbeatAt: now,
        lastError: STALE_AUTO_DIRECTOR_RUNNING_MESSAGE,
      },
    });
    return zombieIds.length;
  }

  async runOnce(now = new Date()): Promise<TaskRetentionSummary> {
    const cfg = taskRetentionConfig;
    const summary: TaskRetentionSummary = {
      novelWorkflowDeleted: 0,
      generationJobDeleted: 0,
      archiveRowsDeleted: 0,
      runtimeRowsDeleted: 0,
      supersededDeleted: 0,
      zombieRunningCancelled: 0,
    };

    // --- NovelWorkflowTask ---
    try {
      // Step 1: cancel zombie running tasks (two-step: they become supersedeable next).
      summary.zombieRunningCancelled = await this.cancelZombieRunningTasks(now);

      // Step 2: supersede sweep — terminal auto_director tasks whose (novel,lane)
      // bucket already has an active task are dead weight; delete immediately.
      const supersedeRows = await prisma.novelWorkflowTask.findMany({
        where: { lane: SUPERSEDE_LANE },
        select: { id: true, novelId: true, lane: true, status: true, finishedAt: true, updatedAt: true },
      });
      const supersededIds = selectSupersededTaskIds(supersedeRows, now, cfg);
      if (supersededIds.length > 0) {
        await this.deleteWorkflowTasks(supersededIds, summary);
        summary.supersededDeleted = supersededIds.length;
      }

      // Step 3: age-based retention sweep (keep-window + status aging).
      const workflowRows = await prisma.novelWorkflowTask.findMany({
        where: { status: { in: [...TERMINAL_WORKFLOW_STATUSES] } },
        select: { id: true, novelId: true, status: true, finishedAt: true, updatedAt: true },
      });
      const workflowDeletable = selectDeletableTaskIds(workflowRows, now, cfg).filter(
        (id) => !supersededIds.includes(id),
      );
      if (workflowDeletable.length > 0) {
        await this.deleteWorkflowTasks(workflowDeletable, summary);
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
