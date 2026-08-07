import { parseSeedPayload } from "./novelWorkflow.shared";
import type { DirectorWorkflowSeedPayload } from "../director/runtime/novelDirectorHelpers";

const DEFAULT_STALE_RUNNING_TASK_MS = 90 * 60 * 1000;

export function resolveStaleRunningTaskMs(): number {
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

/**
 * 判定一个僵死(无心跳)的 auto_director running 任务是否应自动续跑，而不是
 * 标记失败/取消后等人手点「继续」。基于 seedPayload 里的 autoExecution 快照：
 * - 全书自动执行已启用且未到熔断 open；
 * - 未取消；autoRepair 未显式关闭（默认 true）；
 * - 仍有剩余章节（remainingChapterCount>0）。
 * 满足则服务重启后可以安全地自动 enqueueContinueCommand 续跑，防「静默停摆」。
 */
export function isAutoResumableStaleAutoDirectorTask(
  row: {
    seedPayloadJson?: string | null;
    cancelRequestedAt?: Date | null;
  },
): boolean {
  if (row.cancelRequestedAt) {
    return false;
  }
  const seedPayload = parseSeedPayload<DirectorWorkflowSeedPayload>(row.seedPayloadJson);
  const autoExecution = seedPayload?.autoExecution;
  if (!autoExecution || autoExecution.enabled !== true) {
    return false;
  }
  if (autoExecution.autoRepair === false) {
    return false;
  }
  if (autoExecution.circuitBreaker?.status === "open") {
    return false;
  }
  if ((autoExecution.remainingChapterCount ?? 0) === 0) {
    return false;
  }
  return true;
}

export const STALE_AUTO_DIRECTOR_RUNNING_MESSAGE = "自动导演任务长时间没有心跳，可能已因服务重启或内存不足中断。请检查后继续或重试。";
