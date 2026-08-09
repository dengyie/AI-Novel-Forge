import { TASK_RETENTION_INTERVAL_MS } from "../../config/taskRetention";
import { TaskRetentionRunner } from "./retention/application/TaskRetentionRunner";
import type { TaskRetentionSummary } from "./retention/domain/retentionTypes";

export {
  selectDeletableTaskIds,
  selectSupersededGenerationJobIds,
  selectSupersededTaskIds,
} from "./retention/domain/retentionPolicy";
export type {
  GenerationJobSupersedeRow,
  SupersededCandidateRow,
  TaskRetentionRow,
} from "./retention/domain/retentionPolicy";
export type { TaskRetentionSummary } from "./retention/domain/retentionTypes";

/** Stable application facade. Owned retention modules remain internal. */
export class TaskRetentionService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly runner = new TaskRetentionRunner()) {}

  start(intervalMs = TASK_RETENTION_INTERVAL_MS): void {
    if (this.timer) return;
    void this.runOnce().catch((error) => {
      console.warn("[task.retention] initial cleanup failed:", error instanceof Error ? error.message : String(error));
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        console.warn("[task.retention] periodic cleanup failed:", error instanceof Error ? error.message : String(error));
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  runOnce(now = new Date()): Promise<TaskRetentionSummary> {
    return this.runner.runOnce(now);
  }
}

export const taskRetentionService = new TaskRetentionService();
