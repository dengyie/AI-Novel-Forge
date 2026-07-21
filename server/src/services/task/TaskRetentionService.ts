import { Prisma } from "@prisma/client";
import type { TaskRetentionConfig } from "../../config/taskRetention";
import { TASK_RETENTION_INTERVAL_MS, taskRetentionConfig } from "../../config/taskRetention";
import { prisma } from "../../db/prisma";
import { deleteWorkflowTasksHard } from "../novel/novelDeleteCascade";
import {
  STALE_AUTO_DIRECTOR_RUNNING_MESSAGE,
  isStaleAutoDirectorRunningTaskBroad,
} from "../novel/workflow/autoDirectorStaleTaskRecovery";

const TERMINAL_WORKFLOW_STATUSES = ["succeeded", "failed", "cancelled"] as const;
const TERMINAL_PIPELINE_STATUSES = ["succeeded", "failed", "cancelled"] as const;
const ACTIVE_WORKFLOW_STATUSES = ["queued", "running", "waiting_approval"] as const;
const ACTIVE_AGENT_STATUSES = ["queued", "running", "waiting_approval"] as const;
const SUPERSEDE_LANE = "auto_director";
const NULL_NOVEL_ORPHAN_MESSAGE = "空小说引用任务已过期，由任务保留策略清理。";

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
  nullNovelOrphansDeleted: number;
  nullNovelAgentRunsDeleted: number;
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

export interface GenerationJobSupersedeRow {
  id: string;
  novelId: string | null;
  status: string;
  finishedAt: Date | null;
  updatedAt: Date;
}

const ACTIVE_PIPELINE_STATUSES = ["queued", "running", "waiting_approval"] as const;
const TERMINAL_PIPELINE_STATUSES_SET = new Set<string>(TERMINAL_PIPELINE_STATUSES);

/**
 * 选出"被取代的终态 GenerationJob"——同 novel 桶内已有活跃任务接管时，桶内所有
 * 终态旧 pipeline 任务视为已被取代，可清理。GenerationJob 无 lane 字段，桶键只用
 * novelId。活跃判定同时认 GenerationJob 自身的活跃态和同 novel 的 auto_director
 * NovelWorkflowTask 接管（takeover 接管后，旧 pipeline 失败任务即死任务）。
 *
 * 与 selectSupersededTaskIds 同构的安全边界：桶内无活跃 → 整桶跳过；活跃自身非
 * TERMINAL 永不选中；supersededMinAgeMs 兜底存活窗口。
 */
export function selectSupersededGenerationJobIds(
  rows: GenerationJobSupersedeRow[],
  activeNovelIds: ReadonlySet<string>,
  now: Date,
  cfg: { supersededMinAgeMs: number },
): string[] {
  const nowMs = now.getTime();
  const activeStatuses = new Set<string>(ACTIVE_PIPELINE_STATUSES);

  const buckets = new Map<string, GenerationJobSupersedeRow[]>();
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
  for (const [novelKey, bucket] of buckets) {
    const hasActivePipeline = bucket.some((row) => activeStatuses.has(row.status));
    const hasActiveTakeover = novelKey !== NULL_NOVEL_BUCKET && activeNovelIds.has(novelKey);
    if (!hasActivePipeline && !hasActiveTakeover) {
      continue;
    }
    for (const row of bucket) {
      if (!TERMINAL_PIPELINE_STATUSES_SET.has(row.status)) {
        continue;
      }
      const effectiveTime = row.finishedAt?.getTime() ?? row.updatedAt.getTime();
      if (nowMs - effectiveTime < cfg.supersededMinAgeMs) {
        continue;
      }
      deletable.push(row.id);
    }
  }

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
      // follow-up action/notification logs reference taskId (no FK, indexed) — without this
      // they become orphans that pile up in the "导演跟进" panel after the task is deleted.
      prisma.autoDirectorFollowUpActionLog.deleteMany({ where: { taskId: { in: ids } } }),
      prisma.autoDirectorFollowUpNotificationLog.deleteMany({ where: { taskId: { in: ids } } }),
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
   * null-novel active workflow/agent leftovers:
   * - create-before-bind tasks that never attached a novel and went stale
   * - historical SetNull orphans after novel delete (pre-cascade / pre-purge)
   * Hard-delete after nullNovelStaleHours so waiting_approval cannot live forever.
   */
  private async purgeStaleNullNovelOrphans(
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
      await prisma.novelWorkflowTask.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          heartbeatAt: now,
          lastError: NULL_NOVEL_ORPHAN_MESSAGE,
        },
      });
      const cascadeSummary = await deleteWorkflowTasksHard(ids);
      summary.novelWorkflowDeleted += cascadeSummary.workflowTasksDeleted;
      summary.runtimeRowsDeleted += cascadeSummary.runtimeRowsDeleted + cascadeSummary.followUpRowsDeleted;
      summary.archiveRowsDeleted += cascadeSummary.archiveRowsDeleted;
      summary.nullNovelOrphansDeleted += cascadeSummary.workflowTasksDeleted;
    }

    const staleAgents = await prisma.agentRun.findMany({
      where: {
        novelId: null,
        status: { in: [...ACTIVE_AGENT_STATUSES] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true },
    });
    if (staleAgents.length > 0) {
      const agentIds = staleAgents.map((row) => row.id);
      await prisma.agentApproval.updateMany({
        where: { runId: { in: agentIds }, status: "pending" },
        data: {
          status: "expired",
          decisionNote: NULL_NOVEL_ORPHAN_MESSAGE,
          decidedAt: now,
        },
      });
      await prisma.agentRun.deleteMany({ where: { id: { in: agentIds } } });
      const archiveAgent = await prisma.taskCenterArchive.deleteMany({
        where: { taskKind: "agent_run", taskId: { in: agentIds } },
      });
      summary.archiveRowsDeleted += archiveAgent.count;
      summary.nullNovelAgentRunsDeleted += agentIds.length;
    }
  }

  /**
   * Mark zombie auto_director running tasks (heartbeat stale, no manual-recovery
   * flag) as cancelled — two-step: this cycle only cancels, a later cycle's
   * supersede sweep deletes them. Uses the broad stale guard (no currentItemKey
   * restriction) so zombies stuck in chapter-execution stages (e.g. quality_repair)
   * are caught too, not just structured-outline stages.
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
        pendingManualRecovery: true,
        cancelRequestedAt: true,
        heartbeatAt: true,
        updatedAt: true,
      },
    });
    const zombieIds = runningRows
      .filter((row) => isStaleAutoDirectorRunningTaskBroad(row, now))
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

  /**
   * Age-based deletable ids via SQL window ranking — avoids loading every terminal
   * row into Node for keep-window + status aging.
   */
  private async selectAgeDeletableIdsBySql(input: {
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
    // Prisma 默认表名与 model 同名；标识符必须用 raw，不可参数化
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

  async runOnce(now = new Date()): Promise<TaskRetentionSummary> {
    const cfg = taskRetentionConfig;
    const summary: TaskRetentionSummary = {
      novelWorkflowDeleted: 0,
      generationJobDeleted: 0,
      archiveRowsDeleted: 0,
      runtimeRowsDeleted: 0,
      supersededDeleted: 0,
      zombieRunningCancelled: 0,
      nullNovelOrphansDeleted: 0,
      nullNovelAgentRunsDeleted: 0,
    };

    // --- NovelWorkflowTask ---
    try {
      // Step 0: null-novel active orphans (waiting_approval forever after delete / abandoned create).
      await this.purgeStaleNullNovelOrphans(now, cfg, summary);

      // Step 1: cancel zombie running tasks (two-step: they become supersedeable next).
      summary.zombieRunningCancelled = await this.cancelZombieRunningTasks(now);

      // Step 2: supersede sweep — only load novels that currently have an active
      // auto_director task, plus their terminal siblings (not the whole table).
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
        // null-novel active buckets: also pull terminal null-novel siblings
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
          await this.deleteWorkflowTasks(supersededIds, summary);
          summary.supersededDeleted = supersededIds.length;
        }
      }

      // Step 3: age-based retention via SQL window (keep-window + status aging).
      const workflowDeletable = await this.selectAgeDeletableIdsBySql({
        table: "NovelWorkflowTask",
        now,
        cfg,
        excludeIds: supersededIds,
      });
      if (workflowDeletable.length > 0) {
        await this.deleteWorkflowTasks(workflowDeletable, summary);
      }
    } catch (error) {
      console.warn("[task.retention] novel workflow cleanup failed:", error instanceof Error ? error.message : String(error));
    }

    // --- orphan follow-up logs (taskId no longer exists) ---
    // Pushdown: NOT EXISTS delete, never load the full task id set into Node.
    try {
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
      summary.runtimeRowsDeleted += Number(orphanActionDelete) + Number(orphanNotificationDelete);
    } catch (error) {
      console.warn("[task.retention] orphan follow-up log cleanup failed:", error instanceof Error ? error.message : String(error));
    }

    // --- GenerationJob ---
    try {
      // Supersede: only load active pipeline jobs + terminals for novels that have
      // an active pipeline or auto_director takeover — not every GenerationJob row.
      // GenerationJob 无 waiting_approval 状态；活跃态仅 queued/running
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
      // GenerationJob.novelId 为必填（schema 非空），无 null-novel 桶；null 仅存在于选择器防御分支
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
          const pipelineSupersededDeleteResult = await prisma.generationJob.deleteMany({
            where: { id: { in: pipelineSupersededIds }, status: { in: [...TERMINAL_PIPELINE_STATUSES] } },
          });
          summary.generationJobDeleted += pipelineSupersededDeleteResult.count;

          const archivePipelineSupersededResult = await prisma.taskCenterArchive.deleteMany({
            where: { taskKind: "novel_pipeline", taskId: { in: pipelineSupersededIds } },
          });
          summary.archiveRowsDeleted += archivePipelineSupersededResult.count;
        }
      }

      // Age-based retention via SQL window.
      const pipelineDeletable = await this.selectAgeDeletableIdsBySql({
        table: "GenerationJob",
        now,
        cfg,
        excludeIds: pipelineSupersededIds,
      });

      if (pipelineDeletable.length > 0) {
        const pipelineDeleteResult = await prisma.generationJob.deleteMany({
          where: { id: { in: pipelineDeletable } },
        });
        summary.generationJobDeleted += pipelineDeleteResult.count;

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
