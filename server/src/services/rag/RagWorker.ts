import { ragConfig } from "../../config/rag";
import { RagIndexService, RagJobCancelledError } from "./RagIndexService";
import { RagJobCleanupService } from "./RagJobCleanupService";

function backoffMs(attempt: number): number {
  const factor = Math.min(Math.max(attempt, 1), 6);
  return ragConfig.workerRetryBaseMs * (2 ** (factor - 1));
}

export class RagWorker {
  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;
  private startupPromise: Promise<void> | null = null;
  private currentTickPromise: Promise<void> | null = null;
  private stopRequested = false;
  private readonly cleanupService: RagJobCleanupService;

  constructor(
    private readonly ragIndexService: RagIndexService,
    cleanupService?: RagJobCleanupService,
  ) {
    this.cleanupService = cleanupService ?? new RagJobCleanupService();
  }

  private logInfo(message: string, meta?: Record<string, unknown>): void {
    if (!ragConfig.verboseLog) {
      return;
    }
    if (meta) {
      console.info(`[RAG][Worker] ${message}`, meta);
      return;
    }
    console.info(`[RAG][Worker] ${message}`);
  }

  private logWarn(message: string, meta?: Record<string, unknown>): void {
    if (!ragConfig.verboseLog) {
      return;
    }
    if (meta) {
      console.warn(`[RAG][Worker] ${message}`, meta);
      return;
    }
    console.warn(`[RAG][Worker] ${message}`);
  }

  start(): void {
    if (this.timer || this.startupPromise) {
      return;
    }
    // When RAG_ENABLED=false the worker never ticks, so cancelStaleActiveJobs
    // will not run automatically — use POST /api/rag/jobs/cancel-stale or SQL.
    if (!ragConfig.enabled) {
      console.info(
        "[RAG][Worker] skipped start (RAG_ENABLED=false); stale job cancel will not auto-run.",
      );
      return;
    }
    this.logInfo("Worker started.", {
      pollMs: ragConfig.workerPollMs,
      maxAttempts: ragConfig.workerMaxAttempts,
      retryBaseMs: ragConfig.workerRetryBaseMs,
    });
    this.stopRequested = false;
    const startup = (async (): Promise<void> => {
      try {
        await this.requeueInterruptedJobs();
      } catch (error) {
        // Startup recovery must not become an unhandled rejection or prevent
        // the worker from serving fresh queued work.
        console.error("[RAG][Worker] interrupted job recovery failed.", error);
      }
      if (this.stopRequested) {
        return;
      }
      this.timer = setInterval(() => {
        this.scheduleTick();
      }, ragConfig.workerPollMs);
      this.scheduleTick();
    })();
    this.startupPromise = startup;
    void startup.finally(() => {
      if (this.startupPromise === startup) {
        this.startupPromise = null;
      }
    });
  }

  private async requeueInterruptedJobs(): Promise<void> {
    while (true) {
      const runningJobs = await this.ragIndexService.listJobs(500, "running");
      if (runningJobs.length === 0) {
        return;
      }
      this.logWarn("Requeue interrupted running jobs after restart.", {
        count: runningJobs.length,
      });
      await Promise.all(
        runningJobs.map((job) =>
          this.ragIndexService.updateJobStatus(job.id, {
            status: "queued",
            runAfter: new Date(),
            lastError: job.lastError ?? "RAG worker restarted; interrupted job requeued.",
          })
        ),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const startup = this.startupPromise;
    if (startup) {
      await startup;
    }
    const currentTick = this.currentTickPromise;
    if (currentTick) {
      await currentTick;
    }
    this.logInfo("Worker stopped.");
  }

  /** True while startup recovery or a job tick is still mutating job state. */
  isBusy(): boolean {
    return Boolean(this.startupPromise || this.currentTickPromise || this.isTicking);
  }

  private scheduleTick(): void {
    if (this.stopRequested || this.currentTickPromise) {
      return;
    }
    const tickPromise = this.tick();
    this.currentTickPromise = tickPromise;
    void tickPromise
      .catch((error) => {
        console.error("[RAG][Worker] tick failed.", error);
      })
      .finally(() => {
        if (this.currentTickPromise === tickPromise) {
          this.currentTickPromise = null;
        }
      });
  }

  private async tick(): Promise<void> {
    if (this.isTicking) {
      return;
    }
    this.isTicking = true;
    try {
      // Drain multi-day zombies before picking so FIFO head cannot pin forever.
      try {
        await this.cleanupService.cancelStaleActiveJobs({ limit: 500 });
      } catch {
        // best-effort; worker continues
      }

      const job = await this.ragIndexService.getNextRunnableJob();
      if (!job) {
        return;
      }

      const nextAttempt = job.attempts + 1;
      const startedAt = Date.now();
      // Always log pick (not only verbose) so silent backlog is diagnosable.
      console.info("[RAG][Worker] Job picked.", {
        jobId: job.id,
        jobType: job.jobType,
        ownerType: job.ownerType,
        ownerId: job.ownerId,
        tenantId: job.tenantId,
        attempt: nextAttempt,
        maxAttempts: job.maxAttempts,
      });
      await this.ragIndexService.updateJobStatus(job.id, {
        status: "running",
        attempts: nextAttempt,
        lastError: null,
      });

      try {
        const result = await this.ragIndexService.processJob(job);
        await this.ragIndexService.updateJobStatus(job.id, {
          status: "succeeded",
          lastError: null,
        });
        this.logInfo("Job succeeded.", {
          jobId: job.id,
          chunks: result.chunks,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        if (error instanceof RagJobCancelledError) {
          this.logInfo("Job cancelled.", {
            jobId: job.id,
            elapsedMs: Date.now() - startedAt,
          });
          return;
        }
        const message = error instanceof Error ? error.message : "RAG 索引任务失败。";
        if (nextAttempt >= job.maxAttempts) {
          await this.ragIndexService.updateJobStatus(job.id, {
            status: "failed",
            attempts: nextAttempt,
            lastError: message,
          });
          // Permanent fail always visible (verboseLog may be off).
          console.warn("[RAG][Worker] Job failed permanently.", {
            jobId: job.id,
            attempt: nextAttempt,
            maxAttempts: job.maxAttempts,
            elapsedMs: Date.now() - startedAt,
            error: message,
          });
          return;
        }
        const delayMs = backoffMs(nextAttempt);
        await this.ragIndexService.updateJobStatus(job.id, {
          status: "queued",
          attempts: nextAttempt,
          runAfter: new Date(Date.now() + delayMs),
          lastError: message,
        });
        console.warn("[RAG][Worker] Job failed and requeued.", {
          jobId: job.id,
          attempt: nextAttempt,
          nextRetryInMs: delayMs,
          elapsedMs: Date.now() - startedAt,
          error: message,
        });
      }
    } finally {
      this.isTicking = false;
    }
  }
}
