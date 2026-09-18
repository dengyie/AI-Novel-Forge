import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { M4bJobQueueService } from "./M4bJobQueueService";
import { resolveM4bGlobalConcurrency } from "../infrastructure/m4b/M4bPermitPool";
import { resolveLogsRoot } from "../../../runtime/appPaths";

const CONCURRENCY = resolveM4bGlobalConcurrency();
const HEARTBEAT_CHECK_INTERVAL_MS = Number(process.env.M4B_WORKER_HEARTBEAT_INTERVAL_MS) || 30_000;
const STALLED_THRESHOLD_MS = 2 * 60_000; // 2 minutes no progress = stalled
const WORKER_HEAP_MB = Number.isSafeInteger(Number(process.env.M4B_WORKER_HEAP_MB))
  ? Math.max(256, Math.min(768, Number(process.env.M4B_WORKER_HEAP_MB)))
  : 384;
const WORKER_SEMI_SPACE_MB = 16;
const REPLACEMENT_COOLDOWN_MS = 10_000;

export class M4bWorkerManager {
  private activeWorkers = new Map<number, ChildProcess>();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private queueService = new M4bJobQueueService();
  private shuttingDown = false;
  private replacementTimer: NodeJS.Timeout | null = null;
  private lastWorkerExitAt = 0;

  async ensureWorkerForPendingJobs(): Promise<void> {
    if (this.shuttingDown) return;

    if (
      this.activeWorkers.size === 0
      && this.lastWorkerExitAt > 0
      && Date.now() - this.lastWorkerExitAt < REPLACEMENT_COOLDOWN_MS
    ) {
      return;
    }

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

    const workerPid = worker.pid;
    this.activeWorkers.set(workerPid, worker);

    worker.on("exit", (code, signal) => {
      this.lastWorkerExitAt = Date.now();
      console.log(`[M4bWorkerManager] Worker ${workerPid} exited: code=${code} signal=${signal}`);
      this.activeWorkers.delete(workerPid);
      logStream.end();

      if (!this.shuttingDown) {
        void this.queueService.recoverJobsForWorker(String(workerPid)).catch((error) => {
          console.error(`[M4bWorkerManager] Failed to recover jobs for worker ${workerPid}:`, error);
        });
        if (this.replacementTimer) clearTimeout(this.replacementTimer);
        this.replacementTimer = setTimeout(() => {
          this.replacementTimer = null;
          this.ensureWorkerForPendingJobs().catch((error) => {
            console.error("[M4bWorkerManager] Failed to spawn replacement worker:", error);
          });
        }, REPLACEMENT_COOLDOWN_MS);
        this.replacementTimer.unref?.();
      }
    });

    worker.on("error", (error) => {
      console.error(`[M4bWorkerManager] Worker ${workerPid} error:`, error);
      this.activeWorkers.delete(workerPid);
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

      // A DB row may predate the PID fix and contain the API parent PID. Never
      // signal a process merely because an untrusted persisted string parses as
      // a PID; only this manager's currently registered child is killable.
      const registeredWorker = this.activeWorkers.get(workerPid);
      if (!registeredWorker) {
        console.warn(`[M4bWorkerManager] stalled job ${job.id} references unregistered worker ${workerId}; recovering without signalling`);
        if (job.retryCount < 1) {
          await this.queueService.resetJob(job.id);
        } else {
          await this.queueService.markFailed(job.id, "m4b worker ownership was lost");
        }
        continue;
      }

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
        registeredWorker.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        try {
          process.kill(workerPid, 0);
          registeredWorker.kill("SIGKILL");
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

    if (this.replacementTimer) {
      clearTimeout(this.replacementTimer);
      this.replacementTimer = null;
    }

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
