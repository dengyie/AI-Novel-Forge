import "dotenv/config";
import { ensureRuntimeDatabaseReady } from "../db/runtimeMigrations";
import { loadProviderApiKeys } from "../llm/factory";
import { initializeRagSettingsCompatibility } from "../services/settings/RagCompatibilityBootstrapService";
import { ragServices } from "../services/rag";
import type { RagWorkerRequest, RagWorkerResponse } from "../runtime/ragWorkerProtocol";

/**
 * RAG worker 子进程入口（pxed 防 OOM Phase 3）。
 *
 * 由主进程 RagWorkerManager fork；承载 RAG 全家 import 树（实测 +85MB heap）。
 * 职责：
 * - 处理主进程 IPC-RPC（buildContextBlock / retrieve / retrieveByFacet / healthCheck）
 * - 运行 ragServices.ragWorker（RagIndexJob 轮询）
 * - 30s 心跳（RagWorkerManager 看门狗用）
 * - 空闲（idle 消息 + 宽限期无新活）后自行 exit，内存归还 OS；主进程按需再 fork
 */

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_EXIT_GRACE_MS = Number(process.env.RAG_WORKER_IDLE_EXIT_MS) || 10 * 60_000;

let idleTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatSeq = 0;
let shuttingDown = false;

function sendResponse(response: RagWorkerResponse): void {
  if (process.send) {
    process.send(response);
  }
}

function handleRequest(request: Extract<RagWorkerRequest, { id: number }>): void {
  void (async () => {
    try {
      switch (request.type) {
        case "ping":
          sendResponse({ id: request.id, ok: true, result: "pong" });
          return;
        case "buildContextBlock": {
          const result = await ragServices.hybridRetrievalService.buildContextBlock(
            request.payload.query,
            request.payload.options as Parameters<typeof ragServices.hybridRetrievalService.buildContextBlock>[1],
          );
          sendResponse({ id: request.id, ok: true, result });
          return;
        }
        case "retrieve": {
          const result = await ragServices.hybridRetrievalService.retrieve(
            request.payload.query,
            request.payload.options as Parameters<typeof ragServices.hybridRetrievalService.retrieve>[1],
          );
          sendResponse({ id: request.id, ok: true, result });
          return;
        }
        case "retrieveByFacet": {
          const result = await ragServices.hybridRetrievalService.retrieveByFacet(
            request.payload.input as Parameters<typeof ragServices.hybridRetrievalService.retrieveByFacet>[0],
          );
          sendResponse({ id: request.id, ok: true, result });
          return;
        }
        case "healthCheck": {
          const [embedding, qdrant] = await Promise.all([
            ragServices.embeddingService.healthCheck(),
            ragServices.vectorStoreService.healthCheck(),
          ]);
          sendResponse({
            id: request.id,
            ok: embedding.ok && qdrant.ok,
            result: { ok: embedding.ok && qdrant.ok, embedding, qdrant },
          });
          return;
        }
        default:
          sendResponse({
            id: (request as { id: number }).id,
            ok: false,
            error: `unknown request type: ${(request as { type: string }).type}`,
          });
      }
    } catch (error) {
      sendResponse({
        id: (request as { id: number }).id,
        ok: false,
        error: error instanceof Error ? error.message : "RAG worker RPC failed",
      });
    }
  })();
}

function handleControlMessage(message: unknown): void {
  if (typeof message !== "object" || message === null) return;
  const request = message as { id?: number; type?: string };
  switch (request.type) {
    case "idle": {
      // 主进程确认无活：启动/重置空闲退出倒计时。
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log("[rag.worker] idle grace elapsed; exiting to release memory.");
        gracefulExit(0);
      }, IDLE_EXIT_GRACE_MS);
      idleTimer.unref();
      return;
    }
    case "shutdown": {
      gracefulExit(0);
      return;
    }
    default:
      if (typeof request.id === "number" && typeof request.type === "string") {
        handleRequest(request as unknown as Extract<RagWorkerRequest, { id: number }>);
      }
  }
}

function gracefulExit(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (idleTimer) clearTimeout(idleTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  try {
    ragServices.ragWorker.stop();
    ragServices.ragRetrievalTraceRetention.stop();
  } catch (error) {
    console.warn("[rag.worker] stop services failed", error);
  }
  process.exit(code);
}

async function bootstrap(): Promise<void> {
  await ensureRuntimeDatabaseReady();
  await loadProviderApiKeys().catch((error) => {
    console.warn("[rag.worker] failed to load provider API keys", error);
  });
  await initializeRagSettingsCompatibility().catch((error) => {
    console.warn("[rag.worker] failed to initialize RAG compatibility settings", error);
  });

  process.on("message", handleControlMessage);
  process.once("SIGINT", () => gracefulExit(0));
  process.once("SIGTERM", () => gracefulExit(0));

  heartbeatTimer = setInterval(() => {
    heartbeatSeq += 1;
    if (process.send) {
      process.send({ type: "heartbeat", seq: heartbeatSeq });
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  ragServices.ragWorker.start();
  console.log("[rag.worker] started pid=" + process.pid);
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    console.error("[rag.worker] bootstrap failed", error);
    process.exit(1);
  });
}
