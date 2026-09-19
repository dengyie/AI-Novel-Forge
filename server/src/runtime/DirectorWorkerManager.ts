import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db/prisma";
import { resolveLogsRoot } from "./appPaths";

const POLL_INTERVAL_MS = 10_000;
const IDLE_EXIT_AFTER_MS = Number(process.env.DIRECTOR_WORKER_IDLE_EXIT_MS) || 5 * 60_000;
const LOG_CLOSE_FALLBACK_MS = 1_000;
const WORKER_HEAP_MB = Number.isSafeInteger(Number(process.env.DIRECTOR_WORKER_HEAP_MB))
  ? Math.max(192, Math.min(768, Number(process.env.DIRECTOR_WORKER_HEAP_MB)))
  : 384;

type CloseEventTarget = {
  once?: (event: string | symbol, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: string | symbol, listener: (...args: any[]) => void) => unknown;
};

function workerExecArgv(): string[] {
  return [
    ...process.execArgv.filter((arg) => !arg.startsWith("--max-old-space-size=")),
    `--max-old-space-size=${WORKER_HEAP_MB}`,
  ];
}

/**
 * Director worker 子进程管理器（pxed 防 OOM Phase 3）。
 *
 * directorWorker import 树（DirectorCommandExecutor → langgraph/agents 全家）实测
 * +96MB heap。worker 逻辑（lease/execute/事件投影）不动，直接 fork 现有
 * `dist/workers/directorWorker.js` 独立入口（自带 bootstrap 与信号处理）。
 *
 * 唤醒模型：Manager 的 DB 轮询负责发现待处理命令；`kick()` 为已接入的显式
 * 唤醒入口发送 IPC 消息并复位 idle 计时。状态流照旧走 DB 投影（SSE/routes 无感知）。
 */
export class DirectorWorkerManager {
  private worker: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private spawnedAt = 0;

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

  private async hasPendingCommands(): Promise<boolean> {
    const active = await prisma.directorRunCommand.count({
      where: { status: { in: ["queued", "leased", "running"] } },
    });
    if (active > 0) return true;
    // runAfter 未到的 queued 命令也需要子进程在场（worker 内部会到点 lease）。
    const queued = await prisma.directorRunCommand.count({ where: { status: "queued" } });
    return queued > 0;
  }

  private async pollTick(): Promise<void> {
    if (this.shuttingDown) return;
    try {
      const hasWork = await this.hasPendingCommands();
      if (hasWork) {
        if (this.worker) {
          this.kick();
        } else {
          await this.spawnWorker();
        }
      }
    } catch (error) {
      console.warn("[DirectorWorkerManager] poll tick failed", error);
    }
  }

  /** 入队路径秒级唤醒：fork 缺位则拉起，在场则 IPC kick（复位子进程空闲退出计时）。 */
  kick(): void {
    if (this.shuttingDown) return;
    if (this.worker) {
      try {
        this.worker.send({ type: "kick" });
      } catch {
        // 子进程正退出；下轮 poll 兜底
      }
    } else {
      void this.spawnWorker();
    }
  }

  private async spawnWorker(): Promise<void> {
    if (this.shuttingDown || this.worker) return;

    const workerScript = path.join(__dirname, "../workers/directorWorker.js");
    if (!fs.existsSync(workerScript)) {
      console.error(`[DirectorWorkerManager] worker script not found: ${workerScript}`);
      return;
    }

    const logDir = resolveLogsRoot();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, `director-worker-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    this.logStream = logStream;

    const worker = fork(workerScript, [], {
      env: { ...process.env },
      execArgv: workerExecArgv(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    if (!worker.pid) {
      console.error("[DirectorWorkerManager] fork failed: no pid");
      logStream.end();
      if (this.logStream === logStream) this.logStream = null;
      return;
    }
    this.worker = worker;
    this.spawnedAt = Date.now();
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
      if (typeof message === "object" && message !== null && (message as { type?: string }).type === "idle-exit") {
        console.log("[DirectorWorkerManager] worker idle exit requested");
      }
    });

    worker.on("exit", (code, signal) => {
      const uptimeSec = Math.round((Date.now() - this.spawnedAt) / 1000);
      console.log(`[DirectorWorkerManager] worker ${worker.pid} exited code=${code} signal=${signal} uptime=${uptimeSec}s`);
      if (this.worker === worker) {
        this.worker = null;
      }
      if (this.logStream === logStream) {
        this.logStream = null;
      }
      this.closeLogStreamAfterExit(worker, logStream);
    });

    worker.on("error", (error) => {
      console.error(`[DirectorWorkerManager] worker ${worker.pid} error`, error);
    });

    console.log(`[DirectorWorkerManager] spawned worker ${worker.pid} log=${logPath}`);
  }

  private closeLogStreamAfterExit(worker: ChildProcess, logStream: fs.WriteStream): void {
    let closed = false;
    let pending = 0;
    let fallbackTimer: NodeJS.Timeout | null = null;
    const registrations: Array<{
      target: CloseEventTarget;
      listener: (...args: any[]) => void;
    }> = [];

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      for (const { target, listener } of registrations) {
        target.removeListener?.("close", listener);
      }
      logStream.end();
    };

    const waitForClose = (target: CloseEventTarget | null | undefined): void => {
      if (!target || typeof target.once !== "function") return;
      const listener = (): void => {
        pending -= 1;
        if (pending === 0) close();
      };
      pending += 1;
      registrations.push({ target, listener });
      target.once("close", listener);
    };

    const closeTargets: Array<CloseEventTarget | null | undefined> = [
      worker,
      worker.stdout,
      worker.stderr,
    ];
    for (const target of closeTargets) waitForClose(target);
    if (pending === 0) {
      close();
      return;
    }

    fallbackTimer = setTimeout(close, LOG_CLOSE_FALLBACK_MS);
    fallbackTimer.unref();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopPolling();
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    console.log("[DirectorWorkerManager] sending SIGTERM to worker for drain");
    try {
      worker.kill("SIGTERM");
    } catch (error) {
      console.error("[DirectorWorkerManager] kill failed", error);
      return;
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
  }

  status(): { alive: boolean; pid: number | null; uptimeMs: number | null } {
    return {
      alive: this.worker !== null,
      pid: this.worker?.pid ?? null,
      uptimeMs: this.worker ? Date.now() - this.spawnedAt : null,
    };
  }
}

export const directorWorkerManager = new DirectorWorkerManager();
