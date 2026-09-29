import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { M4bJobQueueService } from "./M4bJobQueueService";
import { resolveM4bGlobalConcurrency } from "../infrastructure/m4b/M4bPermitPool";
import { isM4bWorkerEnabled } from "../audiobookM4b";
import { resolveLogsRoot } from "../../../runtime/appPaths";

import { stopOwnedM4bProcess, type OwnedM4bProcess } from "./M4bOwnedProcess";

const CONCURRENCY = resolveM4bGlobalConcurrency();
const HEARTBEAT_CHECK_INTERVAL_MS = Number(process.env.M4B_WORKER_HEARTBEAT_INTERVAL_MS) || 30_000;
const STALLED_THRESHOLD_MS = 2 * 60_000; // 2 minutes no progress = stalled
const WORKER_HEAP_MB = Number.isSafeInteger(Number(process.env.M4B_WORKER_HEAP_MB))
  ? Math.max(256, Math.min(768, Number(process.env.M4B_WORKER_HEAP_MB)))
  : 384;
const WORKER_SEMI_SPACE_MB = 16;
const REPLACEMENT_COOLDOWN_MS = 10_000;

export class M4bWorkerManager {
  private ownedProcesses = new Map<number, OwnedM4bProcess>();
  private exitSettlements = new Set<Promise<void>>();
  private activeWorkers = new Map<number, ChildProcess>();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private queueService = new M4bJobQueueService();
  private shuttingDown = false;
  private replacementTimer: NodeJS.Timeout | null = null;
  private lastWorkerExitAt = 0;

  async start(): Promise<void> {
    if (this.shuttingDown || !isM4bWorkerEnabled()) return;
    if (!this.watchdogTimer) this.startHeartbeatWatchdog();
    await this.handleStalledJobs();
    await this.ensureWorkerForPendingJobs();
  }

  async ensureWorkerForPendingJobs(): Promise<void> {
    if (this.shuttingDown || !isM4bWorkerEnabled()) return;

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

    await this.spawnWorker();

    if (!this.watchdogTimer) {
      this.startHeartbeatWatchdog();
    }
  }

  private async spawnWorker(): Promise<void> {
    if (this.activeWorkers.size >= CONCURRENCY) return;

    // ts-node-dev runs this manager under src; workers still use the built server runtime.
    const workerScript = path.join(__dirname, __filename.endsWith(".ts")
      ? "../../../../dist/workers/m4b-worker.js"
      : "../../../workers/m4b-worker.js");
    if (!fs.existsSync(workerScript)) {
      throw new Error(`M4b worker entry missing: ${workerScript}; build the server before encoding`);
    }

    const logDir = resolveLogsRoot();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, `m4b-worker-${Date.now()}.log`);
    const logFd = fs.openSync(logPath, "a");

    let worker: ChildProcess;
    try {
      worker = spawn(process.execPath, [
        `--max-old-space-size=${WORKER_HEAP_MB}`,
        `--max-semi-space-size=${WORKER_SEMI_SPACE_MB}`,
        workerScript,
      ], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", M4B_WORKER_LOG_PATH: logPath },
        stdio: ["ignore", logFd, logFd, "ipc"],
        detached: false,
      });
    } finally { fs.closeSync(logFd); }

    worker.on("error", (error) => console.error("[M4bWorkerManager] spawn error", error));
    if (!worker.pid) {
      console.error("[M4bWorkerManager] Worker spawn failed: no PID");
      throw new Error("M4b worker failed to spawn");
    }

    const workerPid = worker.pid;
    this.activeWorkers.set(workerPid, worker);

    worker.on("message", (message: unknown) => {
      const record = message as { type?: string; pid?: number; partPath?: string };
      if (record?.type === "m4b-owned-process" && Number.isSafeInteger(record.pid)
        && record.pid! > 0 && typeof record.partPath === "string" && path.isAbsolute(record.partPath)
        && record.partPath.endsWith(".part") && this.activeWorkers.get(workerPid) === worker) {
        this.ownedProcesses.set(workerPid, { pid: record.pid!, partPath: record.partPath });
      }
    });

    worker.on("exit", (code, signal) => {
      this.lastWorkerExitAt = Date.now();
      console.log(`[M4bWorkerManager] Worker ${workerPid} exited: code=${code} signal=${signal}`);
      this.activeWorkers.delete(workerPid);

      const settlement = this.recoverAndReplaceWorker(workerPid);
      this.exitSettlements.add(settlement);
      void settlement.finally(() => this.exitSettlements.delete(settlement));
    });

    worker.on("error", (error) => {
      console.error(`[M4bWorkerManager] Worker ${workerPid} error:`, error);
      this.activeWorkers.delete(workerPid);
    });

    await new Promise<void>((resolve, reject) => {
      worker.once("spawn", resolve);
      worker.once("error", reject);
    });
    console.log(`[M4bWorkerManager] Spawned worker ${worker.pid}`);
  }

  private async recoverAndReplaceWorker(workerPid: number): Promise<void> {
    const owned = this.ownedProcesses.get(workerPid);
    if (owned) {
      try { await stopOwnedM4bProcess(owned); this.ownedProcesses.delete(workerPid); }
      catch (error) { console.warn("[m4b-worker] cleanup pending; lease retained", error); return; }
    }
    try {
      await this.queueService.recoverJobsForWorker(String(workerPid));
    } catch (error) {
      console.error(`[M4bWorkerManager] Failed to recover jobs for worker ${workerPid}:`, error);
    }
    if (this.shuttingDown || !isM4bWorkerEnabled()) return;
    if (this.replacementTimer) clearTimeout(this.replacementTimer);
    this.replacementTimer = setTimeout(() => {
      this.replacementTimer = null;
      this.ensureWorkerForPendingJobs().catch((error) => {
        console.error("[M4bWorkerManager] Failed to spawn replacement worker:", error);
      });
    }, REPLACEMENT_COOLDOWN_MS);
    this.replacementTimer.unref?.();
  }

  private startHeartbeatWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      this.handleStalledJobs().then(() => this.ensureWorkerForPendingJobs()).catch((error) => {
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
        const owned = this.ownedProcesses.get(workerPid);
        if (owned) {
          await stopOwnedM4bProcess(owned);
          this.ownedProcesses.delete(workerPid);
        }
        console.warn(`[M4bWorkerManager] stalled job ${job.id} references unregistered worker ${workerId}; recovering without signalling`);
        if (job.retryCount < 1) {
          await this.queueService.resetJob(job);
        } else {
          await this.queueService.markFailed(job, "m4b worker ownership was lost");
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
          await this.queueService.resetJob(job);
        } else {
          await this.queueService.markFailed(job, "Max retries exceeded after worker death");
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

      // exit handler owns recovery; never reset again after exit already requeued the lease.
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
    if (workers.length === 0) {
      await Promise.all(this.exitSettlements);
      return;
    }

    const exits = Promise.all(workers.map((worker) => new Promise<void>((resolve) => {
      if (worker.exitCode !== null || worker.signalCode !== null) resolve();
      else worker.once("exit", () => resolve());
    })));
    const waitForExits = (ms: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void exits.then(() => { clearTimeout(timer); resolve(true); });
    });
    for (const worker of workers) worker.kill("SIGTERM");
    if (!await waitForExits(5_000)) {
      for (const worker of workers) worker.kill("SIGKILL");
      if (!await waitForExits(2_000)) throw new Error("M4b worker shutdown did not settle");
    }
    await Promise.all(this.exitSettlements);
    this.activeWorkers.clear();
  }
}

export const m4bWorkerManager = new M4bWorkerManager();
