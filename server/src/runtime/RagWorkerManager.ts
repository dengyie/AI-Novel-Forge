import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db/prisma";
import { ragConfig } from "../config/rag";
import { resolveLogsRoot } from "./appPaths";
import { RagClient } from "./RagClient";
import type { WorkerLike } from "./RagClient";
import {
  RAG_WORKER_RECOVERY_RETRY_MAX_MS,
  RAG_WORKER_SHUTDOWN_TIMEOUT_MS,
} from "./ragWorkerProtocol";
import type { RagWorkerResponse } from "./ragWorkerProtocol";

const POLL_INTERVAL_MS = 15_000;
const HEARTBEAT_STALLED_MS = 2 * 60_000;
const RECOVERY_RETRY_BASE_MS = 1_000;
const LOG_CLOSE_FALLBACK_MS = 1_000;
const configuredHeapMb = Number(process.env.RAG_WORKER_HEAP_MB);
const WORKER_HEAP_MB = Number.isSafeInteger(configuredHeapMb)
  ? Math.max(96, Math.min(512, configuredHeapMb))
  : 128;

function workerExecArgv(): string[] {
  return [
    ...process.execArgv.filter((arg) => !arg.startsWith("--max-old-space-size=")),
    `--max-old-space-size=${WORKER_HEAP_MB}`,
  ];
}

type WorkerStopReason = "stalled" | "disabled" | "refresh" | "shutdown";
type WorkerState = "idle" | "running" | "stopping";

/**
 * RAG 子进程管理器（pxed 防 OOM Phase 3）。
 *
 * Worker ownership is deliberately serialized here. A child remains the
 * current worker until its `exit` event; only then are interrupted jobs
 * recovered, and only after recovery succeeds can a replacement be forked.
 */
export class RagWorkerManager {
  private worker: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private desiredAlive = false;
  private workerState: WorkerState = "idle";
  private spawnPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopWorkerRef: ChildProcess | null = null;
  private stopReason: WorkerStopReason | null = null;
  private stopResolve: (() => void) | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private workerExitPromise: Promise<void> | null = null;
  private workerExitResolve: (() => void) | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryAttempt = 0;
  private recoveryReason: "stalled" | "exited" = "exited";
  /** Kept true until the corresponding DB recovery attempt succeeds. */
  private recoveryPending = false;
  private idleNotified = false;
  private refreshPromise: Promise<void> | null = null;
  private lastHeartbeatAt = 0;
  private receivedHeartbeat = false;

  readonly client: RagClient;

  constructor() {
    this.client = new RagClient({
      getWorker: () => (
        this.worker && this.workerState === "running"
          ? this.worker as unknown as WorkerLike
          : null
      ),
      ensureWorker: () => {
        this.desiredAlive = true;
        this.idleNotified = false;
        return this.spawnWorkerIfNeeded();
      },
    });
  }

  startPolling(): void {
    if (this.pollTimer || this.shuttingDown) return;
    this.pollTimer = setInterval(() => {
      void this.pollTick();
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
    void this.pollTick();
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** 入队路径秒级唤醒：立即跑一次 poll（有 pending 即 fork），不等 15s 轮询。 */
  kickPoll(): void {
    if (this.shuttingDown || !this.pollTimer) return;
    void this.pollTick();
  }

  /** Stop an idle/active child after runtime settings disable RAG. */
  disable(): Promise<void> {
    this.desiredAlive = false;
    this.idleNotified = false;
    return this.stopCurrentWorker("disabled");
  }

  /**
   * Replace the child after settings have been persisted so it bootstraps a
   * fresh snapshot from the database. The current child stays authoritative
   * until its exit event; that event owns the single running-job recovery.
   */
  refresh(): Promise<void> {
    const previous = this.refreshPromise ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.refreshWorkerInternal());
    this.refreshPromise = operation;
    void operation.then(() => {
      if (this.refreshPromise === operation) {
        this.refreshPromise = null;
      }
    }, () => {
      if (this.refreshPromise === operation) {
        this.refreshPromise = null;
      }
    });
    return operation;
  }

  private async refreshWorkerInternal(): Promise<void> {
    const hadWorker = this.worker !== null;
    const enabledAtStart = ragConfig.enabled;
    this.desiredAlive = enabledAtStart;
    this.idleNotified = false;
    await this.stopCurrentWorker("refresh");
    // stopCurrentWorker resolves at the kill deadline as a bounded caller
    // barrier. Refresh still waits for the authoritative exit event before
    // allowing settings callers to enqueue work for the replacement child.
    if (this.worker && this.workerExitPromise) {
      await this.workerExitPromise;
    }
    const enabled = ragConfig.enabled;
    this.desiredAlive = enabled;

    // A bounded stop can resolve after SIGKILL but before the exit event. Do
    // not fork around the still-authoritative child; its exit handler will
    // retry the recovery/poll path once ownership is released.
    if (this.worker) return;
    if (this.recoveryPending) {
      if (this.recoveryPromise) await this.recoveryPromise;
      if (this.recoveryPending) return;
    }
    if (this.shuttingDown || !enabled || !ragConfig.enabled) return;

    // The exit recovery path owns the first poll after a replacement. Avoid
    // counting and spawning a second child in parallel with that poll.
    if (hadWorker) return;

    const activeJobs = await prisma.ragIndexJob.count({
      where: { status: { in: ["queued", "running"] } },
    });
    if (activeJobs > 0) {
      await this.spawnWorkerIfNeeded();
    }
  }

  private async pollTick(): Promise<void> {
    if (this.shuttingDown) return;
    this.checkStalled();

    if (this.recoveryPending) {
      if (this.recoveryPromise) {
        await this.recoveryPromise;
      }
      // A failed recovery is fail-closed. The retry timer owns the next
      // attempt; no poll or RPC may fork around it.
      if (this.recoveryPending) return;
    }

    try {
      const activeJobs = await prisma.ragIndexJob.count({
        where: { status: { in: ["queued", "running"] } },
      });
      if (activeJobs > 0 && ragConfig.enabled) {
        this.desiredAlive = true;
        this.idleNotified = false;
        await this.spawnWorkerIfNeeded();
      } else if (this.worker && !ragConfig.enabled) {
        await this.disable();
      } else if (
        this.worker
        && this.workerState === "running"
        && this.client.inflightCount === 0
        && !this.idleNotified
      ) {
        this.sendIdle();
      }
    } catch (error) {
      console.warn("[RagWorkerManager] poll tick failed", error);
    }
  }

  private async spawnWorkerIfNeeded(): Promise<void> {
    if (this.shuttingDown || !ragConfig.enabled) return;
    if (this.recoveryPending) {
      if (this.recoveryPromise) await this.recoveryPromise;
      if (this.recoveryPending) return;
    }
    if (this.workerState === "stopping") {
      if (this.stopPromise) await this.stopPromise;
      if (this.worker) return;
      if (this.recoveryPending) {
        if (this.recoveryPromise) await this.recoveryPromise;
        if (this.recoveryPending) return;
      }
    }
    if (this.worker || this.spawnPromise) {
      if (this.spawnPromise) await this.spawnPromise;
      return;
    }

    const spawnPromise = this.spawnWorker();
    this.spawnPromise = spawnPromise;
    try {
      await spawnPromise;
    } finally {
      if (this.spawnPromise === spawnPromise) {
        this.spawnPromise = null;
      }
    }
  }

  private async spawnWorker(): Promise<void> {
    const workerScript = path.join(__dirname, "../workers/ragWorkerEntry.js");
    if (!fs.existsSync(workerScript)) {
      console.error(`[RagWorkerManager] worker script not found: ${workerScript}`);
      return;
    }

    const logDir = resolveLogsRoot();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, `rag-worker-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    this.logStream = logStream;

    let worker: ChildProcess;
    try {
      worker = fork(workerScript, [], {
        env: {
          ...process.env,
          RAG_WORKER_HEAP_MB: String(WORKER_HEAP_MB),
          RAG_WORKER_LOG_PATH: logPath,
        },
        execArgv: workerExecArgv(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "advanced",
      });
    } catch (error) {
      console.error("[RagWorkerManager] fork failed", error);
      logStream.end();
      if (this.logStream === logStream) this.logStream = null;
      return;
    }
    if (!worker.pid) {
      console.error("[RagWorkerManager] fork failed: no pid");
      logStream.end();
      if (this.logStream === logStream) this.logStream = null;
      return;
    }

    this.worker = worker;
    this.workerState = "running";
    this.lastHeartbeatAt = Date.now();
    this.receivedHeartbeat = false;
    this.idleNotified = false;
    worker.stdout?.on("data", (chunk) => {
      if (!logStream.destroyed && !logStream.writableEnded) {
        logStream.write(chunk);
      }
    });
    worker.stderr?.on("data", (chunk) => {
      if (!logStream.destroyed && !logStream.writableEnded) {
        logStream.write(chunk);
      }
    });

    worker.on("message", (message: unknown) => {
      this.handleWorkerMessage(message);
    });

    worker.on("exit", (code, signal) => {
      this.handleWorkerExit(worker, logStream, code, signal);
    });

    worker.on("error", (error) => {
      console.error(`[RagWorkerManager] worker ${worker.pid} error`, error);
    });

    this.client.wire();
    console.log(`[RagWorkerManager] spawned worker ${worker.pid} heapMb=${WORKER_HEAP_MB} log=${logPath}`);
  }

  private handleWorkerExit(
    worker: ChildProcess,
    logStream: fs.WriteStream,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const isCurrentWorker = this.worker === worker;
    console.log(`[RagWorkerManager] worker ${worker.pid} exited code=${code} signal=${signal}`);
    this.closeLogStreamAfterExit(worker, logStream);
    if (!isCurrentWorker) return;

    const recoveryReason = this.workerState === "stopping" && this.stopReason === "stalled"
      ? "stalled"
      : "exited";
    this.worker = null;
    this.workerState = "idle";
    this.logStream = null;
    this.lastHeartbeatAt = 0;
    this.receivedHeartbeat = false;
    this.idleNotified = false;
    this.finishStop(worker);
    this.client.handleWorkerExit();

    if (!this.shuttingDown) {
      this.recoveryPending = true;
      this.recoveryReason = recoveryReason;
      void this.resetRunningJobs(this.recoveryReason);
    }
  }

  private closeLogStreamAfterExit(worker: ChildProcess, logStream: fs.WriteStream): void {
    let closed = false;
    let fallbackTimer: NodeJS.Timeout | null = null;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      worker.removeListener?.("close", close);
      logStream.end();
    };
    if (typeof worker.once === "function") {
      worker.once("close", close);
    } else {
      close();
      return;
    }
    fallbackTimer = setTimeout(close, LOG_CLOSE_FALLBACK_MS);
    fallbackTimer.unref();
  }

  private handleWorkerMessage(message: unknown): void {
    const response = message as (RagWorkerResponse & { type?: string }) | undefined;
    if (!response || typeof response !== "object") return;
    if (response.type === "heartbeat") {
      this.receivedHeartbeat = true;
      this.lastHeartbeatAt = Date.now();
      return;
    }
  }

  /** 心跳看门狗：worker 无响应 ≥2min → SIGTERM/SIGKILL → exit 后重置 running 任务。 */
  private checkStalled(): void {
    if (!this.worker || this.workerState === "stopping" || !this.lastHeartbeatAt) return;
    if (Date.now() - this.lastHeartbeatAt < HEARTBEAT_STALLED_MS) return;
    const pid = this.worker.pid;
    console.warn(`[RagWorkerManager] worker ${pid} heartbeat stalled ≥${HEARTBEAT_STALLED_MS}ms; stopping`);
    this.desiredAlive = true;
    void this.stopCurrentWorker("stalled");
  }

  private async resetRunningJobs(reason: "stalled" | "exited"): Promise<void> {
    if (this.shuttingDown) {
      this.recoveryPending = false;
      return;
    }
    if (this.recoveryPromise) {
      await this.recoveryPromise;
      return;
    }

    this.recoveryReason = reason;
    const attempt = (async (): Promise<void> => {
      try {
        const lastError = reason === "stalled"
          ? "RAG worker stalled; job requeued."
          : "RAG worker exited; job requeued.";
        const result = await prisma.ragIndexJob.updateMany({
          where: { status: "running" },
          data: {
            status: "queued",
            runAfter: new Date(),
            lastError,
            updatedAt: new Date(),
          },
        });
        this.recoveryPending = false;
        this.recoveryAttempt = 0;
        if (this.recoveryTimer) {
          clearTimeout(this.recoveryTimer);
          this.recoveryTimer = null;
        }
        if (result.count > 0) {
          console.warn(`[RagWorkerManager] requeued ${result.count} running job(s) after ${reason}.`);
        }
        if (!this.shuttingDown && this.desiredAlive) {
          void this.pollTick();
        }
      } catch (error) {
        this.recoveryPending = true;
        this.recoveryAttempt += 1;
        const delayMs = Math.min(
          RECOVERY_RETRY_BASE_MS * (2 ** Math.min(this.recoveryAttempt - 1, 5)),
          RAG_WORKER_RECOVERY_RETRY_MAX_MS,
        );
        console.error(`[RagWorkerManager] failed to requeue running jobs; retrying in ${delayMs}ms`, error);
        this.scheduleRecoveryRetry(delayMs);
      }
    })();
    this.recoveryPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.recoveryPromise === attempt) {
        this.recoveryPromise = null;
      }
    }
  }

  private scheduleRecoveryRetry(delayMs: number): void {
    if (this.shuttingDown || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.resetRunningJobs(this.recoveryReason);
    }, delayMs);
    this.recoveryTimer.unref();
  }

  private sendIdle(): void {
    const worker = this.worker;
    if (!worker || this.workerState !== "running") return;
    this.idleNotified = true;
    try {
      worker.send({ type: "idle" }, (error) => {
        if (error && this.worker === worker) {
          this.idleNotified = false;
          console.warn("[RagWorkerManager] failed to notify worker of idle state", error);
        }
      });
    } catch (error) {
      this.idleNotified = false;
      console.warn("[RagWorkerManager] failed to notify worker of idle state", error);
    }
  }

  private stopCurrentWorker(reason: WorkerStopReason): Promise<void> {
    const worker = this.worker;
    if (!worker) return Promise.resolve();
    if (this.stopPromise && this.stopWorkerRef === worker) return this.stopPromise;

    this.workerState = "stopping";
    if (reason === "disabled" || reason === "shutdown") {
      this.desiredAlive = false;
    }
    this.idleNotified = false;

    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
    this.stopWorkerRef = worker;
    this.stopReason = reason;
    this.workerExitPromise = new Promise<void>((resolve) => {
      this.workerExitResolve = resolve;
    });
    this.stopTimer = setTimeout(() => {
      try {
        worker.kill("SIGKILL");
      } catch (error) {
        console.warn("[RagWorkerManager] force-kill worker failed", error);
      }
      // The child reference remains authoritative until `exit`; this resolve
      // only releases callers such as settings/shutdown after the deadline.
      this.stopResolve?.();
    }, RAG_WORKER_SHUTDOWN_TIMEOUT_MS);
    this.stopTimer.unref();

    const onShutdownSend = (error?: Error | null): void => {
      if (!error) return;
      try {
        worker.kill("SIGTERM");
      } catch (killError) {
        console.warn("[RagWorkerManager] failed to terminate worker after IPC error", killError);
      }
    };
    if (typeof worker.send !== "function") {
      onShutdownSend(new Error("worker IPC channel is unavailable"));
    } else {
      try {
        worker.send({ type: "shutdown" }, onShutdownSend);
      } catch (error) {
        console.warn("[RagWorkerManager] failed to request worker shutdown", error);
        onShutdownSend(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return this.stopPromise;
  }

  private finishStop(worker: ChildProcess): void {
    if (this.stopWorkerRef !== worker) return;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.stopResolve?.();
    this.stopResolve = null;
    this.workerExitResolve?.();
    this.workerExitResolve = null;
    this.workerExitPromise = null;
    this.stopPromise = null;
    this.stopWorkerRef = null;
    this.stopReason = null;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.desiredAlive = false;
    this.stopPolling();
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    const worker = this.worker;
    if (!worker) return;
    await this.stopCurrentWorker("shutdown");
    this.client.handleWorkerExit();
  }

  /** 健康快照（/api/rag/health 附带）。 */
  status(): { alive: boolean; pid: number | null; inflightRpcs: number } {
    return {
      alive: this.worker !== null,
      pid: this.worker?.pid ?? null,
      inflightRpcs: this.client.inflightCount,
    };
  }
}

export const ragWorkerManager = new RagWorkerManager();
