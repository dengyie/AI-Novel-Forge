import "dotenv/config";
import os from "node:os";
import { ensureRuntimeDatabaseReady } from "../db/runtimeMigrations";
import { loadProviderApiKeys } from "../llm/factory";
import { initializeRagSettingsCompatibility } from "../services/settings/RagCompatibilityBootstrapService";
import { DirectorCommandService } from "../services/novel/director/DirectorCommandService";
import { DirectorExecutionService } from "../services/novel/director/DirectorExecutionService";
import { DirectorWorkerReconciliationService } from "../services/novel/director/DirectorWorkerReconciliationService";

const DEFAULT_POLL_MS = 1500;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_STALE_SCAN_MS = 30_000;

function resolveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DirectorWorker {
  private stopped = false;
  private lastStaleScanAt = 0;

  constructor(
    private readonly commandService = new DirectorCommandService(),
    private readonly executionService = new DirectorExecutionService(),
    private readonly reconciliationService = new DirectorWorkerReconciliationService(commandService),
    private readonly options = {
      workerId: process.env.DIRECTOR_WORKER_ID?.trim()
        || `director-worker-${os.hostname()}-${process.pid}`,
      pollMs: resolveNumberEnv("DIRECTOR_WORKER_POLL_MS", DEFAULT_POLL_MS),
      leaseMs: resolveNumberEnv("DIRECTOR_WORKER_LEASE_MS", DEFAULT_LEASE_MS),
      staleScanMs: resolveNumberEnv("DIRECTOR_WORKER_STALE_SCAN_MS", DEFAULT_STALE_SCAN_MS),
    },
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async start(): Promise<void> {
    console.log(
      `[director.worker] started workerId=${this.options.workerId} pollMs=${this.options.pollMs} leaseMs=${this.options.leaseMs}`,
    );
    await this.reconcileWorkerState("startup");
    while (!this.stopped) {
      const didWork = await this.tick().catch((error) => {
        console.error("[director.worker] tick failed", error);
        return false;
      });
      if (!didWork) {
        await wait(this.options.pollMs);
      }
    }
  }

  async tick(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastStaleScanAt >= this.options.staleScanMs) {
      this.lastStaleScanAt = now;
      await this.reconcileWorkerState("tick");
    }

    const command = await this.commandService.leaseNextCommand({
      workerId: this.options.workerId,
      leaseMs: this.options.leaseMs,
    });
    if (!command) {
      return false;
    }
    await this.executeLeasedCommand(command.id);
    return true;
  }

  private async executeLeasedCommand(commandId: string): Promise<void> {
    const renewTimer = setInterval(() => {
      void this.commandService.renewLease(commandId, this.options.workerId, this.options.leaseMs)
        .catch((error) => {
          console.warn(`[director.worker] failed to renew lease commandId=${commandId}`, error);
        });
    }, Math.max(1000, Math.floor(this.options.leaseMs / 3)));

    try {
      await this.commandService.markCommandRunning(commandId, this.options.workerId, this.options.leaseMs);
      const command = await this.commandService.getCommandById(commandId);
      if (!command) {
        throw new Error(`Director command disappeared before execution: ${commandId}`);
      }
      console.log(`[director.worker] executing commandId=${command.id} type=${command.commandType} taskId=${command.taskId}`);
      const outcome = await this.executionService.executeCommand(command);
      if (outcome === "cancelled") {
        await this.commandService.markCommandCancelled(commandId, this.options.workerId);
        console.log(`[director.worker] cancelled commandId=${command.id} taskId=${command.taskId}`);
      } else {
        await this.commandService.markCommandSucceeded(commandId, this.options.workerId);
        console.log(`[director.worker] completed commandId=${command.id} taskId=${command.taskId}`);
      }
    } catch (error) {
      console.error(`[director.worker] command failed commandId=${commandId}`, error);
      await this.commandService.markCommandFailed(commandId, this.options.workerId, error).catch(() => null);
    } finally {
      clearInterval(renewTimer);
    }
  }

  private async reconcileWorkerState(scope: "startup" | "tick"): Promise<void> {
    const result = await this.reconciliationService.reconcile();
    if (
      result.staleLeaseCount === 0
      && result.closedStepCount === 0
      && result.requeuedDanglingTaskCount === 0
    ) {
      return;
    }
    console.warn(
      `[director.worker] reconciled state scope=${scope} staleLeases=${result.staleLeaseCount} closedSteps=${result.closedStepCount} requeuedTasks=${result.requeuedDanglingTaskCount}`,
    );
  }
}

async function bootstrap(): Promise<void> {
  await ensureRuntimeDatabaseReady();
  await initializeRagSettingsCompatibility().catch((error) => {
    console.warn("[director.worker] failed to initialize RAG compatibility settings.", error);
  });
  await loadProviderApiKeys().catch((error) => {
    console.warn("[director.worker] failed to load provider API keys from database.", error);
  });
  const worker = new DirectorWorker();
  process.once("SIGINT", () => worker.stop());
  process.once("SIGTERM", () => worker.stop());
  await worker.start();
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    console.error("[director.worker] bootstrap failed", error);
    process.exit(1);
  });
}
