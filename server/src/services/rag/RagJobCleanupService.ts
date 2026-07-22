import { prisma } from "../../db/prisma";
import type { RagJobStatus } from "./types";

const FINISHED_RAG_JOB_STATUSES: RagJobStatus[] = ["succeeded", "failed", "cancelled"];
const ACTIVE_RAG_JOB_STATUSES: RagJobStatus[] = ["queued", "running"];

/** Default: cancel active jobs older than 7 days (zombie backlog from disabled/broken worker). */
const DEFAULT_STALE_ACTIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Running without progress longer than this is treated as interrupted zombie. */
const DEFAULT_STALE_RUNNING_MAX_AGE_MS = 30 * 60 * 1000;

function resolvePositiveMs(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey]);
  if (Number.isFinite(raw) && raw >= 60_000) {
    return Math.floor(raw);
  }
  return fallback;
}

export class RagJobCleanupService {
  async clearFinishedJobs(): Promise<{ deletedCount: number; activeCount: number }> {
    const [activeCount, deleteResult] = await prisma.$transaction([
      prisma.ragIndexJob.count({
        where: {
          status: {
            in: ACTIVE_RAG_JOB_STATUSES,
          },
        },
      }),
      prisma.ragIndexJob.deleteMany({
        where: {
          status: {
            in: FINISHED_RAG_JOB_STATUSES,
          },
        },
      }),
    ]);

    return {
      deletedCount: deleteResult.count,
      activeCount,
    };
  }

  async deleteFinishedJob(jobId: string): Promise<{ deletedCount: number; status: RagJobStatus }> {
    const job = await prisma.ragIndexJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (!job) {
      throw new Error("RAG job not found.");
    }

    const status = job.status as RagJobStatus;
    if (!FINISHED_RAG_JOB_STATUSES.includes(status)) {
      return {
        deletedCount: 0,
        status,
      };
    }

    await prisma.ragIndexJob.delete({
      where: { id: jobId },
    });
    return {
      deletedCount: 1,
      status,
    };
  }

  /**
   * Cancel active (queued/running) jobs past max age so the worker cannot
   * stay head-of-line blocked on multi-week zombies. Idempotent.
   */
  async cancelStaleActiveJobs(options?: {
    maxAgeMs?: number;
    runningMaxAgeMs?: number;
    limit?: number;
  }): Promise<{ cancelledQueued: number; cancelledRunning: number }> {
    const maxAgeMs = options?.maxAgeMs
      ?? resolvePositiveMs("RAG_STALE_QUEUED_MAX_AGE_MS", DEFAULT_STALE_ACTIVE_MAX_AGE_MS);
    const runningMaxAgeMs = options?.runningMaxAgeMs
      ?? resolvePositiveMs("RAG_STALE_RUNNING_MAX_AGE_MS", DEFAULT_STALE_RUNNING_MAX_AGE_MS);
    const limit = Math.max(1, Math.min(options?.limit ?? 2000, 10_000));
    const queuedCutoff = new Date(Date.now() - maxAgeMs);
    const runningCutoff = new Date(Date.now() - runningMaxAgeMs);
    const now = new Date();

    const staleQueued = await prisma.ragIndexJob.findMany({
      where: {
        status: "queued",
        createdAt: { lt: queuedCutoff },
      },
      select: { id: true },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
    const staleRunning = await prisma.ragIndexJob.findMany({
      where: {
        status: "running",
        updatedAt: { lt: runningCutoff },
      },
      select: { id: true },
      take: limit,
      orderBy: { updatedAt: "asc" },
    });

    let cancelledQueued = 0;
    let cancelledRunning = 0;

    if (staleQueued.length > 0) {
      const result = await prisma.ragIndexJob.updateMany({
        where: {
          id: { in: staleQueued.map((row) => row.id) },
          status: "queued",
        },
        data: {
          status: "cancelled",
          lastError: `stale_queued_max_age:${maxAgeMs}ms`,
          updatedAt: now,
        },
      });
      cancelledQueued = result.count;
    }

    if (staleRunning.length > 0) {
      const result = await prisma.ragIndexJob.updateMany({
        where: {
          id: { in: staleRunning.map((row) => row.id) },
          status: "running",
        },
        data: {
          status: "cancelled",
          lastError: `stale_running_max_age:${runningMaxAgeMs}ms`,
          updatedAt: now,
        },
      });
      cancelledRunning = result.count;
    }

    if (cancelledQueued > 0 || cancelledRunning > 0) {
      console.warn("[RAG][Cleanup] cancelled stale active jobs", {
        cancelledQueued,
        cancelledRunning,
        maxAgeMs,
        runningMaxAgeMs,
      });
    }

    return { cancelledQueued, cancelledRunning };
  }

  async countActiveByOwnerType(): Promise<Array<{ ownerType: string; status: string; count: number }>> {
    const rows = await prisma.ragIndexJob.groupBy({
      by: ["ownerType", "status"],
      where: { status: { in: ACTIVE_RAG_JOB_STATUSES } },
      _count: { _all: true },
    });
    return rows.map((row) => ({
      ownerType: row.ownerType,
      status: row.status,
      count: row._count._all,
    }));
  }
}
