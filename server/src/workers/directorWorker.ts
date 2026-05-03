import "dotenv/config";
import os from "node:os";
import { ensureRuntimeDatabaseReady } from "../db/runtimeMigrations";
import { loadProviderApiKeys } from "../llm/factory";
import { initializeRagSettingsCompatibility } from "../services/settings/RagCompatibilityBootstrapService";
import { DirectorCommandService } from "../services/novel/director/DirectorCommandService";
import { DirectorExecutionService } from "../services/novel/director/DirectorExecutionService";
import { DirectorRuntimeExecutionService, type RuntimeExecutionLease } from "../services/novel/director/DirectorRuntimeExecutionService";
import { DirectorWorkerReconciliationService } from "../services/novel/director/DirectorWorkerReconciliationService";

const DEFAULT_POLL_MS = 1500;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_STALE_SCAN_MS = 30_000;
const DEFAULT_RESOURCE_LIMITS: Record<string, number> = {
  writer: 2,
  light_review: 4,
  critical_review: 1,
  repair: 2,
  replan: 1,
  state_resolution: 2,
};

function resolveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDefaultExecutionSlots(): number {
  return Math.min(4, Math.max(2, Math.floor(os.cpus().length / 2)));
}

class ResourceSemaphore {
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.limit <= 0) {
      return operation();
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
    try {
      return await operation();
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.activeCount >= this.limit) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.activeCount += 1;
    next();
  }
}

class DirectorWorkerResourceBudget {
  private readonly semaphores = new Map<string, ResourceSemaphore>();

  async run<T>(resourceClass: string | null | undefined, operation: () => Promise<T>): Promise<T> {
    const key = resourceClass?.trim() || "state_resolution";
    const semaphore = this.getSemaphore(key);
    return semaphore.run(operation);
  }

  private getSemaphore(resourceClass: string): ResourceSemaphore {
    const existing = this.semaphores.get(resourceClass);
    if (existing) {
      return existing;
    }
    const envName = `DIRECTOR_WORKER_RESOURCE_${resourceClass.toUpperCase()}_LIMIT`;
    const fallback = DEFAULT_RESOURCE_LIMITS[resourceClass] ?? 2;
    const created = new ResourceSemaphore(resolveNumberEnv(envName, fallback));
    this.semaphores.set(resourceClass, created);
    return created;
  }
}

export class DirectorWorker {
  private stopped = false;
  private lastStaleScanAt = 0;

  constructor(
    private readonly commandService = new DirectorCommandService(),
    private readonly executionService = new DirectorExecutionService(),
    private readonly runtimeExecutionService = new DirectorRuntimeExecutionService(),
    private readonly reconciliationService = new DirectorWorkerReconciliationService(commandService),
    private readonly resourceBudget = new DirectorWorkerResourceBudget(),
    private readonly options = {
      workerId: process.env.DIRECTOR_WORKER_ID?.trim()
        || `director-worker-${os.hostname()}-${process.pid}`,
      pollMs: resolveNumberEnv("DIRECTOR_WORKER_POLL_MS", DEFAULT_POLL_MS),
      leaseMs: resolveNumberEnv("DIRECTOR_WORKER_LEASE_MS", DEFAULT_LEASE_MS),
      staleScanMs: resolveNumberEnv("DIRECTOR_WORKER_STALE_SCAN_MS", DEFAULT_STALE_SCAN_MS),
      executionSlots: resolveNumberEnv("DIRECTOR_WORKER_EXECUTION_SLOTS", resolveDefaultExecutionSlots()),
    },
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async start(): Promise<void> {
    console.log(
      `[director.worker] started workerId=${this.options.workerId} pollMs=${this.options.pollMs} leaseMs=${this.options.leaseMs} executionSlots=${this.options.executionSlots}`,
    );
    await this.reconcileWorkerState("startup");
    const runners = Array.from({ length: this.options.executionSlots }, (_, index) =>
      this.runSlot(`slot-${index + 1}`));
    await Promise.all(runners);
  }

  async tick(slotId = "slot-1"): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastStaleScanAt >= this.options.staleScanMs) {
      this.lastStaleScanAt = now;
      await this.reconcileWorkerState("tick");
    }

    const lease = await this.runtimeExecutionService.leaseNextExecution({
      workerId: this.options.workerId,
      slotId,
      leaseMs: this.options.leaseMs,
    });
    if (!lease) {
      return false;
    }
    const stopLeaseRenewal = this.startLeaseRenewal(lease, slotId);
    try {
      await this.resourceBudget.run(lease.resourceClass, () => this.executeLeasedRuntimeCommand(lease, slotId));
    } finally {
      stopLeaseRenewal();
    }
    return true;
  }

  private async runSlot(slotId: string): Promise<void> {
    while (!this.stopped) {
      const didWork = await this.tick(slotId).catch((error) => {
        console.error(`[director.worker] slot failed slotId=${slotId}`, error);
        return false;
      });
      if (!didWork) {
        await wait(this.options.pollMs);
      }
    }
  }

  private startLeaseRenewal(lease: RuntimeExecutionLease, slotId: string): () => void {
    const leaseOwner = `${this.options.workerId}:${slotId}`;
    const renewLease = () => {
      void this.runtimeExecutionService.renewExecutionLease(lease.executionId, {
        workerId: this.options.workerId,
        slotId,
        leaseMs: this.options.leaseMs,
      }).catch((error) => {
        console.warn(`[director.worker] failed to renew runtime lease executionId=${lease.executionId}`, error);
      });
      if (lease.legacyCommandId) {
        void this.commandService.renewLease(lease.legacyCommandId, leaseOwner, this.options.leaseMs)
        .catch((error) => {
          console.warn(`[director.worker] failed to renew legacy lease commandId=${lease.legacyCommandId}`, error);
        });
      }
    };
    renewLease();
    const renewTimer = setInterval(renewLease, Math.max(100, Math.floor(this.options.leaseMs / 3)));
    return () => clearInterval(renewTimer);
  }

  private async executeLeasedRuntimeCommand(lease: RuntimeExecutionLease, slotId: string): Promise<void> {
    const leaseOwner = `${this.options.workerId}:${slotId}`;
    try {
      await this.runtimeExecutionService.markExecutionRunning(lease.executionId, {
        workerId: this.options.workerId,
        slotId,
        leaseMs: this.options.leaseMs,
      });
      if (!lease.legacyCommandId) {
        await this.runtimeExecutionService.markExecutionSucceeded(lease.executionId);
        return;
      }
      await this.commandService.markCommandRunning(lease.legacyCommandId, leaseOwner, this.options.leaseMs);
      const command = await this.commandService.getCommandById(lease.legacyCommandId);
      if (!command) {
        throw new Error(`Director command disappeared before execution: ${lease.legacyCommandId}`);
      }
      console.log(`[director.worker] executing commandId=${command.id} runtimeId=${lease.runtimeId} executionId=${lease.executionId} slotId=${slotId} type=${command.commandType} taskId=${command.taskId}`);
      const outcome = await this.executionService.executeCommand(command);
      if (outcome === "cancelled") {
        await this.commandService.markCommandCancelled(command.id, leaseOwner);
        await this.runtimeExecutionService.markExecutionCancelled(lease.executionId);
        console.log(`[director.worker] cancelled commandId=${command.id} taskId=${command.taskId}`);
      } else {
        await this.commandService.markCommandSucceeded(command.id, leaseOwner);
        await this.runtimeExecutionService.markExecutionSucceeded(lease.executionId);
        console.log(`[director.worker] completed commandId=${command.id} taskId=${command.taskId}`);
      }
    } catch (error) {
      console.error(`[director.worker] command failed executionId=${lease.executionId} legacyCommandId=${lease.legacyCommandId}`, error);
      if (lease.legacyCommandId) {
        await this.commandService.markCommandFailed(lease.legacyCommandId, leaseOwner, error).catch(() => null);
      }
      await this.runtimeExecutionService.markExecutionFailed(lease.executionId, error).catch(() => null);
    }
  }

  private async reconcileWorkerState(scope: "startup" | "tick"): Promise<void> {
    const [result, staleRuntimeExecutionCount] = await Promise.all([
      this.reconciliationService.reconcile(),
      this.runtimeExecutionService.recoverStaleExecutions(new Date(), this.options.leaseMs),
    ]);
    if (
      result.staleLeaseCount === 0
      && result.closedStepCount === 0
      && result.requeuedDanglingTaskCount === 0
      && result.adoptedLegacyCommandCount === 0
      && staleRuntimeExecutionCount === 0
    ) {
      return;
    }
    console.warn(
      `[director.worker] reconciled state scope=${scope} staleLeases=${result.staleLeaseCount} staleRuntimeExecutions=${staleRuntimeExecutionCount} closedSteps=${result.closedStepCount} requeuedTasks=${result.requeuedDanglingTaskCount} adoptedLegacyCommands=${result.adoptedLegacyCommandCount}`,
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
