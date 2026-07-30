import { prisma } from "../../../db/prisma";

/**
 * 章节「generating」陈旧锁自愈。
 *
 * 背景（生产 P1）：writer 失败路径（LLM 超时 / 客户端断连 / 进程崩溃）会把 Chapter
 * 留在 `chapterStatus=generating`，并遗留一个 `status=running` 的僵尸 AgentRun。
 * 锁没有任何自愈——本会话曾因 writer 超时连崩，被迫 4 次手动 SQL 回收。
 * 这里复用 ChapterArtifactSyncCheckpointHygiene 的 interval +  opportunistic 模式，
 * 周期性把「卡住超过窗口且无任何活跃 run」的章节 reset 回 needs_repair，并把僵尸
 * running run 标记 cancelled，让导演/手动重试可以无人工介入地继续。
 *
 * 安全约束：
 * - 只动 `chapterStatus=generating` 且 `updatedAt` 早于窗口、并且**没有**任何近期
 *   活跃 running run 的章节；活跃 run（startedAt/updatedAt 在窗口内）所在的章节跳过，
 *   绝不打断一次真正在跑的写作。
 * - reset 用条件 update（chapterStatus 仍 = generating），并发电竞态下失败即放弃。
 */

/** 与 writer 最长预算对齐：超过此窗口仍 generating 即视为卡死（默认 30 分钟）。 */
export const CHAPTER_GENERATING_STALE_MS = 30 * 60 * 1000;

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_OPPORTUNISTIC_THROTTLE_MS = 60_000;

let sweepTimer: NodeJS.Timeout | null = null;
let sweepInFlight = false;
let lastOpportunisticReclaimAt = 0;

function resolveStaleMs(overrideMs?: number): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs >= 60_000) {
    return Math.floor(overrideMs);
  }
  const fromEnv = Number(process.env.CHAPTER_GENERATING_STALE_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 60_000) {
    return Math.floor(fromEnv);
  }
  return CHAPTER_GENERATING_STALE_MS;
}

export interface ChapterLockReclaimResult {
  chaptersReset: number;
  runsCancelled: number;
  skippedActiveChapters: number;
}

/**
 * 回收卡死的 generating 章节锁。返回处理统计。
 * 幂等：并发电竞态下条件 update 不命中即视为已被别处处理。
 */
export async function reclaimStaleChapterGeneratingLocks(options?: {
  staleMs?: number;
  limit?: number;
}): Promise<ChapterLockReclaimResult> {
  const staleMs = resolveStaleMs(options?.staleMs);
  const staleBefore = new Date(Date.now() - staleMs);
  const limit = Math.max(1, Math.min(options?.limit ?? 200, 1000));
  const result: ChapterLockReclaimResult = {
    chaptersReset: 0,
    runsCancelled: 0,
    skippedActiveChapters: 0,
  };

  const stuckChapters = await prisma.chapter.findMany({
    where: {
      chapterStatus: "generating",
      updatedAt: { lt: staleBefore },
    },
    select: { id: true, novelId: true, order: true, updatedAt: true },
    take: limit,
    orderBy: { updatedAt: "asc" },
  }).catch(() => []);

  if (stuckChapters.length === 0) {
    return result;
  }

  const chapterIds = stuckChapters.map((c) => c.id);
  // 这些章节名下所有 running run：区分「真在跑」（近期活跃）与「僵尸」（早该结束）。
  const runningRuns = await prisma.agentRun.findMany({
    where: { chapterId: { in: chapterIds }, status: "running" },
    select: { id: true, chapterId: true, startedAt: true, updatedAt: true },
  }).catch(() => []);

  const activeChapterIds = new Set<string>();
  const zombieRunIds: string[] = [];
  for (const run of runningRuns) {
    const lastActivity = run.updatedAt ?? run.startedAt ?? new Date(0);
    if (lastActivity >= staleBefore) {
      // 窗口内仍有活动 → 视为真在跑，整章跳过，绝不动锁。
      if (run.chapterId) {
        activeChapterIds.add(run.chapterId);
      }
    } else {
      zombieRunIds.push(run.id);
    }
  }

  // 取消僵尸 running run（条件 update：仍 running 才取消，避免覆盖刚被正常 settle 的）。
  if (zombieRunIds.length > 0) {
    const cancelled = await prisma.agentRun.updateMany({
      where: { id: { in: zombieRunIds }, status: "running" },
      data: {
        status: "cancelled",
        error: "stale generating lock reclaimed by hygiene scanner",
        finishedAt: new Date(),
        updatedAt: new Date(),
      },
    }).catch(() => ({ count: 0 }));
    result.runsCancelled = cancelled.count;
  }

  const now = new Date();
  for (const chapter of stuckChapters) {
    if (activeChapterIds.has(chapter.id)) {
      result.skippedActiveChapters += 1;
      continue;
    }
    const reset = await prisma.chapter.updateMany({
      where: { id: chapter.id, chapterStatus: "generating" },
      data: { chapterStatus: "needs_repair", updatedAt: now },
    }).catch(() => ({ count: 0 }));
    if (reset.count > 0) {
      result.chaptersReset += 1;
    }
  }

  if (result.chaptersReset > 0 || result.runsCancelled > 0) {
    console.warn("[chapter-lock-hygiene] reclaimed stale generating locks", {
      staleMs,
      chaptersReset: result.chaptersReset,
      runsCancelled: result.runsCancelled,
      skippedActiveChapters: result.skippedActiveChapters,
      chapterIds: stuckChapters
        .filter((c) => !activeChapterIds.has(c.id))
        .map((c) => ({ id: c.id, order: c.order })),
    });
  }

  return result;
}

/** 进程内节流版：供热点路径调用；interval 扫描用非节流版。 */
export async function reclaimStaleChapterGeneratingLocksThrottled(options?: {
  staleMs?: number;
  limit?: number;
  throttleMs?: number;
}): Promise<ChapterLockReclaimResult> {
  const throttleMs = Math.max(
    10_000,
    options?.throttleMs
      ?? (Number.isFinite(Number(process.env.CHAPTER_LOCK_RECLAIM_THROTTLE_MS))
        && Number(process.env.CHAPTER_LOCK_RECLAIM_THROTTLE_MS) >= 10_000
        ? Math.floor(Number(process.env.CHAPTER_LOCK_RECLAIM_THROTTLE_MS))
        : DEFAULT_OPPORTUNISTIC_THROTTLE_MS),
  );
  const now = Date.now();
  if (now - lastOpportunisticReclaimAt < throttleMs) {
    return { chaptersReset: 0, runsCancelled: 0, skippedActiveChapters: 0 };
  }
  lastOpportunisticReclaimAt = now;
  return reclaimStaleChapterGeneratingLocks(options);
}

/** Test helper: reset throttle clock. */
export function resetChapterLockReclaimThrottleForTests(): void {
  lastOpportunisticReclaimAt = 0;
}

async function tickSweep(): Promise<void> {
  if (sweepInFlight) {
    return;
  }
  sweepInFlight = true;
  try {
    await reclaimStaleChapterGeneratingLocks();
  } catch (error) {
    console.warn(
      "[chapter-lock-hygiene] sweep failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    sweepInFlight = false;
  }
}

/** Boot-time + interval sweeper. 幂等，可重复调用。 */
export function startChapterLockHygieneScanner(options?: { intervalMs?: number }): void {
  if (sweepTimer) {
    return;
  }
  const fromEnv = Number(process.env.CHAPTER_LOCK_SWEEP_MS);
  const resolvedInterval = options?.intervalMs
    ?? (Number.isFinite(fromEnv) && fromEnv >= 15_000 ? Math.floor(fromEnv) : DEFAULT_SWEEP_INTERVAL_MS);
  const intervalMs = Math.max(15_000, resolvedInterval);
  void tickSweep();
  sweepTimer = setInterval(() => {
    void tickSweep();
  }, intervalMs);
  sweepTimer.unref?.();
  console.info("[chapter-lock-hygiene] scanner started", { intervalMs });
}

export function stopChapterLockHygieneScanner(): void {
  if (!sweepTimer) {
    return;
  }
  clearInterval(sweepTimer);
  sweepTimer = null;
}
