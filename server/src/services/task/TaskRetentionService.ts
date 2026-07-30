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
  autoArchived: number;
  orphanAgentRunsCancelled: number;
  staleRunningProjected: number;
  waitingApprovalFlagged: number;
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

  /**
   * 自动归档终态任务（autopilot P1a）：终态超过窗口即从默认列表/overview 消失。
   * - succeeded/cancelled → autoArchiveSucceededHours（默认 24h）
   * - failed → autoArchiveFailedDays（默认 7d，留人工查看窗口）
   * - 窗口配 0 = 该状态不自动归档。
   * 只写 TaskCenterArchive（幂等 createMany skipDuplicates），不删数据；
   * 数据生命周期仍由年龄硬删（succeededDays/failedDays）管理。
   */
  private async autoArchiveTerminalTasks(now: Date, cfg: TaskRetentionConfig): Promise<number> {
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
        const pair = archivePairs.find((p) => p.taskKind === taskKind);
        if (pair) {
          pair.ids.push(...rows.map((r) => r.id));
        } else {
          archivePairs.push({ taskKind, ids: rows.map((r) => r.id) });
        }
      }
    }
    for (const { taskKind, ids } of archivePairs) {
      // 逐条 upsert 而非 createMany：SQLite 下 taskCenterArchive.createMany 类型/兼容
      // 受限；且手动归档若已存在（同 taskKind+taskId 唯一键）需刷新 archivedAt 而非报错。
      for (const taskId of ids) {
        await prisma.taskCenterArchive.upsert({
          where: { taskKind_taskId: { taskKind, taskId } },
          create: { taskKind, taskId },
          update: { archivedAt: now },
        });
        archived += 1;
      }
    }
    return archived;
  }

  /**
   * 孤儿 AgentRun 自愈（autopilot P1b）：run 仍 active 但宿主已不可能再让它 settle——
   * 1) novelId 指向已删除的小说（历史 SetNull 前的残留）
   * 2) chapterId 指向已删除的章节
   * 3) 宿主章节已到终态（非 generating/pending_generation）——成功/失败路径漏 settle 的
   *    幽灵（生产 3 条：2 条章节 completed 14 天、1 条 pending_review）。
   * 与 ChapterGeneratingLockHygiene 互补：那个管「章节卡 generating」，这个管「章节早
   * 走完、run 漏 settle」。只 cancel 满足窗口（orphanAgentRunStaleHours）的，给慢
   * settle 路径留余量；pending approvals 一并 expire，行硬删（与 null-novel 孤儿同级：
   * 无参考价值且不可恢复）。
   */
  private async reconcileOrphanAgentRuns(
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

    const novelIds = Array.from(new Set(activeRuns.map((r) => r.novelId).filter((id): id is string => Boolean(id))));
    const chapterIds = Array.from(new Set(activeRuns.map((r) => r.chapterId).filter((id): id is string => Boolean(id))));
    const [existingNovels, existingChapters] = await Promise.all([
      novelIds.length > 0
        ? prisma.novel.findMany({ where: { id: { in: novelIds } }, select: { id: true } })
        : Promise.resolve([]),
      chapterIds.length > 0
        ? prisma.chapter.findMany({ where: { id: { in: chapterIds } }, select: { id: true, chapterStatus: true } })
        : Promise.resolve([]),
    ]);
    const liveNovelIds = new Set(existingNovels.map((r) => r.id));
    const chapterStatusById = new Map<string, string>(
      existingChapters.map((r) => [r.id, r.chapterStatus ?? "unplanned"]),
    );
    // 章节仍处于写作相关状态 → run 可能真在跑（锁自愈扫描器管那个），这里不动。
    const WRITING_CHAPTER_STATUSES = new Set(["generating", "pending_generation"]);

    const orphanIds: string[] = [];
    for (const run of activeRuns) {
      if (run.novelId && !liveNovelIds.has(run.novelId)) {
        orphanIds.push(run.id); // 小说已删
        continue;
      }
      if (run.chapterId) {
        const chapterStatus = chapterStatusById.get(run.chapterId);
        if (chapterStatus === undefined) {
          orphanIds.push(run.id); // 章节已删
        } else if (!WRITING_CHAPTER_STATUSES.has(chapterStatus)) {
          orphanIds.push(run.id); // 章节已终态，run 漏 settle
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
        decisionNote: "宿主已终态或删除，孤儿运行由任务保留策略自动取消。",
        decidedAt: now,
      },
    });
    const cancelled = await prisma.agentRun.updateMany({
      where: { id: { in: orphanIds }, status: { in: [...ACTIVE_AGENT_STATUSES] } },
      data: {
        status: "cancelled",
        finishedAt: now,
        currentStep: "cancelled",
        error: "宿主已终态或删除，孤儿运行由任务保留策略自动取消。",
      },
    });
    // 立即归档：从任务中心默认视图消失（保留行供审计，生命周期交给年龄硬删的上游逻辑）。
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

  /**
   * 状态投影自愈（autopilot P2）：校正「活跃但宿主/执行器已不在」的任务投影。
   *
   * a) NovelWorkflowTask running 无心跳超窗口（auto_director 之外的 lane 没有僵尸
   *    清理，manual_create 等卡 running 会一直显示「进行中」）→ failed +
   *    pendingManualRecovery=true，进 recovery candidates 由用户决定 resume/retry。
   *    auto_director 已被 cancelZombieRunningTasks 处理，这里只兜其它 lane。
   * b) waiting_approval 超窗口无人审批 → pendingManualRecovery=true（状态不动，
   *    进 recovery candidates / overview.recoveryCandidateCount 即 attention）。
   *
   * 条件 update 防竞态：只动仍处原状态、且 pendingManualRecovery 仍未置位的行。
   */
  private async projectStaleActiveWorkflowTasks(
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
        where: { id: { in: ids }, status: "running", pendingManualRecovery: false },
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
      autoArchived: 0,
      orphanAgentRunsCancelled: 0,
      staleRunningProjected: 0,
      waitingApprovalFlagged: 0,
    };

    // --- NovelWorkflowTask ---
    try {
      // Step 0: null-novel active orphans (waiting_approval forever after delete / abandoned create).
      await this.purgeStaleNullNovelOrphans(now, cfg, summary);

      // Step 1: cancel zombie running tasks (two-step: they become supersedeable next).
      summary.zombieRunningCancelled = await this.cancelZombieRunningTasks(now);

      // Step 1b: orphan AgentRuns whose host is gone/terminal can never settle — cancel+archive.
      await this.reconcileOrphanAgentRuns(now, cfg, summary);

      // Step 1c: projection self-heal — fake-running → failed+recoverable; stale approvals → attention.
      await this.projectStaleActiveWorkflowTasks(now, cfg, summary);

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

    // --- Auto-archive terminal tasks (visibility only; runs last so hard-deletes above win) ---
    try {
      summary.autoArchived = await this.autoArchiveTerminalTasks(now, cfg);
    } catch (error) {
      console.warn("[task.retention] auto-archive failed:", error instanceof Error ? error.message : String(error));
    }

    console.info("[task.retention] cleanup done", summary);
    return summary;
  }
}

export const taskRetentionService = new TaskRetentionService();
