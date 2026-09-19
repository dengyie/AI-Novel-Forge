import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { prisma } from "../db/prisma";
import { authMiddleware } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { validate } from "../middleware/validate";
import { ragMain } from "../services/rag/mainProcessProxy";
import { collectReindexOwners, enqueueReindexOwners } from "../services/rag/indexing";
import { ragConfig } from "../config/rag";

const router = Router();

const reindexSchema = z.object({
  scope: z.enum(["novel", "world", "all"]),
  id: z.string().trim().optional(),
  tenantId: z.string().trim().optional(),
});

const jobsQuerySchema = z.object({
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const jobParamsSchema = z.object({
  jobId: z.string().trim().min(1),
});

router.use(authMiddleware);

router.post("/reindex", validate({ body: reindexSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof reindexSchema>;
    const owners = await collectReindexOwners(body.scope, body.id);
    const jobs = await enqueueReindexOwners(
      owners,
      (owner, options) => ragMain.jobs.enqueueOwnerJob("rebuild", owner.ownerType, owner.ownerId, options),
      { tenantId: body.tenantId },
    );
    res.status(202).json({
      success: true,
      data: { scope: body.scope, id: body.id ?? null, count: jobs.length },
      message: "RAG reindex jobs queued.",
    } satisfies ApiResponse<{ scope: string; id: string | null; count: number }>);
  } catch (error) {
    next(error);
  }
});

router.get("/jobs", validate({ query: jobsQuerySchema }), async (req, res, next) => {
  try {
    const query = jobsQuerySchema.parse(req.query);
    const rows = await prisma.ragIndexJob.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });
    const data = rows.map((row) => {
      let progress: unknown = null;
      try {
        progress = row.payloadJson ? (JSON.parse(row.payloadJson) as { progress?: unknown }).progress ?? null : null;
      } catch {
        progress = null;
      }
      return {
        id: row.id,
        jobType: row.jobType,
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        lastError: row.lastError,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        progress,
      };
    });
    res.status(200).json({
      success: true,
      data,
      message: "RAG job list loaded.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.delete("/jobs/finished", async (_req, res, next) => {
  try {
    const activeCount = await prisma.ragIndexJob.count({
      where: { status: { in: ["queued", "running"] } },
    });
    const deleted = await prisma.ragIndexJob.deleteMany({
      where: { status: { in: ["succeeded", "failed", "cancelled"] } },
    });
    const data = { deletedCount: deleted.count, activeCount };
    res.status(200).json({
      success: true,
      data,
      message: data.deletedCount > 0
        ? `已清理 ${data.deletedCount} 个已结束任务。`
        : "没有可清理的已结束任务。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

const cancelStaleSchema = z.object({
  maxAgeMs: z.coerce.number().int().min(60_000).max(90 * 24 * 60 * 60 * 1000).optional(),
  runningMaxAgeMs: z.coerce.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
});

/**
 * Cancel multi-day queued / stuck-running RAG jobs (zombie backlog hygiene).
 * This endpoint (or SQL) is the manual drain path — also used by the rag worker
 * child at tick start.
 */
router.post("/jobs/cancel-stale", validate({ body: cancelStaleSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof cancelStaleSchema>;
    const maxAgeMs = body.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const runningMaxAgeMs = body.runningMaxAgeMs ?? 30 * 60 * 1000;
    const limit = Math.max(1, Math.min(body.limit ?? 2000, 10_000));
    const now = new Date();
    const queuedCutoff = new Date(now.getTime() - maxAgeMs);
    const runningCutoff = new Date(now.getTime() - runningMaxAgeMs);

    const staleQueued = await prisma.ragIndexJob.findMany({
      where: { status: "queued", createdAt: { lt: queuedCutoff } },
      select: { id: true },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
    const staleRunning = await prisma.ragIndexJob.findMany({
      where: { status: "running", updatedAt: { lt: runningCutoff } },
      select: { id: true },
      take: limit,
      orderBy: { updatedAt: "asc" },
    });

    let cancelledQueued = 0;
    let cancelledRunning = 0;
    if (staleQueued.length > 0) {
      const result = await prisma.ragIndexJob.updateMany({
        where: { id: { in: staleQueued.map((row) => row.id) }, status: "queued" },
        data: { status: "cancelled", lastError: `stale_queued_max_age:${maxAgeMs}ms`, updatedAt: now },
      });
      cancelledQueued = result.count;
    }
    if (staleRunning.length > 0) {
      const result = await prisma.ragIndexJob.updateMany({
        where: { id: { in: staleRunning.map((row) => row.id) }, status: "running" },
        data: { status: "cancelled", lastError: `stale_running_max_age:${runningMaxAgeMs}ms`, updatedAt: now },
      });
      cancelledRunning = result.count;
    }

    const activeByOwner = await prisma.ragIndexJob.groupBy({
      by: ["ownerType", "status"],
      where: { status: { in: ["queued", "running"] } },
      _count: { _all: true },
    });

    const data = {
      cancelledQueued,
      cancelledRunning,
      activeByOwner: activeByOwner.map((row) => ({
        ownerType: row.ownerType,
        status: row.status,
        count: row._count._all,
      })),
    };
    res.status(200).json({
      success: true,
      data,
      message: (cancelledQueued + cancelledRunning) > 0
        ? `已取消过期任务 queued=${cancelledQueued} running=${cancelledRunning}。`
        : "没有可取消的过期活跃任务。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.delete("/jobs/:jobId", validate({ params: jobParamsSchema }), async (req, res, next) => {
  try {
    const { jobId } = req.params as z.infer<typeof jobParamsSchema>;
    const job = await prisma.ragIndexJob.findUnique({ where: { id: jobId } });
    if (!job) {
      next(new AppError("没有找到这个任务。", 404));
      return;
    }
    if (job.status === "queued" || job.status === "running") {
      throw new AppError("排队中或执行中的任务不能删除。", 409);
    }
    await prisma.ragIndexJob.delete({ where: { id: jobId } });
    const data = { jobId, deletedCount: 1, status: job.status };
    res.status(200).json({
      success: true,
      data,
      message: "任务记录已删除。",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/health", async (_req, res, next) => {
  try {
    const health = await ragMain.ragHealthCheck();
    const data = {
      embedding: health.embedding
        ? { ...health.embedding, timeoutMs: ragConfig.embeddingTimeoutMs, batchSize: ragConfig.embeddingBatchSize, maxRetries: ragConfig.embeddingMaxRetries }
        : { ok: false, detail: "rag worker child process not running", provider: "", model: "" },
      qdrant: health.qdrant
        ? { ...health.qdrant, timeoutMs: ragConfig.qdrantTimeoutMs }
        : { ok: false, detail: "rag worker child process not running" },
      worker: health.worker,
      ok: health.ok,
    };
    res.status(data.ok ? 200 : 503).json({
      success: data.ok,
      data,
      message: data.ok ? "RAG health check passed." : "RAG health check failed.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

export default router;
