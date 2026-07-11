import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { prisma } from "../db/prisma";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.use(authMiddleware);

/** Liveness: process is up (auth-exempt). Used by tunnel/orchestrator probes. */
router.get("/", (_req, res) => {
  const response: ApiResponse<{ status: string; timestamp: string }> = {
    success: true,
    data: {
      status: "ok",
      timestamp: new Date().toISOString(),
    },
    message: "服务运行正常。",
  };
  res.status(200).json(response);
});

/**
 * Readiness: DB is reachable. Auth required when token mode is on
 * (same as other /api routes except liveness).
 */
router.get("/ready", async (_req, res) => {
  const timestamp = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const response: ApiResponse<{ status: string; database: string; timestamp: string }> = {
      success: true,
      data: {
        status: "ready",
        database: "ok",
        timestamp,
      },
      message: "服务就绪。",
    };
    res.status(200).json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "database check failed";
    const response: ApiResponse<{ status: string; database: string; timestamp: string }> = {
      success: false,
      data: {
        status: "not_ready",
        database: "error",
        timestamp,
      },
      error: message,
      message: "数据库不可用。",
    };
    res.status(503).json(response);
  }
});

export default router;
