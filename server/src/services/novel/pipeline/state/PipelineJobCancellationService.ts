import { PipelineJobStateRepository } from "./PipelineJobStateRepository";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
type PipelineJobState = NonNullable<
  Awaited<ReturnType<PipelineJobStateRepository["findById"]>>
>;

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
      return this.cancelCanonicalState(jobId, "queued", true);
    }

    return this.cancelCanonicalState(jobId, "running", true);
  }

  private async cancelCanonicalState(
    jobId: string,
    status: "queued" | "running",
    canRetry: boolean,
  ): Promise<PipelineJobState> {
    const mutation = status === "queued"
      ? await this.repository.cancelQueued(jobId, new Date())
      : await this.repository.requestRunningCancellation({
          jobId,
          requestedAt: new Date(),
        });

    const canonical = await this.repository.findById(jobId);
    if (!canonical) {
      throw new Error("任务不存在。");
    }
    if (mutation.count > 0) {
      if (canonical.status === "running" && canonical.cancelRequestedAt === null) {
        throw new Error("任务状态已变化，请重试取消。");
      }
      return canonical;
    }
    if (TERMINAL_STATUSES.has(canonical.status)) {
      return canonical;
    }
    if (canRetry && (canonical.status === "queued" || canonical.status === "running")) {
      return this.cancelCanonicalState(jobId, canonical.status, false);
    }
    if (canonical.status === "running" && canonical.cancelRequestedAt === null) {
      throw new Error("任务状态已变化，请重试取消。");
    }
    if (canonical.status === "queued") {
      throw new Error("任务状态已变化，请重试取消。");
    }
    return canonical;
  }
}
