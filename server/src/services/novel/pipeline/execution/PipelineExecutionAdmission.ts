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
  private readonly waiters: Array<() => void> = [];

  private readonly limit: number;

  constructor(limit = resolvePipelineExecutionConcurrency()) {
    this.limit = resolvePipelineExecutionConcurrency(String(limit));
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    // release() transfers its existing permit directly to the oldest waiter;
    // active therefore remains unchanged while ownership moves between jobs.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

const pipelineExecutionAdmission = new PipelineExecutionAdmission();

export function withPipelineExecutionPermit<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return pipelineExecutionAdmission.run(operation);
}
