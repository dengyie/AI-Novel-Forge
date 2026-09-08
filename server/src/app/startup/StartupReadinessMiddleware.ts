import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { RequestHandler } from "express";
import { getServerReadiness, type ServerReadinessState } from "../../routes/health";

interface StartupUnavailableData {
  status: ServerReadinessState;
  failedRecoveryDomains?: string[];
}

/**
 * Keep ordinary API work out of the process while restart recovery is still
 * claiming durable jobs. The health router is mounted before this middleware,
 * so liveness/readiness probes remain available to the tunnel and supervisor.
 */
export function createStartupReadinessMiddleware(): RequestHandler {
  return (_req, res, next) => {
    const readiness = getServerReadiness();
    if (readiness.state === "ready") {
      next();
      return;
    }

    const response: ApiResponse<StartupUnavailableData> = {
      success: false,
      data: {
        status: readiness.state,
        ...(readiness.failedRecoveryDomains.length > 0
          ? { failedRecoveryDomains: [...readiness.failedRecoveryDomains] }
          : {}),
      },
      error: readiness.state === "starting"
        ? "startup recovery is still running"
        : "startup recovery is degraded",
      message: readiness.state === "starting"
        ? "服务正在恢复后台任务，请稍后重试。"
        : "后台任务恢复不完整，服务暂不可用。",
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "5");
    res.status(503).json(response);
  };
}
