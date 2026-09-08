import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { prisma } from "../db/prisma";
import { authMiddleware } from "../middleware/auth";

const router = Router();

export type ServerReadinessState = "starting" | "ready" | "degraded";

let serverReadiness: {
  state: ServerReadinessState;
  failedRecoveryDomains: string[];
} = {
  state: "starting",
  failedRecoveryDomains: [],
};

export function setServerReadiness(
  state: ServerReadinessState,
  failedRecoveryDomains: string[] = [],
): void {
  serverReadiness = {
    state,
    failedRecoveryDomains: [...failedRecoveryDomains],
  };
}

export function getServerReadiness(): Readonly<typeof serverReadiness> {
  return serverReadiness;
}

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
 * Readiness: DB is reachable. Auth-exempt (see auth isHealthLivenessPath)
 * so orchestrators can probe without tokens.
 */
router.get("/ready", async (_req, res) => {
  const timestamp = new Date().toISOString();
  if (serverReadiness.state !== "ready") {
    const isStarting = serverReadiness.state === "starting";
    const response: ApiResponse<{
      status: ServerReadinessState;
      database: string;
      timestamp: string;
      failedRecoveryDomains?: string[];
    }> = {
      success: false,
      data: {
        status: serverReadiness.state,
        database: "unknown",
        timestamp,
        ...(serverReadiness.failedRecoveryDomains.length > 0
          ? { failedRecoveryDomains: serverReadiness.failedRecoveryDomains }
          : {}),
      },
      error: isStarting ? "startup recovery is still running" : "startup recovery is degraded",
      message: isStarting ? "服务正在恢复后台任务。" : "后台任务恢复不完整，服务暂不可用。",
    };
    res.status(503).json(response);
    return;
  }
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
export { router as healthRouter };
