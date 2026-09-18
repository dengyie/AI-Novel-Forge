import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db/prisma";
import { ragConfig } from "../config/rag";
import { resolveLogsRoot } from "./appPaths";
import { RagClient } from "./RagClient";
import type { WorkerLike } from "./RagClient";
import type { RagWorkerRequest, RagWorkerResponse } from "./ragWorkerProtocol";

const POLL_INTERVAL_MS = 15_000;
const HEARTBEAT_STALLED_MS = 2 * 60_000;
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

/**
 * RAG worker 子进程管理器（pxed 防 OOM Phase 3）。
 *
 * RAG 全家 import 树实测 +85MB heap，且检索只在聊天/生成时偶发、索引在后台低速
 * 运行——没必要常驻主进程。本 Manager：
 * - 轮询 RagIndexJob 有无 queued/running → fork 子进程（入口 workers/ragWorkerEntry.ts）
 * - 检索 RPC（buildContextBlock 等）由 RagClient 经 IPC 直连子进程
 * - 心跳看门狗：心跳停更 ≥2min → SIGTERM→SIGKILL→重置 running 任务（下轮重跑）
 * - 任意 worker 异常退出也重置 running 任务，避免 SIGKILL/OOM 后留下永久 running 行
 * - 队列空 + 无在途 RPC 达宽限期 → 子进程自杀，Manager 按需再 fork
 *
 * 主进程因此不再 import services/rag 任何模块（app.ts 已移除该 import）。
 */
export class RagWorkerManager {
  private worker: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private lastHeartbeatAt = 0;
  private receivedHeartbeat = false;

  readonly client: RagClient;

  constructor() {
    this.client = new RagClient({
      getWorker: () => (this.worker as unknown as WorkerLike | null),
      ensureWorker: () => {
        void this.spawnWorkerIfNeeded();
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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 入队路径秒级唤醒：立即跑一次 poll（有 pending 即 fork），不等 15s 轮询。 */
  kickPoll(): void {
    if (this.shuttingDown || !this.pollTimer) return;
    void this.pollTick();
  }

  /** Stop an idle/active child after runtime settings disable RAG. */
  disable(): void {
    const worker = this.worker;
    if (!worker) return;
    try {
      worker.send({ type: "shutdown" }, (error) => {
        if (!error || this.worker !== worker) return;
        console.warn("[RagWorkerManager] disabled worker did not accept shutdown; killing", error);
        this.killWorkerSync();
        void this.resetRunningJobs("exited");
      });
    } catch (error) {
      console.warn("[RagWorkerManager] failed to stop disabled worker", error);
      this.killWorkerSync();
      void this.resetRunningJobs("exited");
    }
  }

  private async pollTick(): Promise<void> {
    if (this.shuttingDown) return;
    this.checkStalled();
    try {
      const activeJobs = await prisma.ragIndexJob.count({
        where: { status: { in: ["queued", "running"] } },
      });
      if (activeJobs > 0 && ragConfig.enabled) {
        await this.spawnWorkerIfNeeded();
      } else if (this.worker && !ragConfig.enabled) {
        this.disable();
      } else if (this.worker && this.client.inflightCount === 0) {
        // 无任务也无在途检索：通知子进程进入空闲倒计时（宽限期内来活会被 kick 复位）。
        this.worker.send({ type: "idle" });
      }
    } catch (error) {
      console.warn("[RagWorkerManager] poll tick failed", error);
    }
  }

  private async spawnWorkerIfNeeded(): Promise<void> {
    if (this.shuttingDown || this.worker) return;
    if (!ragConfig.enabled) return;

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
    this.lastHeartbeatAt = Date.now();
    this.receivedHeartbeat = false;
    worker.stdout?.on("data", (chunk) => logStream.write(chunk));
    worker.stderr?.on("data", (chunk) => logStream.write(chunk));

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
    logStream.end();
    if (!isCurrentWorker) return;

    this.worker = null;
    this.logStream = null;
    this.client.handleWorkerExit();
    if (!this.shuttingDown) {
      // A crash/SIGKILL has no worker-side cleanup opportunity. Requeue before
      // the next poll, otherwise the manager only sees queued jobs and a
      // running row can remain stuck indefinitely.
      void this.resetRunningJobs("exited");
    }
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

  /** 心跳看门狗：worker 无响应 ≥2min → 杀掉重置 running 任务。 */
  private checkStalled(): void {
    if (!this.worker || !this.lastHeartbeatAt) return;
    if (!this.receivedHeartbeat) return; // 从未握手，等首轮心跳
    if (Date.now() - this.lastHeartbeatAt < HEARTBEAT_STALLED_MS) return;
    const pid = this.worker.pid;
    console.warn(`[RagWorkerManager] worker ${pid} heartbeat stalled ≥${HEARTBEAT_STALLED_MS}ms; killing`);
    this.killWorkerSync();
    void this.resetRunningJobs("stalled");
  }

  private async resetRunningJobs(reason: "stalled" | "exited"): Promise<void> {
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
      if (result.count > 0) {
        console.warn(`[RagWorkerManager] requeued ${result.count} running job(s) after stall kill.`);
      }
    } catch (error) {
      console.error("[RagWorkerManager] failed to requeue running jobs", error);
    }
  }

  private killWorkerSync(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    try {
      worker.kill("SIGTERM");
      setTimeout(() => {
        try {
          if (worker.pid) process.kill(worker.pid, 0);
          worker.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 5_000).unref();
    } catch (error) {
      console.error("[RagWorkerManager] kill worker failed", error);
    }
    this.logStream?.end();
    this.logStream = null;
    this.client.handleWorkerExit();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopPolling();
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    try {
      worker.send({ type: "shutdown" });
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 5_000);
      timer.unref();
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      worker.kill("SIGKILL");
    } catch {
      // already dead
    }
    this.logStream?.end();
    this.logStream = null;
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
