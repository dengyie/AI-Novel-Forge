import "dotenv/config";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { ensureRuntimeDatabaseReady } from "./db/runtimeMigrations";
import { assertProductionAuthSafety } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";
import { createRateLimitMiddleware } from "./middleware/rateLimit";
import { loadProviderApiKeys } from "./llm/factory";
import astrologyRouter from "./routes/astrology";
import agentCatalogRouter from "./routes/agentCatalog";
import agentRunsRouter from "./routes/agentRuns";
import autoDirectorChannelCallbacksRouter from "./routes/autoDirectorChannelCallbacks";
import autoDirectorFollowUpsRouter from "./routes/autoDirectorFollowUps";
import bookAnalysisRouter from "./routes/bookAnalysis";
import characterRouter from "./routes/character";
import chatRouter from "./routes/chat";
import creativeHubRouter from "./routes/creativeHub";
import genreRouter from "./routes/genre";
import healthRouter, { getServerReadiness, setServerReadiness } from "./routes/health";
import imagesRouter from "./routes/images";
import knowledgeRouter from "./routes/knowledge";
import llmRouter from "./routes/llm";
import llmLiveRouter from "./llm/live/llmLiveRoutes";
import novelRouter from "./modules/novel/http/novel";
import dramaRouter from "./modules/drama/http/dramaRoutes";
import comicRouter from "./modules/comic/http/comicRoutes";
import novelDirectorRouter from "./services/novel/director/http/novelDirector";
import novelExportRouter from "./modules/export/http/novelExport";
import novelWorkflowsRouter from "./services/novel/director/http/novelWorkflows";
import promptWorkbenchRouter from "./routes/promptWorkbench";
import ragRouter from "./routes/rag";
import settingsAutoDirectorRouter from "./routes/settingsAutoDirector";
import settingsRouter from "./routes/settings";
import styleEngineRouter from "./routes/styleEngine";
import styleEngineExtractionRouter from "./routes/styleEngineExtraction";
import storyModeRouter from "./routes/storyMode";
import tasksRouter from "./routes/tasks";
import titleLibraryRouter from "./routes/titleLibrary";
import worldRouter from "./modules/setup/world/http";
import writingFormulaRouter from "./routes/writingFormula";
import { novelEventBus, registerNovelEventHandlers } from "./events";
import { bookAnalysisService } from "./services/bookAnalysis/BookAnalysisService";
import { ragServices } from "./services/rag";
import { getSharedNovelServices } from "./services/novel/application/sharedNovelServices";
import { novelSideEffectWorker } from "./events/sideEffects";
import { NovelPipelineRuntimeService } from "./services/novel/NovelPipelineRuntimeService";
import { recoveryTaskService } from "./services/task/RecoveryTaskService";
import { taskRetentionService } from "./services/task/TaskRetentionService";
import { volumeReadinessScheduler } from "./services/novel/volume/VolumeReadinessScheduler";
import { volumeReadinessStartupRecoveryRunner } from "./services/novel/volume/readiness/application/VolumeReadinessStartupRecoveryRunner";
import {
  ensureSystemResourceStarterData,
  hasSystemResourceBootstrapChanges,
} from "./services/bootstrap/SystemResourceBootstrapService";
import { initializeRagSettingsCompatibility } from "./services/settings/RagCompatibilityBootstrapService";
import { qualityDebtSettingsService } from "./services/settings/QualityDebtSettingsService";
import { createGlobalErrorHandlers } from "./services/globalErrorHandler";
import { logPipelineError } from "./services/novel/novelCoreShared";
import { DirectorWorker } from "./workers/directorWorker";
import { cleanupLogDirectory, resolveLogRetentionConfig } from "./platform/logging/logRetention";
import { resolveClientDistPath, resolveLogsRoot } from "./runtime/appPaths";
import {
  startArtifactCheckpointHygieneScanner,
  stopArtifactCheckpointHygieneScanner,
} from "./services/novel/runtime/ChapterArtifactSyncCheckpointHygiene";
import {
  startChapterLockHygieneScanner,
  stopChapterLockHygieneScanner,
} from "./services/novel/runtime/ChapterGeneratingLockHygiene";
import { registerBuiltInEngines } from "./services/audiobook/engine/registerBuiltInEngines";
import { audiobookTaskService } from "./services/audiobook/AudiobookTaskService";
import { createStartupReadinessMiddleware } from "./app/startup/StartupReadinessMiddleware";
import { runStartupRecoverySequence } from "./app/startup/StartupRecoveryCoordinator";
import { noteMemoryGuardActivity, startMemoryPressureGuard } from "./runtime/memoryPressureGuard";
import { m4bWorkerManager } from "./services/audiobook/m4b/M4bWorkerManager";

getSharedNovelServices();
registerNovelEventHandlers(novelEventBus);
registerBuiltInEngines();
const novelPipelineRuntimeService = new NovelPipelineRuntimeService();

morgan.token("error-message", (_req, res) => {
  const response = res as typeof res & {
    locals?: {
      requestErrorMessage?: unknown;
    };
  };
  const errorMessage = response.locals?.requestErrorMessage;
  return typeof errorMessage === "string" ? errorMessage.trim() : "";
});

function parseEnvFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value === "true" || value === "1";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallback;
}

export interface CreateAppOptions {
  enforceStartupReadiness?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  getSharedNovelServices();
  const app = express();
  const jsonBodyLimit = process.env.API_JSON_LIMIT ?? "2mb";
  const corsOriginEnv = process.env.CORS_ORIGIN;
  const corsAllowList = corsOriginEnv
    ? corsOriginEnv
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    : [];

  const allowLan = parseEnvFlag(process.env.ALLOW_LAN, process.env.NODE_ENV !== "production");
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        const isListedOrigin = corsAllowList.includes(origin);
        const isLocalhostDevOrigin = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
        const isLanOrigin = allowLan && /^https?:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d+$/.test(origin);
        callback(null, isListedOrigin || isLocalhostDevOrigin || isLanOrigin);
      },
      credentials: true,
    }),
  );
  app.use(helmet());
  app.use(morgan((tokens, req, res) => {
    const method = tokens.method(req, res) ?? "-";
    const url = tokens.url(req, res) ?? "-";
    const status = tokens.status(req, res) ?? "-";
    const responseTime = tokens["response-time"](req, res) ?? "0";
    const contentLength = tokens.res(req, res, "content-length") ?? "0";
    const errorMessage = tokens["error-message"](req, res);
    const errorSuffix = errorMessage ? ` | error: ${errorMessage}` : "";
    return `${method} ${url} ${status} ${responseTime} ms - ${contentLength}${errorSuffix}`;
  }));

  // Liveness/readiness must remain reachable while startup recovery is gated.
  // Reject ordinary API traffic before body parsing and rate-limit accounting:
  // a restart storm must not allocate up to API_JSON_LIMIT per request or spend
  // the first post-recovery request budget while the service cannot serve it.
  app.use("/api/health", healthRouter);
  if (options.enforceStartupReadiness) {
    app.use("/api", createStartupReadinessMiddleware());
  }

  app.use(express.json({ limit: jsonBodyLimit }));
  // memoryPressureGuard 的活动上报点：任何请求进出都算「忙」，防止空闲判定误触发 GC。
  // 放在 body 解析之后、路由分发之前，覆盖全部业务路径。
  app.use((req, res, next) => {
    noteMemoryGuardActivity();
    res.on("finish", noteMemoryGuardActivity);
    next();
  });

  // Global inbound rate limit (single-node). Skip liveness for probes.
  const rateLimitEnabled = process.env.API_RATE_LIMIT_DISABLED !== "true"
    && process.env.API_RATE_LIMIT_DISABLED !== "1";
  if (rateLimitEnabled) {
    app.use("/api", createRateLimitMiddleware({
      limit: parsePositiveInt(process.env.API_RATE_LIMIT_MAX, 300),
      windowMs: parsePositiveInt(process.env.API_RATE_LIMIT_WINDOW_MS, 60_000),
      skip: (req) => {
        const url = req.originalUrl?.split("?")[0] ?? "";
        return url === "/api/health"
          || url === "/api/health/"
          || url === "/api/health/ready";
      },
    }));
  }

  // Tighter cap on expensive LLM surfaces.
  const expensiveRateLimit = createRateLimitMiddleware({
    limit: parsePositiveInt(process.env.API_EXPENSIVE_RATE_LIMIT_MAX, 60),
    windowMs: parsePositiveInt(process.env.API_EXPENSIVE_RATE_LIMIT_WINDOW_MS, 60_000),
  });
  app.use("/api/chat", expensiveRateLimit);
  app.use("/api/llm", expensiveRateLimit);
  app.use("/api/creative-hub", expensiveRateLimit);

  app.use("/api/agent-catalog", agentCatalogRouter);
  app.use("/api/agent-runs", agentRunsRouter);
  app.use("/api/book-analysis", bookAnalysisRouter);
  app.use("/api/genres", genreRouter);
  app.use("/api/story-modes", storyModeRouter);
  app.use("/api/knowledge", knowledgeRouter);
  app.use("/api/llm", llmRouter);
  // Live SSE must NOT sit under /api/llm expensive rate limit
  app.use("/api/llm-live", llmLiveRouter);
  app.use("/api/title-library", titleLibraryRouter);
  app.use("/api", styleEngineRouter);
  app.use("/api", styleEngineExtractionRouter);
  app.use("/api/novels", novelRouter);
  app.use("/api/novels/director", novelDirectorRouter);
  app.use("/api/novel-workflows", novelWorkflowsRouter);
  app.use("/api/novels", novelExportRouter);
  app.use("/api/drama", dramaRouter);
  app.use("/api/comic", comicRouter);
  app.use("/api/worlds", worldRouter);
  app.use("/api/rag", ragRouter);
  app.use("/api/base-characters", characterRouter);
  app.use("/api/writing-formula", writingFormulaRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/creative-hub", creativeHubRouter);
  app.use("/api/prompt-workbench", promptWorkbenchRouter);
  app.use("/api/images", imagesRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/auto-director/follow-ups", autoDirectorFollowUpsRouter);
  app.use("/api/settings/auto-director", settingsAutoDirectorRouter);
  app.use("/api/auto-director/channel-callbacks", autoDirectorChannelCallbacksRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/astrology", astrologyRouter);

  const clientDistDir = resolveClientDistPath();
  if (clientDistDir) {
    app.use(express.static(clientDistDir, {
      index: "index.html",
      immutable: true,
      maxAge: "1y",
      setHeaders: (res, filePath) => {
        if (path.basename(filePath) === "index.html") {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      },
    }));
    app.get(/^(?!\/api(?:\/|$)|\/assets(?:\/|$)).*/, (_req, res) => {
      res.sendFile(path.join(clientDistDir, "index.html"));
    });
  }

  app.use((_req, res) => {
    const response: ApiResponse<null> = {
      success: false,
      error: "接口不存在。",
    };
    res.status(404).json(response);
  });

  app.use(errorHandler);

  return app;
}

function getLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return null;
}

function createServerUrl(host: string, port: number): string {
  if (host === "0.0.0.0" || host === "::") {
    return `http://localhost:${port}`;
  }
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

export interface ServerStartOptions {
  host?: string;
  port?: number;
  allowLan?: boolean;
}

export interface StartedServer {
  app: express.Express;
  server: Server;
  host: string;
  port: number;
  allowLan: boolean;
  url: string;
  close: () => Promise<void>;
}

interface BackgroundServicesHandle {
  stop: () => Promise<void>;
}

function resolveServerStartOptions(options?: ServerStartOptions): {
  host: string;
  port: number;
  allowLan: boolean;
} {
  const allowLan = options?.allowLan ?? parseEnvFlag(process.env.ALLOW_LAN, process.env.NODE_ENV !== "production");
  return {
    allowLan,
    port: options?.port ?? Number(process.env.PORT ?? 3000),
    host: options?.host ?? process.env.HOST ?? (allowLan ? "0.0.0.0" : "localhost"),
  };
}

function logServerReady(host: string, port: number): void {
  console.log(`[server] listening on http://localhost:${port}`);
  if (host === "0.0.0.0" || host === "::") {
    const lanIp = getLanIp();
    if (lanIp) {
      console.log(`[server] LAN: http://${lanIp}:${port}`);
    }
  }
}

function scheduleLogRetentionCleanup(): void {
  setImmediate(() => {
    try {
      const summary = cleanupLogDirectory(resolveLogsRoot(), resolveLogRetentionConfig());
      if (summary.deletedFiles > 0 || summary.failedFiles > 0) {
        console.info("[server.logs] cleanup completed.", {
          deletedFiles: summary.deletedFiles,
          deletedBytes: summary.deletedBytes,
          failedFiles: summary.failedFiles,
        });
      }
      for (const failure of summary.failures.slice(0, 5)) {
        console.warn("[server.logs] cleanup failed for file.", failure);
      }
    } catch (error) {
      console.warn("[server.logs] cleanup skipped.", error);
    }
  });
}

async function initializeBackgroundServices(): Promise<BackgroundServicesHandle> {
  const directorWorker = new DirectorWorker();
  let stopped = false;
  let recoveryRetryTimer: NodeJS.Timeout | null = null;
  const scheduleRecoveryRetry = (delayMs: number): void => {
    if (stopped || recoveryRetryTimer) return;
    recoveryRetryTimer = setTimeout(() => {
      recoveryRetryTimer = null;
      void recoveryTaskService.retryPendingRecoveries().then((result) => {
        if (stopped) return;
        if (result.failedDomains.length === 0) {
          setServerReadiness("ready");
          console.log("[recovery] startup recovery retry succeeded; readiness restored");
          return;
        }
        setServerReadiness("degraded", result.failedDomains);
        scheduleRecoveryRetry(Math.min(delayMs * 2, 5 * 60_000));
      }).catch((error) => {
        if (stopped) return;
        console.warn("[recovery] startup recovery retry failed", error);
        setServerReadiness("degraded", ["retry"]);
        scheduleRecoveryRetry(Math.min(delayMs * 2, 5 * 60_000));
      });
    }, delayMs);
    recoveryRetryTimer.unref?.();
  };
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (recoveryRetryTimer) {
      clearTimeout(recoveryRetryTimer);
      recoveryRetryTimer = null;
    }
    // Bound wait for director in-flight ticks; force-exit still owned by SHUTDOWN_TIMEOUT_MS.
    const drainMs = Math.max(
      1_000,
      Math.min(15_000, parsePositiveInt(process.env.SHUTDOWN_TIMEOUT_MS, 20_000) - 5_000),
    );
    const drainResult = await directorWorker.waitForStop(drainMs).catch((error) => {
      console.warn("[director.worker] waitForStop failed", error);
      return "timeout" as const;
    });
    if (drainResult === "timeout") {
      console.warn(`[director.worker] in-flight drain timed out after ${drainMs}ms; continuing shutdown.`);
    }
    novelSideEffectWorker.stop();
    stopArtifactCheckpointHygieneScanner();
    stopChapterLockHygieneScanner();
    ragServices.ragWorker.stop();
    ragServices.ragRetrievalTraceRetention.stop();
    taskRetentionService.stop();
    volumeReadinessScheduler.stop();
    bookAnalysisService.stopWatchdog();
    novelPipelineRuntimeService.stopWatchdog();
    audiobookTaskService.stopWatchdog();
  };

  try {
    // Recovery queues can begin work as soon as they are hydrated. Load the
    // persisted provider keys before any recovered task is allowed to execute.
    await loadProviderApiKeys().catch((error) => {
      console.warn("数据库中的模型密钥加载失败，已回退到环境变量。", error);
    });
    // 恢复扫描必须在服务进入 ready 前完成：m4b 后台作业依靠持久 marker 重建内存队列，
    // 不能在启动后以未等待 Promise 运行而留下短暂/永久的不可恢复窗口。
    // 核心恢复后，Volume 真正执行结束才启动 Director；HTTP ready 不等待整卷长任务。
    const { recoveryResult, backgroundRecovery } = await runStartupRecoverySequence({
      recoverCore: () => recoveryTaskService.initializePendingRecoveries(),
      startDeferredServices: () => {
        // These workers may perform an immediate scan/tick. Starting them only
        // after durable task recovery avoids adding another restart-time burst.
        ragServices.ragWorker.start();
        ragServices.ragRetrievalTraceRetention.start();
        taskRetentionService.start();
        novelSideEffectWorker.start();
        // Prevent zombie chapterArtifactSyncCheckpoint rows from blocking writer claim paths.
        startArtifactCheckpointHygieneScanner();
        // 章节 generating 陈旧锁自愈：writer 超时/崩溃遗留的假 running 由扫描器回收。
        startChapterLockHygieneScanner();
        bookAnalysisService.startWatchdog();
        novelPipelineRuntimeService.startWatchdog();
        audiobookTaskService.startWatchdog();
        // pxed 防 OOM：空闲期主动 GC 归还内存（无 expose-gc 时只打遥测）。
        startMemoryPressureGuard();
      },
      // VOLUME_READINESS_SCHEDULE 只控制 dry-run 巡检；startup auto-resume 始终开启。
      startVolumeRecovery: () => {
        return volumeReadinessStartupRecoveryRunner.run(() => stopped)
          .finally(() => {
            // The optional dry-run scheduler performs an immediate first tick.
            // Do not overlap that tick with startup volume auto-resume.
            if (!stopped) volumeReadinessScheduler.start();
          });
      },
      startDirectorWorker: () => {
        void directorWorker.start().catch((error) => {
          console.error("[director.worker] unexpected stop", error);
        });
      },
      shouldStop: () => stopped,
    });
    void backgroundRecovery.catch((error) => {
      console.warn("[volume.readiness] startup recovery failed", error);
    });
    if (recoveryResult.failedDomains.length > 0) {
      setServerReadiness("degraded", recoveryResult.failedDomains);
      console.warn("[recovery] startup recovery degraded; readiness remains blocked", {
        failedDomains: recoveryResult.failedDomains,
      });
      scheduleRecoveryRetry(30_000);
    } else {
      setServerReadiness("ready");
    }

    void ensureSystemResourceStarterData()
      .then((systemResourceReport) => {
        if (hasSystemResourceBootstrapChanges(systemResourceReport)) {
          console.log("[server] built-in creative resources bootstrapped.", systemResourceReport);
        }
      })
      .catch((error) => {
        console.warn("Failed to bootstrap built-in creative resources.", error);
      });

    return { stop };
  } catch (error) {
    setServerReadiness("degraded", ["startup"]);
    await stop();
    throw error;
  }
}

export async function startServer(options?: ServerStartOptions): Promise<StartedServer> {
  setServerReadiness("starting");
  scheduleLogRetentionCleanup();
  await ensureRuntimeDatabaseReady();

  const ragCompatibilityReport = await initializeRagSettingsCompatibility();
  if (
    ragCompatibilityReport.importedSettingKeys.length > 0
    || ragCompatibilityReport.importedProviderRecords.length > 0
  ) {
    console.log("[server] imported legacy RAG env settings.", ragCompatibilityReport);
  }
  await qualityDebtSettingsService.warnIfAutoPromotionEnabled().catch((error) => {
    console.warn("[server] failed to inspect pending review auto-promotion settings.", error);
  });

  const app = createApp({ enforceStartupReadiness: true });
  const { host, port, allowLan } = resolveServerStartOptions(options);
  assertProductionAuthSafety({ host, allowLan });

  const server = await new Promise<Server>((resolve, reject) => {
    const listeningServer = app.listen(port, host, () => resolve(listeningServer));
    listeningServer.once("error", reject);
  });
  let backgroundServices: BackgroundServicesHandle;
  try {
    backgroundServices = await initializeBackgroundServices();
  } catch (error) {
    // initializeBackgroundServices owns cleanup of any services it started; this closes
    // the listener that was intentionally opened only to serve the assembled app.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw error;
  }

  if (getServerReadiness().state === "ready") {
    logServerReady(host, port);
  } else {
    console.warn("[server] listening with degraded readiness; /api/health/ready remains 503", {
      failedRecoveryDomains: getServerReadiness().failedRecoveryDomains,
    });
  }

  return {
    app,
    server,
    host,
    port,
    allowLan,
    url: createServerUrl(host, port),
    close: async () => {
      await backgroundServices.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

/**
 * 进程级全局错误兜底（NET）。必须在 startServer() 之前注册——兜住 boot 期任何逃逸的
 * promise rejection 或同步异常。此前整个进程没有任何 uncaughtException/unhandledRejection
 * handler，逃逸即走 Node 20 默认 throw → 无声 exit-1（生产 supervisord 记多次）。
 * handler 行为见 services/globalErrorHandler.ts；不替换既有 per-point `.catch` 防线。
 */
function registerGlobalErrorHandlers(): void {
  const handlers = createGlobalErrorHandlers({ log: logPipelineError, exit: (code) => process.exit(code) });
  process.on("unhandledRejection", handlers.handleUnhandledRejection);
  process.on("uncaughtException", handlers.handleUncaughtException);
}

async function bootstrap(): Promise<void> {
  registerGlobalErrorHandlers();
  const started = await startServer();
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[server] received ${signal}, shutting down…`);
    const forceExit = setTimeout(() => {
      console.error("[server] graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, parsePositiveInt(process.env.SHUTDOWN_TIMEOUT_MS, 20_000));
    forceExit.unref?.();

    try {
      await m4bWorkerManager.shutdown();
      await started.close();
      console.log("[server] shutdown complete.");
      process.exit(0);
    } catch (error) {
      console.error("[server] shutdown failed.", error);
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    console.error("[server] bootstrap failed.", error);
    process.exit(1);
  });
}
