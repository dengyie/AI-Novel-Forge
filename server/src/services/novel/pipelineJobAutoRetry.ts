import { isChapterEmptyContentError } from "./runtime/chapterEmptyContentError";
import { isTransientTransportError } from "../../llm/transportRetry";

/**
 * Job 层瞬时 auto-requeue 与跨进程 resume 契约（P1-2）：
 *
 * 1. requeue 写库：status=queued、payload.jobTransportAutoRetryCount=next、
 *    error=formatPipelineJobAutoRetryMessage、清 lease/heartbeat。
 * 2. 进程内：setTimeout(delay) → schedulePipelineExecution（须 defer，否则
 *    activeJobIds 仍占用会跳过，卡在 queued）。
 * 3. 进程在 delay 内被杀：timer 丢失，但 DB 仍为 queued + count；
 *    启动 resumePendingPipelineJobs / watchdog listStaleRecoverable 必拾起
 *    （where：queued|running ∧ ¬pendingManualRecovery ∧ finishedAt null ∧
 *    cancelRequestedAt null；stale 另加心跳/租约过期）。
 * 4. resumePipelineJob：保留 payload（含 count），清 lease 后 schedule；
 *    executePipeline 从 payload 读回 count，预算连续。
 * 5. 任务中心 notice 与日志统一字段：jobTransportAutoRetryCount /
 *    noticeCode=PIPELINE_JOB_TRANSPORT_AUTO_RETRY；勿另造 DB 列叙事。
 * 6. 不依赖「到期可调度」新字段：queued 本身即可被 resume/stale 拾起。
 */

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

/** 日志/notice 共用 reason 码：进程内 timer 再调度 */
export const PIPELINE_JOB_AUTO_RETRY_RECOVERY_IN_PROCESS_TIMER = "in_process_timer";
/** 日志/notice 共用 reason 码：启动 resume 或 stale watchdog 拾起 */
export const PIPELINE_JOB_AUTO_RETRY_RECOVERY_RESUME_OR_STALE = "resume_or_stale";

/**
 * auto-requeue 后的 queued job 是否应被 resume/stale 路径拾起。
 * 与 listRecoverablePipelineJobs / buildStaleRecoverablePipelineJobWhere 语义对齐：
 * 只要非 manual、未终态、未取消，queued（含 count>0）一律可恢复；count 不参与 where。
 */
export function isAutoRequeuedPipelineJobRecoverable(input: {
  status: string;
  pendingManualRecovery?: boolean | null;
  finishedAt?: Date | string | null;
  cancelRequestedAt?: Date | string | null;
  jobTransportAutoRetryCount?: number | null;
}): boolean {
  if (input.status !== "queued" && input.status !== "running") {
    return false;
  }
  if (input.pendingManualRecovery) {
    return false;
  }
  if (input.finishedAt != null) {
    return false;
  }
  if (input.cancelRequestedAt != null) {
    return false;
  }
  return true;
}

/** 归一化 payload 中的 job 级瞬时重试已用次数（日志/notice 同源）。 */
export function normalizeJobTransportAutoRetryCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  return 0;
}

/**
 * 用户/流水线取消（不可 auto-requeue，应落 cancelled 而非 failed）。
 * 与章节层 cancel 文案、abort(reason=PIPELINE_CANCELLED) 对齐；
 * 与 transport `isCancellationLikeTransportError` 口径对齐（避免 llm↔novel 环依赖故双份）。
 *
 * - 任意 AbortError → 取消（含空 message / 无 abort 关键词）
 * - sleep/signal 透传的普通 Error("aborted") 等文案 → 取消
 * - PIPELINE_CANCELLED / 章节生成已取消 等 → 取消
 */
export function isPipelineCancellationError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  // 与 transport 一致：AbortError 一律非瞬时、job 层一律 cancelled
  if (error instanceof Error && error.name === "AbortError") {
    return true;
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
  // TimeoutError 另走瞬时失败，不在此匹配
  if (error instanceof Error && error.name === "TimeoutError") {
    return false;
  }
  const lower = msg.toLowerCase();
  // reason 丢失后的取消透传（含 sleep abort → new Error("aborted")）；与 transport 文案表对齐
  return lower === "aborted"
    || lower.includes("request aborted")
    || lower.includes("the operation was aborted")
    || lower.includes("user cancelled")
    || lower.includes("cancelled mid-flight");
}

/**
 * 是否值得在 job 层自动 requeue（而非终态 failed）。
 * - 瞬时 transport（超时/连接/502 等）
 * - 空正文（章节内 empty 重试已耗尽时，常为渠道空回）
 * - 取消 / AbortError / 业务错误 → false
 *
 * transport 层 isTransientTransportError 已排除 AbortError/取消文案；
 * job 层仍先硬挡 isPipelineCancellationError，双层保险。
 */
export function isPipelineJobAutoRetryableError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (isPipelineCancellationError(error)) {
    return false;
  }
  // 双保险：即使 transport 分类漂移，AbortError 也不 requeue
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
