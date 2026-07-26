import { PipelineJobStateRepository } from "./PipelineJobStateRepository";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export class PipelineJobCancellationService {
  constructor(
    private readonly repository = new PipelineJobStateRepository(),
  ) {}

  async cancel(jobId: string, abortLiveExecution?: () => void) {
    const job = await this.repository.findById(jobId);
    if (!job) {
      throw new Error("任务不存在。");
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      throw new Error("仅排队中或运行中的任务可取消。");
    }

    abortLiveExecution?.();

    if (job.status === "queued") {
      const cancelledAt = new Date();
      const cancelled = await this.repository.cancelQueued(jobId, cancelledAt);
      if (cancelled.count > 0) {
        return this.repository.findById(jobId);
      }

      const latest = await this.repository.findById(jobId);
      if (!latest) {
        throw new Error("任务不存在。");
      }
      if (TERMINAL_STATUSES.has(latest.status)) {
        return latest;
      }
      if (latest.status !== "running") {
        return latest;
      }
      return this.requestRunningCancellation(jobId, latest.leaseOwner ?? null);
    }

    return this.requestRunningCancellation(jobId, job.leaseOwner ?? null);
  }

  private async requestRunningCancellation(jobId: string, leaseOwner: string | null) {
    await this.repository.requestRunningCancellation({
      jobId,
      leaseOwner,
      requestedAt: new Date(),
    });

    const canonical = await this.repository.findById(jobId);
    if (!canonical) {
      throw new Error("任务不存在。");
    }
    return canonical;
  }
}
