export interface TaskRetentionSummary {
  novelWorkflowDeleted: number;
  generationJobDeleted: number;
  archiveRowsDeleted: number;
  runtimeRowsDeleted: number;
  supersededDeleted: number;
  zombieRunningCancelled: number;
  nullNovelOrphansDeleted: number;
  nullNovelAgentRunsDeleted: number;
  autoArchived: number;
  orphanAgentRunsCancelled: number;
  staleRunningProjected: number;
  waitingApprovalFlagged: number;
  autoRetried: number;
  autoRetryBudgetSkipped: number;
}

export function createTaskRetentionSummary(): TaskRetentionSummary {
  return {
    novelWorkflowDeleted: 0,
    generationJobDeleted: 0,
    archiveRowsDeleted: 0,
    runtimeRowsDeleted: 0,
    supersededDeleted: 0,
    zombieRunningCancelled: 0,
    nullNovelOrphansDeleted: 0,
    nullNovelAgentRunsDeleted: 0,
    autoArchived: 0,
    orphanAgentRunsCancelled: 0,
    staleRunningProjected: 0,
    waitingApprovalFlagged: 0,
    autoRetried: 0,
    autoRetryBudgetSkipped: 0,
  };
}
