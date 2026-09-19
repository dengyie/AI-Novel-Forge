import "dotenv/config";
import {
  RAG_WORKER_IDLE_GRACE_MS,
  RAG_WORKER_PRE_READY_QUEUE_LIMIT,
} from "../runtime/ragWorkerProtocol";
import type { RagWorkerRequest, RagWorkerResponse } from "../runtime/ragWorkerProtocol";

type RagServices = typeof import("../services/rag").ragServices;
let ragServices: RagServices | null = null;

/**
 * RAG worker 子进程入口（pxed 防 OOM Phase 3）。
 *
 * The IPC listener is installed synchronously, before database/settings
 * bootstrap. Messages received in that window stay in a bounded queue so a
 * cold RPC cannot be lost while the RAG import tree initializes.
 */

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_EXIT_GRACE_MS = Number(process.env.RAG_WORKER_IDLE_EXIT_MS) || RAG_WORKER_IDLE_GRACE_MS;

let idleTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatSeq = 0;
let activeRpcCount = 0;
let ready = false;
let shuttingDown = false;
let shutdownRequested = false;
let queuedMessages: unknown[] = [];
let gracefulExitPromise: Promise<void> | null = null;

function sendResponse(response: RagWorkerResponse): void {
  if (!process.send || !process.connected) return;
  try {
    process.send(response);
  } catch (error) {
    console.warn("[rag.worker] failed to send response", error);
  }
}

function clearIdleTimer(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function isWorkerBusy(): boolean {
  if (!ready || !ragServices) return true;
  return activeRpcCount > 0 || ragServices.ragWorker.isBusy();
}

function scheduleIdleExit(): void {
  if (shuttingDown || isWorkerBusy() || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (isWorkerBusy()) return;
    console.log("[rag.worker] idle grace elapsed; exiting to release memory.");
    void gracefulExit(0);
  }, IDLE_EXIT_GRACE_MS);
  idleTimer.unref();
}

function sendHeartbeat(): void {
  heartbeatSeq += 1;
  if (!process.send || !process.connected) return;
  try {
    process.send({ type: "heartbeat", seq: heartbeatSeq });
  } catch (error) {
    console.warn("[rag.worker] failed to send heartbeat", error);
  }
}

function handleRequest(request: Extract<RagWorkerRequest, { id: number }>): void {
  if (shuttingDown) {
    sendResponse({ id: request.id, ok: false, error: "RAG worker is shutting down" });
    return;
  }
  clearIdleTimer();
  activeRpcCount += 1;
  const services = ragServices;
  if (!services) {
    activeRpcCount -= 1;
    sendResponse({ id: request.id, ok: false, error: "RAG worker is still starting" });
    return;
  }
  void (async () => {
    try {
      switch (request.type) {
        case "ping":
          sendResponse({ id: request.id, ok: true, result: "pong" });
          return;
        case "buildContextBlock": {
          const result = await services.hybridRetrievalService.buildContextBlock(
            request.payload.query,
            request.payload.options as Parameters<typeof services.hybridRetrievalService.buildContextBlock>[1],
          );
          sendResponse({ id: request.id, ok: true, result });
          return;
        }
        case "retrieve": {
          const result = await services.hybridRetrievalService.retrieve(
            request.payload.query,
            request.payload.options as Parameters<typeof services.hybridRetrievalService.retrieve>[1],
          );
          sendResponse({ id: request.id, ok: true, result });
          return;
        }
        case "retrieveByFacet": {
          const result = await services.hybridRetrievalService.retrieveByFacet(
            request.payload.input as Parameters<typeof services.hybridRetrievalService.retrieveByFacet>[0],
          );
          sendResponse({ id: request.id, ok: true, result });
          return;
        }
        case "healthCheck": {
          const [embedding, qdrant] = await Promise.all([
            services.embeddingService.healthCheck(),
            services.vectorStoreService.healthCheck(),
          ]);
          sendResponse({
            id: request.id,
            ok: embedding.ok && qdrant.ok,
            result: { ok: embedding.ok && qdrant.ok, embedding, qdrant },
          });
          return;
        }
        default:
          {
            const unknownRequest = request as unknown as { id: number; type: string };
          sendResponse({
            id: unknownRequest.id,
            ok: false,
            error: `unknown request type: ${unknownRequest.type}`,
          });
          }
      }
    } catch (error) {
      sendResponse({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "RAG worker RPC failed",
      });
    } finally {
      activeRpcCount -= 1;
      scheduleIdleExit();
    }
  })();
}

function dispatchMessage(message: unknown): void {
  if (typeof message !== "object" || message === null) return;
  const request = message as { id?: number; type?: string };
  if (request.type === "idle") {
    scheduleIdleExit();
    return;
  }
  if (request.type === "shutdown") {
    void gracefulExit(0);
    return;
  }
  if (typeof request.id === "number" && typeof request.type === "string") {
    handleRequest(request as unknown as Extract<RagWorkerRequest, { id: number }>);
  }
}

function handleControlMessage(message: unknown): void {
  if (typeof message !== "object" || message === null) return;
  const request = message as { id?: number; type?: string };
  if (!ready) {
    if (request.type === "shutdown") {
      shutdownRequested = true;
      queuedMessages = [];
      return;
    }
    if (queuedMessages.length >= RAG_WORKER_PRE_READY_QUEUE_LIMIT) {
      if (typeof request.id === "number") {
        sendResponse({ id: request.id, ok: false, error: "RAG worker is still starting" });
      }
      return;
    }
    queuedMessages.push(message);
    return;
  }
  dispatchMessage(message);
}

async function gracefulExit(code: number): Promise<void> {
  if (gracefulExitPromise) return gracefulExitPromise;
  shuttingDown = true;
  clearIdleTimer();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  gracefulExitPromise = (async () => {
    if (ragServices) {
      try {
        await ragServices.ragWorker.stop();
      } catch (error) {
        console.warn("[rag.worker] stop RAG worker failed", error);
      }
      try {
        ragServices.ragRetrievalTraceRetention.stop();
      } catch (error) {
        console.warn("[rag.worker] stop trace retention failed", error);
      }
    }
    process.exit(code);
  })();
  return gracefulExitPromise;
}

async function bootstrap(): Promise<void> {
  const [runtimeMigrations, llmFactory, ragCompatibility, services] = await Promise.all([
    import("../db/runtimeMigrations"),
    import("../llm/factory"),
    import("../services/settings/RagCompatibilityBootstrapService"),
    import("../services/rag"),
  ]);
  ragServices = services.ragServices;
  await runtimeMigrations.ensureRuntimeDatabaseReady();
  await llmFactory.loadProviderApiKeys().catch((error) => {
    console.warn("[rag.worker] failed to load provider API keys", error);
  });
  await ragCompatibility.initializeRagSettingsCompatibility().catch((error) => {
    console.warn("[rag.worker] failed to initialize RAG compatibility settings", error);
  });

  if (shutdownRequested) {
    await gracefulExit(0);
    return;
  }

  ready = true;
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  sendHeartbeat();

  ragServices.ragWorker.start();
  console.log("[rag.worker] started pid=" + process.pid);

  const pending = queuedMessages;
  queuedMessages = [];
  for (const message of pending) {
    if (shuttingDown) break;
    dispatchMessage(message);
  }
}

if (require.main === module) {
  // Register before bootstrap: Node drops IPC events when no message listener
  // exists, so an async bootstrap must never own listener registration.
  process.on("message", handleControlMessage);
  process.once("SIGINT", () => {
    void gracefulExit(0);
  });
  process.once("SIGTERM", () => {
    void gracefulExit(0);
  });

  void bootstrap().catch((error) => {
    console.error("[rag.worker] bootstrap failed", error);
    process.exit(1);
  });
}
