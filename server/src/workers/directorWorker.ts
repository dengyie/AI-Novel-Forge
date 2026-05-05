import "dotenv/config";
import { ensureRuntimeDatabaseReady } from "../db/runtimeMigrations";
import { loadProviderApiKeys } from "../llm/factory";
import { initializeRagSettingsCompatibility } from "../services/settings/RagCompatibilityBootstrapService";
import { DirectorExecutionService } from "../services/novel/director/directorSubsystem";
import { DirectorTaskQueue, type DirectorTaskQueueOptions } from "./DirectorTaskQueue";
import { taskDispatcher } from "./TaskDispatcher";

export interface DirectorWorkerDeps {
  queue: DirectorTaskQueue;
  executionService: { executeCommand: DirectorExecutionService["executeCommand"] };
}

/**
 * DirectorWorker v2 — 事件驱动 + 轮询兜底。
 *
 * 架构改进：
 * 1. 用 TaskDispatcher 事件总线替代纯 setTimeout 轮询——有新任务时立即唤醒。
 * 2. 用 DirectorTaskQueue 统一封装双队列（legacy + runtime）操作，
 *    worker 层不再直接操作 DirectorRunCommand / DirectorRuntimeCommand。
 * 3. 资源限流通过 ResourceGate 集中管理，slot 只负责消费循环。
 * 4. 轮询作为兜底保留（跨进程场景、crash recovery），间隔提高到 5 秒。
 */
export class DirectorWorker {
  private stopped = false;
  private readonly queue: DirectorTaskQueue;
  private readonly executionService: DirectorWorkerDeps["executionService"];

  constructor(options?: DirectorTaskQueueOptions);
  constructor(deps: DirectorWorkerDeps);
  constructor(arg?: DirectorTaskQueueOptions | DirectorWorkerDeps) {
    if (arg && "queue" in arg) {
      this.queue = arg.queue;
      this.executionService = arg.executionService;
    } else {
      this.queue = new DirectorTaskQueue(arg);
      this.executionService = new DirectorExecutionService();
    }
  }

  stop(): void {
    this.stopped = true;
    taskDispatcher.notify();
  }

  async start(): Promise<void> {
    console.log(
      `[director.worker] started workerId=${this.queue.workerId} slots=${this.queue.executionSlots} pollMs=${this.queue.pollMs} leaseMs=${this.queue.leaseMs}`,
    );

    const runners = Array.from({ length: this.queue.executionSlots }, (_, i) =>
      this.runSlot(`slot-${i + 1}`),
    );
    await Promise.all(runners);
  }

  private async runSlot(slotId: string): Promise<void> {
    while (!this.stopped) {
      try {
        const didWork = await this.tick(slotId);
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
    const leased = await this.queue.leaseNext(slotId);
    if (!leased) return false;

    const { lease, legacyCommand } = leased;
    const stopRenewal = this.queue.startLeaseRenewal(lease, slotId);

    try {
      await this.queue.acquireResourceGate(lease.novelId, lease.resourceClass);
      try {
        await this.queue.markRunning(lease, slotId);

        console.log(
          `[director.worker] executing commandId=${legacyCommand.id} type=${legacyCommand.commandType} taskId=${legacyCommand.taskId} novelId=${lease.novelId} slot=${slotId}`,
        );

        const outcome = await this.executionService.executeCommand(legacyCommand);

        if (outcome === "cancelled") {
          await this.queue.cancelTask(lease, slotId);
          console.log(`[director.worker] cancelled commandId=${legacyCommand.id}`);
        } else {
          await this.queue.completeTask(lease, slotId);
          console.log(`[director.worker] completed commandId=${legacyCommand.id}`);
        }
      } finally {
        this.queue.releaseResourceGate(lease.novelId, lease.resourceClass);
      }
    } catch (error) {
      console.error(`[director.worker] command failed commandId=${legacyCommand.id}`, error);
      await this.queue.failTask(lease, slotId, error);
    } finally {
      stopRenewal();
    }

    return true;
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
