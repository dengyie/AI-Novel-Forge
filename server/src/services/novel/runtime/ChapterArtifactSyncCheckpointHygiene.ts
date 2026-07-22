import { prisma } from "../../../db/prisma";

/**
 * Checkpoint rows use status=running without leaseOwner/leaseExpiresAt.
 * Claim paths already reclaim when updatedAt is older than this window; a
 * process crash still leaves zombies until the next claim. Interval +
 * pre-read reclaim closes that gap so previous_chapter_guard / artifact
 * sync cannot block the writer LLM pool forever on dead rows.
 */
export const ARTIFACT_CHECKPOINT_RUNNING_STALE_MS = 15 * 60 * 1000;

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** Hot-path callers (hasCompletedCheckpoint) must not thrash findMany every read. */
const DEFAULT_OPPORTUNISTIC_THROTTLE_MS = 30_000;

let sweepTimer: NodeJS.Timeout | null = null;
let sweepInFlight = false;
let lastOpportunisticReclaimAt = 0;

function resolveStaleMs(overrideMs?: number): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs >= 60_000) {
    return Math.floor(overrideMs);
  }
  const fromEnv = Number(process.env.ARTIFACT_CHECKPOINT_STALE_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 60_000) {
    return Math.floor(fromEnv);
  }
  return ARTIFACT_CHECKPOINT_RUNNING_STALE_MS;
}

/**
 * Mark stale `running` checkpoints as `failed` so the next claim can proceed.
 * Returns how many rows were reclaimed.
 */
export async function reclaimStaleRunningArtifactCheckpoints(options?: {
  staleMs?: number;
  limit?: number;
}): Promise<number> {
  const staleMs = resolveStaleMs(options?.staleMs);
  const staleBefore = new Date(Date.now() - staleMs);
  const limit = Math.max(1, Math.min(options?.limit ?? 500, 2000));

  const staleRows = await prisma.chapterArtifactSyncCheckpoint.findMany({
    where: {
      status: "running",
      updatedAt: { lt: staleBefore },
    },
    select: { id: true, artifactType: true, novelId: true, chapterId: true },
    take: limit,
    orderBy: { updatedAt: "asc" },
  }).catch(() => []);

  if (staleRows.length === 0) {
    return 0;
  }

  const ids = staleRows.map((row) => row.id);
  const result = await prisma.chapterArtifactSyncCheckpoint.updateMany({
    where: {
      id: { in: ids },
      status: "running",
      updatedAt: { lt: staleBefore },
    },
    data: {
      status: "failed",
      metadataJson: JSON.stringify({
        reason: "stale_running_reclaimed",
        reclaimedAt: new Date().toISOString(),
        staleMs,
      }),
      updatedAt: new Date(),
    },
  }).catch(() => ({ count: 0 }));

  if (result.count > 0) {
    const byType = staleRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.artifactType] = (acc[row.artifactType] ?? 0) + 1;
      return acc;
    }, {});
    console.warn("[artifact-checkpoint-hygiene] reclaimed stale running checkpoints", {
      count: result.count,
      staleMs,
      byType,
    });
  }

  return result.count;
}

/**
 * Same as reclaimStaleRunningArtifactCheckpoints but process-local throttled.
 * Use from hot claim/read paths; interval scanner calls the unthrottled form.
 */
export async function reclaimStaleRunningArtifactCheckpointsThrottled(options?: {
  staleMs?: number;
  limit?: number;
  throttleMs?: number;
}): Promise<number> {
  const throttleMs = Math.max(
    5_000,
    options?.throttleMs
      ?? (Number.isFinite(Number(process.env.ARTIFACT_CHECKPOINT_RECLAIM_THROTTLE_MS))
        && Number(process.env.ARTIFACT_CHECKPOINT_RECLAIM_THROTTLE_MS) >= 5_000
        ? Math.floor(Number(process.env.ARTIFACT_CHECKPOINT_RECLAIM_THROTTLE_MS))
        : DEFAULT_OPPORTUNISTIC_THROTTLE_MS),
  );
  const now = Date.now();
  if (now - lastOpportunisticReclaimAt < throttleMs) {
    return 0;
  }
  lastOpportunisticReclaimAt = now;
  return reclaimStaleRunningArtifactCheckpoints(options);
}

/** Test helper: reset throttle clock. */
export function resetArtifactCheckpointReclaimThrottleForTests(): void {
  lastOpportunisticReclaimAt = 0;
}

async function tickSweep(): Promise<void> {
  if (sweepInFlight) {
    return;
  }
  sweepInFlight = true;
  try {
    await reclaimStaleRunningArtifactCheckpoints();
  } catch (error) {
    console.warn(
      "[artifact-checkpoint-hygiene] sweep failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    sweepInFlight = false;
  }
}

/** Boot-time + interval sweeper. Safe to call multiple times (idempotent). */
export function startArtifactCheckpointHygieneScanner(options?: {
  intervalMs?: number;
}): void {
  if (sweepTimer) {
    return;
  }
  const fromEnv = Number(process.env.ARTIFACT_CHECKPOINT_SWEEP_MS);
  const resolvedInterval = options?.intervalMs
    ?? (Number.isFinite(fromEnv) && fromEnv >= 15_000 ? Math.floor(fromEnv) : DEFAULT_SWEEP_INTERVAL_MS);
  const intervalMs = Math.max(15_000, resolvedInterval);
  void tickSweep();
  sweepTimer = setInterval(() => {
    void tickSweep();
  }, intervalMs);
  sweepTimer.unref?.();
  console.info("[artifact-checkpoint-hygiene] scanner started", { intervalMs });
}

export function stopArtifactCheckpointHygieneScanner(): void {
  if (!sweepTimer) {
    return;
  }
  clearInterval(sweepTimer);
  sweepTimer = null;
}
