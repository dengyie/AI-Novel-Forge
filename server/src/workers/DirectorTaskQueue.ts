import os from "node:os";
import { prisma } from "../db/prisma";
import { DirectorRuntimeExecutionService } from "../services/novel/director/DirectorRuntimeExecutionService";
import type {
  RuntimeExecutionLease,
  RuntimeLeaseInput,
} from "../services/novel/director/DirectorRuntimeExecutionHelpers";
import { taskDispatcher } from "./TaskDispatcher";

/**
 * 每本小说独立的资源预算。多本小说完全并行，互不阻塞。
 * 限流只在同一本小说内生效：防止单本小说内同类步骤过度并发。
 */
const PER_NOVEL_RESOURCE_LIMITS: Record<string, number> = {
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

function resolveDefaultSlots(): number {
  return Math.max(4, os.cpus().length);
}

class ResourceGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.limit <= 0) return;
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    if (this.limit <= 0) return;
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

export interface DirectorTaskQueueOptions {
  workerId?: string;
  leaseMs?: number;
  staleScanMs?: number;
  executionSlots?: number;
  pollMs?: number;
}

type RuntimeExecutionServiceLike = Pick<
  DirectorRuntimeExecutionService,
  | "leaseNextExecution"
  | "markExecutionRunning"
  | "renewExecutionLease"
  | "markExecutionSucceeded"
  | "markExecutionCancelled"
  | "markExecutionFailed"
  | "recoverStaleExecutions"
>;

export interface DirectorTaskQueueDeps {
  runtimeExecutionService?: RuntimeExecutionServiceLike;
}

export interface LeasedTask {
  lease: RuntimeExecutionLease;
  legacyCommand: NonNullable<Awaited<ReturnType<typeof prisma.directorRunCommand.findUnique>>>;
}

/**
 * 统一任务队列：封装 DirectorRunCommand + DirectorRuntimeCommand 双系统，
 * 对外暴露 lease / complete / fail 语义，消费者不需要感知底层双写。
 */
export class DirectorTaskQueue {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly staleScanMs: number;
  readonly executionSlots: number;
  readonly pollMs: number;

  private readonly gates = new Map<string, ResourceGate>();
  private readonly runtimeExecutionService: RuntimeExecutionServiceLike;
  private lastStaleScan = 0;

  constructor(options: DirectorTaskQueueOptions = {}, deps: DirectorTaskQueueDeps = {}) {
    this.workerId = options.workerId
      ?? process.env.DIRECTOR_WORKER_ID?.trim()
      ?? `director-worker-${os.hostname()}-${process.pid}`;
    this.leaseMs = resolveNumberEnv("DIRECTOR_WORKER_LEASE_MS", options.leaseMs ?? 120_000);
    this.staleScanMs = resolveNumberEnv("DIRECTOR_WORKER_STALE_SCAN_MS", options.staleScanMs ?? 30_000);
    this.executionSlots = resolveNumberEnv("DIRECTOR_WORKER_EXECUTION_SLOTS", options.executionSlots ?? resolveDefaultSlots());
    this.pollMs = resolveNumberEnv("DIRECTOR_WORKER_POLL_MS", options.pollMs ?? 5_000);
    this.runtimeExecutionService = deps.runtimeExecutionService ?? new DirectorRuntimeExecutionService();
  }

  /**
   * 从统一队列租借下一个可执行任务。
   * 优先使用 Runtime 系统，找不到时查 legacy 并自动桥接。
   */
  async leaseNext(slotId: string): Promise<LeasedTask | null> {
    await this.maybeScanStale();

    const leaseInput: RuntimeLeaseInput = {
      workerId: this.workerId,
      slotId,
      leaseMs: this.leaseMs,
    };

    const lease = await this.leaseFromRuntimeQueue(leaseInput);
    if (!lease) return null;

    if (!lease.legacyCommandId) {
      await this.markExecutionSucceeded(lease.executionId);
      return null;
    }

    const command = await prisma.directorRunCommand.findUnique({
      where: { id: lease.legacyCommandId },
    });
    if (!command) {
      await this.markExecutionFailed(lease.executionId, new Error("Director command disappeared before execution"));
      return null;
    }

    return { lease, legacyCommand: command };
  }

  /**
   * 获取 per-novel 资源 gate。
   * key = `${novelId}:${resourceClass}`，每本小说有独立预算，互不阻塞。
   */
  async acquireResourceGate(novelId: string | null | undefined, resourceClass: string | null | undefined): Promise<void> {
    const rc = resourceClass?.trim() || "state_resolution";
    const nid = novelId?.trim() || "_global";
    const key = `${nid}:${rc}`;
    let gate = this.gates.get(key);
    if (!gate) {
      const envName = `DIRECTOR_WORKER_RESOURCE_${rc.toUpperCase()}_LIMIT`;
      const limit = resolveNumberEnv(envName, PER_NOVEL_RESOURCE_LIMITS[rc] ?? 2);
      gate = new ResourceGate(limit);
      this.gates.set(key, gate);
    }
    await gate.acquire();
  }

  releaseResourceGate(novelId: string | null | undefined, resourceClass: string | null | undefined): void {
    const rc = resourceClass?.trim() || "state_resolution";
    const nid = novelId?.trim() || "_global";
    const key = `${nid}:${rc}`;
    this.gates.get(key)?.release();
  }

  /** 启动租约续期，返回停止函数。 */
  startLeaseRenewal(lease: RuntimeExecutionLease, slotId: string): () => void {
    const leaseOwner = `${this.workerId}:${slotId}`;
    const renew = () => {
      void this.renewRuntimeLease(lease.executionId, {
        workerId: this.workerId,
        slotId,
        leaseMs: this.leaseMs,
      }).catch((err) => {
        console.warn(`[task-queue] failed to renew runtime lease executionId=${lease.executionId}`, err);
      });
      if (lease.legacyCommandId) {
        void this.renewLegacyLease(lease.legacyCommandId, leaseOwner).catch((err) => {
          console.warn(`[task-queue] failed to renew legacy lease commandId=${lease.legacyCommandId}`, err);
        });
      }
    };
    renew();
    const timer = setInterval(renew, Math.max(100, Math.floor(this.leaseMs / 3)));
    return () => clearInterval(timer);
  }

  /** 标记任务执行开始（running 状态）。 */
  async markRunning(lease: RuntimeExecutionLease, slotId: string): Promise<void> {
    await this.markExecutionRunning(lease.executionId, {
      workerId: this.workerId,
      slotId,
      leaseMs: this.leaseMs,
    });
    if (lease.legacyCommandId) {
      await this.markLegacyCommandRunning(lease.legacyCommandId, `${this.workerId}:${slotId}`);
    }
  }

  /** 标记任务执行成功。 */
  async completeTask(lease: RuntimeExecutionLease, slotId: string): Promise<void> {
    const leaseOwner = `${this.workerId}:${slotId}`;
    if (lease.legacyCommandId) {
      await this.markLegacyCommandSucceeded(lease.legacyCommandId, leaseOwner);
    }
    await this.markExecutionSucceeded(lease.executionId);
    taskDispatcher.notify({ taskId: lease.taskId ?? undefined });
  }

  /** 标记任务被取消。 */
  async cancelTask(lease: RuntimeExecutionLease, slotId: string): Promise<void> {
    const leaseOwner = `${this.workerId}:${slotId}`;
    if (lease.legacyCommandId) {
      await this.markLegacyCommandCancelled(lease.legacyCommandId, leaseOwner);
    }
    await this.markExecutionCancelled(lease.executionId);
  }

  /** 标记任务执行失败。 */
  async failTask(lease: RuntimeExecutionLease, slotId: string, error: unknown): Promise<void> {
    const leaseOwner = `${this.workerId}:${slotId}`;
    if (lease.legacyCommandId) {
      await this.markLegacyCommandFailed(lease.legacyCommandId, leaseOwner, error).catch(() => null);
    }
    await this.markExecutionFailed(lease.executionId, error).catch(() => null);
  }

  /**
   * 等待下一个唤醒信号（新任务入队）或轮询超时。
   * 这是 event-driven + polling fallback 的核心。
   */
  async waitForWork(): Promise<void> {
    await taskDispatcher.waitForSignal(this.pollMs);
  }

  // ─── Runtime 系统操作 ───

  private async leaseFromRuntimeQueue(input: RuntimeLeaseInput): Promise<RuntimeExecutionLease | null> {
    return this.runtimeExecutionService.leaseNextExecution(input);
  }

  private async markExecutionRunning(executionId: string, input: {
    workerId: string; slotId: string; leaseMs: number;
  }): Promise<void> {
    await this.runtimeExecutionService.markExecutionRunning(executionId, input);
  }

  private async renewRuntimeLease(executionId: string, input: {
    workerId: string; slotId: string; leaseMs: number;
  }): Promise<void> {
    await this.runtimeExecutionService.renewExecutionLease(executionId, input);
  }

  private async markExecutionSucceeded(executionId: string): Promise<void> {
    await this.runtimeExecutionService.markExecutionSucceeded(executionId);
  }

  private async markExecutionCancelled(executionId: string): Promise<void> {
    await this.runtimeExecutionService.markExecutionCancelled(executionId);
  }

  private async markExecutionFailed(executionId: string, error: unknown): Promise<void> {
    await this.runtimeExecutionService.markExecutionFailed(executionId, error);
  }

  // ─── Legacy 系统操作 ───

  private async markLegacyCommandRunning(commandId: string, leaseOwner: string): Promise<void> {
    const now = new Date();
    await prisma.directorRunCommand.updateMany({
      where: { id: commandId, leaseOwner, status: { in: ["leased", "running"] } },
      data: { status: "running", startedAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) },
    });
  }

  private async renewLegacyLease(commandId: string, leaseOwner: string): Promise<void> {
    await prisma.directorRunCommand.updateMany({
      where: { id: commandId, leaseOwner, status: { in: ["leased", "running"] } },
      data: { leaseExpiresAt: new Date(Date.now() + this.leaseMs) },
    });
  }

  private async markLegacyCommandSucceeded(commandId: string, leaseOwner: string): Promise<void> {
    await prisma.directorRunCommand.updateMany({
      where: { id: commandId, leaseOwner, status: { in: ["leased", "running"] } },
      data: { status: "succeeded", leaseExpiresAt: null, finishedAt: new Date(), errorMessage: null },
    });
  }

  private async markLegacyCommandCancelled(commandId: string, leaseOwner: string): Promise<void> {
    const { DirectorCommandService } = await import(
      "../services/novel/director/DirectorCommandService"
    );
    const service = new DirectorCommandService();
    await service.markCommandCancelled(commandId, leaseOwner);
  }

  private async markLegacyCommandFailed(commandId: string, leaseOwner: string, error: unknown): Promise<void> {
    const { DirectorCommandService } = await import(
      "../services/novel/director/DirectorCommandService"
    );
    const service = new DirectorCommandService();
    await service.markCommandFailed(commandId, leaseOwner, error);
  }

  // ─── Stale 回收 ───

  private async maybeScanStale(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStaleScan < this.staleScanMs) return;
    this.lastStaleScan = now;
    await this.reconcileStale();
  }

  private async reconcileStale(): Promise<void> {
    const { DirectorWorkerReconciliationService } = await import(
      "../services/novel/director/DirectorWorkerReconciliationService"
    );
    const { DirectorCommandService } = await import(
      "../services/novel/director/DirectorCommandService"
    );
    const commandService = new DirectorCommandService();
    const reconciliation = new DirectorWorkerReconciliationService(commandService);

    const [result, staleCount] = await Promise.all([
      reconciliation.reconcile(),
      this.runtimeExecutionService.recoverStaleExecutions(new Date(), this.leaseMs),
    ]);

    const total = result.staleLeaseCount + result.closedStepCount
      + result.requeuedDanglingTaskCount + result.adoptedLegacyCommandCount
      + staleCount;
    if (total > 0) {
      console.warn(
        `[task-queue] reconciled staleLeases=${result.staleLeaseCount} staleExecs=${staleCount} closed=${result.closedStepCount} requeued=${result.requeuedDanglingTaskCount} adopted=${result.adoptedLegacyCommandCount}`,
      );
      taskDispatcher.notify();
    }
  }
}
