import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { M4bJobQueueService } from "./M4bJobQueueService";
import { resolveLogsRoot } from "../../../runtime/appPaths";

const CONCURRENCY = Number(process.env.AUDIOBOOK_M4B_CONCURRENCY) || 1;
const HEARTBEAT_CHECK_INTERVAL_MS = Number(process.env.M4B_WORKER_HEARTBEAT_INTERVAL_MS) || 30_000;
const STALLED_THRESHOLD_MS = 2 * 60_000; // 2 minutes no progress = stalled
const WORKER_HEAP_MB = 768;
const WORKER_SEMI_SPACE_MB = 16;

export class M4bWorkerManager {
  private activeWorkers = new Map<number, ChildProcess>();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private queueService = new M4bJobQueueService();
  private shuttingDown = false;

  async ensureWorkerForPendingJobs(): Promise<void> {
    if (this.shuttingDown) return;

    const hasPending = await this.queueService.hasPendingJobs();
    if (!hasPending) return;

    if (this.activeWorkers.size >= CONCURRENCY) return;

    this.spawnWorker();

    if (!this.watchdogTimer) {
      this.startHeartbeatWatchdog();
    }
  }

  private spawnWorker(): void {
    if (this.activeWorkers.size >= CONCURRENCY) return;

    const workerScript = path.join(__dirname, "../../workers/m4b-worker.js");
    if (!fs.existsSync(workerScript)) {
      console.error(`[M4bWorkerManager] Worker script not found: ${workerScript}`);
      return;
    }

    const logDir = resolveLogsRoot();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, `m4b-worker-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    const worker = spawn(
      "node",
      [
        `--max-old-space-size=${WORKER_HEAP_MB}`,
        `--max-semi-space-size=${WORKER_SEMI_SPACE_MB}`,
        workerScript,
      ],
      {
        env: {
          ...process.env,
          M4B_WORKER_ID: `${process.pid}`,
          M4B_WORKER_LOG_PATH: logPath,
        },
        stdio: ["ignore", logStream, logStream],
        detached: false,
      },
    );

    if (!worker.pid) {
      console.error("[M4bWorkerManager] Worker spawn failed: no PID");
      logStream.end();
      return;
    }

    this.activeWorkers.set(worker.pid, worker);

    worker.on("exit", (code, signal) => {
      console.log(`[M4bWorkerManager] Worker ${worker.pid} exited: code=${code} signal=${signal}`);
      this.activeWorkers.delete(worker.pid!);
      logStream.end();

      if (!this.shuttingDown) {
        this.ensureWorkerForPendingJobs().catch((error) => {
          console.error("[M4bWorkerManager] Failed to spawn replacement worker:", error);
        });
      }
    });

    worker.on("error", (error) => {
      console.error(`[M4bWorkerManager] Worker ${worker.pid} error:`, error);
      this.activeWorkers.delete(worker.pid!);
      logStream.end();
    });

    console.log(`[M4bWorkerManager] Spawned worker ${worker.pid}`);
  }

  private startHeartbeatWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      this.handleStalledJobs().catch((error) => {
        console.error("[M4bWorkerManager] Watchdog error:", error);
      });
    }, HEARTBEAT_CHECK_INTERVAL_MS);
  }

  private async handleStalledJobs(): Promise<void> {
    const stalled = await this.queueService.getStalledJobs(STALLED_THRESHOLD_MS);

    for (const job of stalled) {
      const workerId = job.workerId;
      if (!workerId) continue;

      const workerPid = Number(workerId);
      if (!Number.isSafeInteger(workerPid)) continue;

      let isAlive = false;
      try {
        process.kill(workerPid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }

      if (!isAlive) {
        console.log(`[M4bWorkerManager] Worker ${workerId} dead, resetting job ${job.id}`);
        if (job.retryCount < 1) {
          await this.queueService.resetJob(job.id);
        } else {
          await this.queueService.markFailed(job.id, "Max retries exceeded after worker death");
        }
        continue;
      }

      console.log(`[M4bWorkerManager] Worker ${workerId} stalled on job ${job.id}, killing`);
      try {
        process.kill(workerPid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        try {
          process.kill(workerPid, 0);
          process.kill(workerPid, "SIGKILL");
        } catch {
          // already dead
        }
      } catch (error) {
        console.error(`[M4bWorkerManager] Failed to kill worker ${workerId}:`, error);
      }

      if (job.retryCount < 1) {
        await this.queueService.resetJob(job.id);
      } else {
        await this.queueService.markFailed(job.id, "Max retries exceeded after stall");
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    const workers = Array.from(this.activeWorkers.values());
    for (const worker of workers) {
      try {
        worker.kill("SIGTERM");
      } catch (error) {
        console.error(`[M4bWorkerManager] Failed to kill worker ${worker.pid}:`, error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));

    for (const worker of workers) {
      try {
        worker.kill("SIGKILL");
      } catch {
        // ignore
      }
    }

    this.activeWorkers.clear();
  }
}

export const m4bWorkerManager = new M4bWorkerManager();
