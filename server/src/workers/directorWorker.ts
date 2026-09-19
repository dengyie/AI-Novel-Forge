import "dotenv/config";
import { ensureRuntimeDatabaseReady } from "../db/runtimeMigrations";
import { loadProviderApiKeys } from "../llm/factory";
import { initializeRagSettingsCompatibility } from "../services/settings/RagCompatibilityBootstrapService";
import { qualityDebtSettingsService } from "../services/settings/QualityDebtSettingsService";
import { DirectorCommandExecutor } from "../services/novel/director/commands/DirectorCommandExecutor";
import {
  isDirectorCommandLeaseLost,
  throwIfDirectorCommandLeaseLost,
} from "../services/novel/director/commands/DirectorCommandLeaseGuard";
import { DirectorTaskQueue, type DirectorTaskQueueOptions } from "./DirectorTaskQueue";
import { taskDispatcher } from "./TaskDispatcher";

// DirectorWorker 由 app.ts 经 DirectorWorkerManager 按需 fork 到独立子进程运行
// （pxed 防 OOM Phase 3：director import 树 +96MB heap 移出主进程）。
// 此文件同时保留独立进程入口（`require.main === module`）。

/** 子进程空闲（无 queued 命令）退出宽限；由 IPC kick 复位。环境变量 0 关闭。 */
const IDLE_EXIT_GRACE_MS = Number(process.env.DIRECTOR_WORKER_IDLE_EXIT_MS ?? 5 * 60_000);

export interface DirectorWorkerDeps {
  queue: DirectorTaskQueue;
  commandExecutor: { execute: DirectorCommandExecutor["execute"] };
}

/**
 * Single-track director worker.
 *
 * The worker leases `directorRunCommand` rows, renews leases while work is in
 * flight, and delegates execution to `DirectorCommandExecutor`. Resource
 * throttling stays local to the worker, while `TaskDispatcher` handles wakeups
 * and polling remains only as a stale-recovery fallback.
 */
export class DirectorWorker {
  private stopped = false;
  private readonly queue: DirectorTaskQueue;
  private readonly commandExecutor: DirectorWorkerDeps["commandExecutor"];
  /** In-flight tick promises so stop() can wait for a bounded drain without aborting LLM mid-chapter. */
  private readonly inflight = new Set<Promise<unknown>>();
  private runnersDone: Promise<void> | null = null;

  constructor(options?: DirectorTaskQueueOptions);
  constructor(deps: DirectorWorkerDeps);
  constructor(arg?: DirectorTaskQueueOptions | DirectorWorkerDeps) {
    if (arg && "queue" in arg) {
      this.queue = arg.queue;
      this.commandExecutor = arg.commandExecutor;
    } else {
      this.queue = new DirectorTaskQueue(arg);
      this.commandExecutor = new DirectorCommandExecutor();
    }
  }

  /**
   * Cooperative stop: no new leases; wake waiters; optionally wait for in-flight ticks.
   * Does not abort LLM mid-call (would risk partial chapter writes). Shutdown force-exit
   * remains the hard bound in app.ts SHUTDOWN_TIMEOUT_MS.
   */
  stop(): void {
    this.stopped = true;
    this.queue.stopStaleLeaseScanner();
    taskDispatcher.notify();
  }

  /** Wait until slot loops exit or timeout. Used by app graceful shutdown. */
  async waitForStop(timeoutMs = 15_000): Promise<"drained" | "timeout"> {
    this.stop();
    if (!this.runnersDone && this.inflight.size === 0) {
      return "drained";
    }
    const drain = Promise.all([
      this.runnersDone ?? Promise.resolve(),
      ...this.inflight,
    ]).then(() => "drained" as const);
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs)).unref?.();
    });
    return Promise.race([drain, timeout]);
  }

  async start(): Promise<void> {
    console.log(
      `[director.worker] started workerId=${this.queue.workerId} slots=${this.queue.executionSlots} pollMs=${this.queue.pollMs} leaseMs=${this.queue.leaseMs}`,
    );

    // stale lease 后台扫描：与 lease 热路径解耦
    this.queue.startStaleLeaseScanner();

    const runners = Array.from({ length: this.queue.executionSlots }, (_, i) =>
      this.runSlot(`slot-${i + 1}`),
    );
    this.runnersDone = Promise.all(runners).then(() => undefined);
    try {
      await this.runnersDone;
    } finally {
      this.queue.stopStaleLeaseScanner();
    }
  }

  private async runSlot(slotId: string): Promise<void> {
    while (!this.stopped) {
      try {
        const tickPromise = this.tick(slotId);
        this.inflight.add(tickPromise);
        let didWork = false;
        try {
          didWork = await tickPromise;
        } finally {
          this.inflight.delete(tickPromise);
        }
        if (!didWork) {
          await this.queue.waitForWork();
        }
      } catch (error) {
        console.error(`[director.worker] slot error slotId=${slotId}`, error);
        await this.queue.waitForWork();
      }
    }
  }

  async tick(slotId: string): Promise<boolean> {
    if (this.stopped) return false;

    const leased = await this.queue.leaseNext(slotId);
    if (!leased) return false;
    // If stop raced after lease, still finish this command (lease already held) so state is consistent.
    const { command } = leased;
    const renewal = this.queue.startLeaseRenewal(command.id, slotId);

    try {
      await this.queue.acquireResourceGate(command.novelId, command.commandType, renewal.signal);
      try {
        throwIfDirectorCommandLeaseLost(renewal.signal, {
          commandId: command.id,
          leaseOwner: `${this.queue.workerId}:${slotId}`,
        });
        const stillOwnsLease = await this.queue.markRunning(command.id, slotId);
        if (!stillOwnsLease) {
          console.warn(
            `[director.worker] lease lost before execution commandId=${command.id} taskId=${command.taskId} slot=${slotId}`,
          );
          return true;
        }
        throwIfDirectorCommandLeaseLost(renewal.signal, {
          commandId: command.id,
          leaseOwner: `${this.queue.workerId}:${slotId}`,
        });

        console.log(
          `[director.worker] executing commandId=${command.id} type=${command.commandType} taskId=${command.taskId} novelId=${command.novelId} slot=${slotId}`,
        );

        const outcome = await this.commandExecutor.execute(command.id, {
          signal: renewal.signal,
          leaseOwner: `${this.queue.workerId}:${slotId}`,
          leaseAttempt: command.attempt,
          leaseMs: this.queue.leaseMs,
        });
        throwIfDirectorCommandLeaseLost(renewal.signal, {
          commandId: command.id,
          leaseOwner: `${this.queue.workerId}:${slotId}`,
        });

        if (outcome === "cancelled") {
          const cancelled = await this.queue.cancelTask(command.id, slotId);
          if (!cancelled) {
            renewal.markLost();
            console.warn(`[director.worker] lease lost before cancel finalization commandId=${command.id}`);
          } else {
            console.log(`[director.worker] cancelled commandId=${command.id}`);
          }
        } else {
          const completed = await this.queue.completeTask(command.id, slotId);
          if (!completed) {
            renewal.markLost();
            console.warn(`[director.worker] lease lost before success finalization commandId=${command.id}`);
          } else {
            console.log(`[director.worker] completed commandId=${command.id}`);
          }
        }
      } finally {
        this.queue.releaseResourceGate(command.novelId, command.commandType);
      }
    } catch (error) {
      if (isDirectorCommandLeaseLost(error, renewal.signal)) {
        console.warn(
          `[director.worker] lease lost during execution commandId=${command.id} taskId=${command.taskId} slot=${slotId}`,
        );
      } else {
        console.error(`[director.worker] command failed commandId=${command.id}`, error);
        await this.queue.failTask(command.id, slotId, error);
      }
    } finally {
      renewal.stop();
    }

    return true;
  }
}

async function bootstrap(): Promise<void> {
  await ensureRuntimeDatabaseReady();
  await initializeRagSettingsCompatibility().catch((error) => {
    console.warn("[director.worker] failed to initialize RAG compatibility settings.", error);
  });
  await qualityDebtSettingsService.warnIfAutoPromotionEnabled().catch((error) => {
    console.warn("[director.worker] failed to inspect pending review auto-promotion settings.", error);
  });
  await loadProviderApiKeys().catch((error) => {
    console.warn("[director.worker] failed to load provider API keys from database.", error);
  });

  const worker = new DirectorWorker();
  process.once("SIGINT", () => worker.stop());
  process.once("SIGTERM", () => worker.stop());

  // 子进程模式（被 DirectorWorkerManager fork）：空闲宽限退出 + kick 复位。
  const childProcessMode = typeof process.send === "function";
  let idleTimer: NodeJS.Timeout | null = null;
  let idleMessageHandler: ((message: unknown) => void) | null = null;
  if (childProcessMode && IDLE_EXIT_GRACE_MS > 0) {
    idleTimer = setTimeout(() => {
      console.log(`[director.worker] idle ${IDLE_EXIT_GRACE_MS}ms; exiting to release memory.`);
      worker.stop();
    }, IDLE_EXIT_GRACE_MS);
    idleTimer.unref();
    const resetIdle = (): void => {
      if (!idleTimer) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log(`[director.worker] idle ${IDLE_EXIT_GRACE_MS}ms; exiting to release memory.`);
        worker.stop();
      }, IDLE_EXIT_GRACE_MS);
      idleTimer.unref();
    };
    idleMessageHandler = (message: unknown) => {
      if (typeof message === "object" && message !== null && (message as { type?: string }).type === "kick") {
        resetIdle();
        taskDispatcher.notify();
      }
    };
    process.on("message", idleMessageHandler);
  }

  try {
    await worker.start();
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleMessageHandler) {
      process.off("message", idleMessageHandler);
      idleMessageHandler = null;
    }
  }

  // `process.on("message")` keeps the parent IPC channel referenced after the
  // worker loop drains. Disconnect before exiting so an idle child actually
  // releases its heap instead of waiting for the manager to SIGKILL it.
  if (childProcessMode) {
    process.disconnect?.();
    process.exit(0);
  }
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    console.error("[director.worker] bootstrap failed", error);
    process.exit(1);
  });
}
