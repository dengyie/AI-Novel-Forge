const DEFAULT_PIPELINE_EXECUTION_CONCURRENCY = 1;
const MAX_PIPELINE_EXECUTION_CONCURRENCY = 4;

/**
 * Pipeline jobs assemble chapter context and can invoke generation/review/repair
 * chains concurrently. Host-level global OOM pressure is not visible through
 * container memory counters, so high-memory execution is serial by default and
 * any expansion is an explicit, bounded operational decision.
 */
export function resolvePipelineExecutionConcurrency(
  value = process.env.PIPELINE_EXECUTION_CONCURRENCY,
): number {
  const parsed = Number(value ?? DEFAULT_PIPELINE_EXECUTION_CONCURRENCY);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return DEFAULT_PIPELINE_EXECUTION_CONCURRENCY;
  }
  return Math.min(MAX_PIPELINE_EXECUTION_CONCURRENCY, parsed);
}

export class PipelineExecutionAdmission {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
    state: "queued" | "granted" | "acquired" | "cancelled";
  }> = [];

  private readonly limit: number;

  constructor(limit = resolvePipelineExecutionConcurrency()) {
    this.limit = resolvePipelineExecutionConcurrency(String(limit));
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private abortError(): Error {
    const error = new Error("pipeline execution admission aborted");
    error.name = "AbortError";
    return error;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw this.abortError();
    }
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    const granted = await new Promise<(typeof this.waiters)[number]>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        resolve: () => resolve(waiter),
        reject,
        signal,
        state: "queued",
      };
      const onAbort = () => {
        if (waiter.state !== "queued") return;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.state = "cancelled";
        signal?.removeEventListener("abort", onAbort);
        reject(this.abortError());
      };
      waiter.onAbort = onAbort;
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    signal?.removeEventListener("abort", granted.onAbort as EventListener);
    if (signal?.aborted || granted.state !== "granted") {
      if (granted.state === "granted") {
        granted.state = "cancelled";
        this.release();
      }
      throw this.abortError();
    }
    granted.state = "acquired";
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (!next) return;
      if (next.state !== "queued") continue;
      if (next.signal?.aborted) {
        next.state = "cancelled";
        next.signal.removeEventListener("abort", next.onAbort as EventListener);
        next.reject(this.abortError());
        continue;
      }
      next.state = "granted";
      next.signal?.removeEventListener("abort", next.onAbort as EventListener);
      this.active += 1;
      next.resolve();
      return;
    }
  }
}

const pipelineExecutionAdmission = new PipelineExecutionAdmission();

export function withPipelineExecutionPermit<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return pipelineExecutionAdmission.run(operation, signal);
}
