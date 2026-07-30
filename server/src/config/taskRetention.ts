function asInt(rawValue: string | undefined, fallback: number, min: number, max: number): number {
  // 空串/未设置都必须走 fallback：Number("" ?? x) 的旧写法里 Number("")===0 是有限数，
  // 会把未设置的 env 静默钳到 0（对 min<=0 的新配置是真实 bug：autoArchive 窗口曾全变 0）。
  const raw = rawValue?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
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
// null-novel 活跃任务（建书中或删书 SetNull 残留）在心跳/更新停滞超过该小时数后强制取消并硬删。
// 默认 24h：给合法 create-before-bind 留窗口，同时清掉删书后永远 waiting_approval 的幽灵。
export const TASK_RETENTION_NULL_NOVEL_STALE_HOURS = asInt(
  process.env.TASK_RETENTION_NULL_NOVEL_STALE_HOURS,
  24,
  1,
  24 * 30,
);
// 自动归档（autopilot P1）：终态任务在列表里可见一小段窗口后自动写入 TaskCenterArchive，
// 从默认列表/overview 消失（数据保留，可在归档视图找回）。0 = 关闭该状态的自动归档。
// 与老化硬删正交：归档只影响可见性，succeededDays/failedDays 才管数据生命周期。
export const TASK_AUTO_ARCHIVE_SUCCEEDED_HOURS = asInt(
  process.env.TASK_AUTO_ARCHIVE_SUCCEEDED_HOURS,
  24,
  0,
  24 * 90,
);
export const TASK_AUTO_ARCHIVE_FAILED_DAYS = asInt(
  process.env.TASK_AUTO_ARCHIVE_FAILED_DAYS,
  7,
  0,
  365,
);
// 孤儿 AgentRun 自愈（autopilot P1b）：宿主已消失（novel/chapter 删除）或宿主章节
// 已到终态（completed/pending_review 等）而 run 仍 active 超过该小时数 → 自动 cancel。
// 与 ChapterGeneratingLockHygiene 互补：那个管「章节卡 generating」，这个管「章节早走完、
// run 漏 settle」——生产曾留下 3 条跨 14 天的 running 幽灵。
export const TASK_ORPHAN_AGENT_RUN_STALE_HOURS = asInt(
  process.env.TASK_ORPHAN_AGENT_RUN_STALE_HOURS,
  1,
  1,
  24 * 30,
);
// 状态投影自愈（autopilot P2）：活跃任务投影校正。
// - running 但无心跳超窗口（进程死了/executor 漏 settle）→ 投影为 failed + 可恢复标记，
//   不再让 UI 长期显示假 running。默认与 auto_director 僵尸判定同阈值（90min）。
// - waiting_approval 超窗口无人理 → 标 pendingManualRecovery，进 recovery candidates
//   （overview.recoveryCandidateCount 即 attention 信号，前端已有展示）。
export const TASK_STALE_RUNNING_PROJECTION_MS = asInt(
  process.env.TASK_STALE_RUNNING_PROJECTION_MS,
  90 * 60 * 1000,
  10 * 60 * 1000,
  24 * 60 * 60 * 1000,
);
export const TASK_WAITING_APPROVAL_ATTENTION_HOURS = asInt(
  process.env.TASK_WAITING_APPROVAL_ATTENTION_HOURS,
  72,
  1,
  24 * 90,
);

export interface TaskRetentionConfig {
  keepPerNovel: number;
  succeededDays: number;
  failedDays: number;
  supersededMinAgeMs: number;
  nullNovelStaleHours: number;
  autoArchiveSucceededHours: number;
  autoArchiveFailedDays: number;
  orphanAgentRunStaleHours: number;
  staleRunningProjectionMs: number;
  waitingApprovalAttentionHours: number;
}

export const taskRetentionConfig: TaskRetentionConfig = {
  keepPerNovel: TASK_RETENTION_KEEP_PER_NOVEL,
  succeededDays: TASK_RETENTION_SUCCEEDED_DAYS,
  failedDays: TASK_RETENTION_FAILED_DAYS,
  supersededMinAgeMs: TASK_RETENTION_SUPERSEDED_MIN_AGE_MS,
  nullNovelStaleHours: TASK_RETENTION_NULL_NOVEL_STALE_HOURS,
  autoArchiveSucceededHours: TASK_AUTO_ARCHIVE_SUCCEEDED_HOURS,
  autoArchiveFailedDays: TASK_AUTO_ARCHIVE_FAILED_DAYS,
  orphanAgentRunStaleHours: TASK_ORPHAN_AGENT_RUN_STALE_HOURS,
  staleRunningProjectionMs: TASK_STALE_RUNNING_PROJECTION_MS,
  waitingApprovalAttentionHours: TASK_WAITING_APPROVAL_ATTENTION_HOURS,
};
