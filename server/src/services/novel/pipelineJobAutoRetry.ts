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
 * 用户/流水线取消（不可 auto-requeue，应落 cancelled 而非 failed）。
 * 与章节层 cancel 文案、abort(reason=PIPELINE_CANCELLED) 对齐。
 * AbortError + abort 类文案：reason 丢失时的取消透传形态，按取消处理。
 */
export function isPipelineCancellationError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const msg = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
  if (!msg) {
    return false;
  }
  if (
    msg === "PIPELINE_CANCELLED"
    || msg.includes("PIPELINE_CANCELLED")
    || msg.includes("章节生成已取消")
    || msg.includes("任务仍在取消")
  ) {
    return true;
  }
  // reason 丢失后的取消透传：AbortError + abort 类文案 → 按取消收口
  if (error instanceof Error && error.name === "AbortError") {
    const lower = msg.toLowerCase();
    return lower.includes("abort") || lower.includes("cancel") || lower.includes("取消");
  }
  return false;
}

/**
 * 是否值得在 job 层自动 requeue（而非终态 failed）。
 * - 瞬时 transport（超时/连接/502 等）
 * - 空正文（章节内 empty 重试已耗尽时，常为渠道空回）
 * - 取消 / AbortError / 业务错误 → false
 *
 * 注意：isTransientTransportError 会把 AbortError/"aborted" 当瞬时；
 * job 层必须先排除取消与 AbortError，避免取消被 requeue。
 */
export function isPipelineJobAutoRetryableError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (isPipelineCancellationError(error)) {
    return false;
  }
  // AbortError 可能是取消透传丢失 reason 后的形态；job 层宁可不 requeue
  if (error instanceof Error && error.name === "AbortError") {
    return false;
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
