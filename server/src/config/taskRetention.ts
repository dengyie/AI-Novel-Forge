function asInt(rawValue: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(rawValue ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const value = Math.floor(parsed);
  return Math.max(min, Math.min(max, value));
}

// 任务中心保留策略：每本小说保留最近 N 个终态任务，更早的按状态分别老化删除。
export const TASK_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const TASK_RETENTION_KEEP_PER_NOVEL = asInt(process.env.TASK_RETENTION_KEEP_PER_NOVEL, 20, 0, 1000);
export const TASK_RETENTION_SUCCEEDED_DAYS = asInt(process.env.TASK_RETENTION_SUCCEEDED_DAYS, 7, 1, 365);
export const TASK_RETENTION_FAILED_DAYS = asInt(process.env.TASK_RETENTION_FAILED_DAYS, 30, 1, 365);
// 被取代的终态任务（同 novel+lane 下已有活跃任务接管）在此最小存活时间后即可清理。
// 默认 0 = 立刻清；线上若想给"刚失败、待人工瞥一眼"留窗口，可放宽到如 600000(10min)。
export const TASK_RETENTION_SUPERSEDED_MIN_AGE_MS = asInt(
  process.env.TASK_RETENTION_SUPERSEDED_MIN_AGE_MS,
  0,
  0,
  24 * 60 * 60 * 1000,
);

export interface TaskRetentionConfig {
  keepPerNovel: number;
  succeededDays: number;
  failedDays: number;
  supersededMinAgeMs: number;
}

export const taskRetentionConfig: TaskRetentionConfig = {
  keepPerNovel: TASK_RETENTION_KEEP_PER_NOVEL,
  succeededDays: TASK_RETENTION_SUCCEEDED_DAYS,
  failedDays: TASK_RETENTION_FAILED_DAYS,
  supersededMinAgeMs: TASK_RETENTION_SUPERSEDED_MIN_AGE_MS,
};
