import { isChapterEmptyContentError } from "./runtime/chapterEmptyContentError";
import { isTransientTransportError } from "../../llm/transportRetry";

/** 任务级瞬时失败自动 requeue 上限（不含首次执行）。默认 2。 */
export const PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX = Math.max(
  0,
  Number.parseInt(process.env.PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX ?? "2", 10) || 0,
);

/** requeue 前短退避（毫秒），给代理/渠道切换窗口。 */
export const PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.PIPELINE_JOB_TRANSPORT_AUTO_RETRY_DELAY_MS ?? "3000", 10) || 0,
);

/**
 * 是否值得在 job 层自动 requeue（而非终态 failed）。
 * - 瞬时 transport（超时/连接/502 等）
 * - 空正文（章节内 empty 重试已耗尽时，常为渠道空回）
 * - 取消 / 业务错误 → false
 */
export function isPipelineJobAutoRetryableError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (
      msg === "PIPELINE_CANCELLED"
      || msg.includes("章节生成已取消")
      || msg.includes("任务仍在取消")
    ) {
      return false;
    }
  }
  if (isChapterEmptyContentError(error)) {
    return true;
  }
  return isTransientTransportError(error);
}

export function resolveJobTransportAutoRetryBudget(
  maxOverride?: number | null,
): number {
  if (typeof maxOverride === "number" && Number.isFinite(maxOverride)) {
    return Math.max(0, Math.floor(maxOverride));
  }
  return PIPELINE_JOB_TRANSPORT_AUTO_RETRY_MAX;
}

export function shouldAutoRetryPipelineJob(input: {
  error: unknown;
  usedCount: number;
  maxCount?: number | null;
}): boolean {
  if (!isPipelineJobAutoRetryableError(input.error)) {
    return false;
  }
  const budget = resolveJobTransportAutoRetryBudget(input.maxCount);
  const used = Math.max(0, Math.floor(input.usedCount));
  return used < budget;
}

export function formatPipelineJobAutoRetryMessage(input: {
  originalMessage: string;
  nextCount: number;
  maxCount: number;
}): string {
  return `瞬时失败自动重试 ${input.nextCount}/${input.maxCount}：${input.originalMessage}`;
}
