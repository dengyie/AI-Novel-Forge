import type { DirectorWorkflowSeedPayload } from "../../director/runtime/novelDirectorHelpers";
import { parseSeedPayload } from "../novelWorkflow.shared";

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
  const heartbeatAt = row.heartbeatAt ?? null;
  const updatedAt = row.updatedAt ?? null;
  if (!heartbeatAt) return updatedAt;
  if (!updatedAt) return heartbeatAt;
  return heartbeatAt.getTime() >= updatedAt.getTime() ? heartbeatAt : updatedAt;
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
  return !lastActivityAt
    || now.getTime() - lastActivityAt.getTime() >= resolveStaleRunningTaskMs();
}

/** 周期扫描使用宽判定，覆盖章节执行、审校和修复等非结构化大纲阶段。 */
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
  return !lastActivityAt
    || now.getTime() - lastActivityAt.getTime() >= resolveStaleRunningTaskMs();
}

/** 自动续跑护栏：自动执行开启、允许修复、熔断未开且仍有剩余章节。 */
export function isAutoResumableStaleAutoDirectorTask(row: {
  seedPayloadJson?: string | null;
  cancelRequestedAt?: Date | null;
}): boolean {
  if (row.cancelRequestedAt) {
    return false;
  }
  const seedPayload = parseSeedPayload<DirectorWorkflowSeedPayload>(row.seedPayloadJson);
  const autoExecution = seedPayload?.autoExecution;
  return Boolean(
    autoExecution
    && autoExecution.enabled === true
    && autoExecution.autoRepair !== false
    && autoExecution.circuitBreaker?.status !== "open"
    && (autoExecution.remainingChapterCount ?? 0) > 0,
  );
}

export const STALE_AUTO_DIRECTOR_RUNNING_MESSAGE = "自动导演任务长时间没有心跳，可能已因服务重启或内存不足中断。请检查后继续或重试。";
