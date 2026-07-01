const DEFAULT_STALE_RUNNING_TASK_MS = 90 * 60 * 1000;

function resolveStaleRunningTaskMs(): number {
  const configured = Number(process.env.AUTO_DIRECTOR_STALE_RUNNING_TASK_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_STALE_RUNNING_TASK_MS;
}

function isStructuredOutlineItemKey(itemKey: string | null | undefined): boolean {
  return itemKey === "beat_sheet"
    || itemKey === "chapter_list"
    || itemKey === "chapter_sync"
    || itemKey === "chapter_detail_bundle";
}

function resolveLastActivityAt(row: {
  heartbeatAt?: Date | null;
  updatedAt?: Date | null;
}): Date | null {
  return row.heartbeatAt ?? row.updatedAt ?? null;
}

export function isStaleAutoDirectorRunningTask(
  row: {
    lane?: string | null;
    status?: string | null;
    currentItemKey?: string | null;
    pendingManualRecovery?: boolean | null;
    cancelRequestedAt?: Date | null;
    heartbeatAt?: Date | null;
    updatedAt?: Date | null;
  },
  now = new Date(),
): boolean {
  if (
    row.lane !== "auto_director"
    || row.status !== "running"
    || row.pendingManualRecovery
    || row.cancelRequestedAt
    || !isStructuredOutlineItemKey(row.currentItemKey)
  ) {
    return false;
  }
  const lastActivityAt = resolveLastActivityAt(row);
  if (!lastActivityAt) {
    return true;
  }
  return now.getTime() - lastActivityAt.getTime() >= resolveStaleRunningTaskMs();
}

/**
 * 宽判定版：与 isStaleAutoDirectorRunningTask 相同的护栏（auto_director lane、
 * running、无 pendingManualRecovery、无 cancelRequestedAt、heartbeat 超
 * STALE_RUNNING_TASK_MS），但**不限 currentItemKey**。
 *
 * 用于周期性僵尸清理（TaskRetentionService）：结构化大纲阶段之外（如全书
 * 章节执行/审校/修复阶段的 quality_repair）的僵尸也能被捕获。90min 阈值对
 * 单次 LLM 调用（通常数分钟）足够保守，不会误判正在跑长调用的健康任务。
 *
 * 单点按需触发的 healing 流程仍用窄判定的 isStaleAutoDirectorRunningTask，
 * 语义不变。
 */
export function isStaleAutoDirectorRunningTaskBroad(
  row: {
    lane?: string | null;
    status?: string | null;
    pendingManualRecovery?: boolean | null;
    cancelRequestedAt?: Date | null;
    heartbeatAt?: Date | null;
    updatedAt?: Date | null;
  },
  now = new Date(),
): boolean {
  if (
    row.lane !== "auto_director"
    || row.status !== "running"
    || row.pendingManualRecovery
    || row.cancelRequestedAt
  ) {
    return false;
  }
  const lastActivityAt = resolveLastActivityAt(row);
  if (!lastActivityAt) {
    return true;
  }
  return now.getTime() - lastActivityAt.getTime() >= resolveStaleRunningTaskMs();
}

export const STALE_AUTO_DIRECTOR_RUNNING_MESSAGE = "自动导演任务长时间没有心跳，可能已因服务重启或内存不足中断。请检查后继续或重试。";
