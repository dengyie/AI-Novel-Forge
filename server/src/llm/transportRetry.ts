/**
 * LLM transport 瞬时故障重试。
 *
 * structuredInvoke 与 text/stream prompt 路径共享同一套判据与退避：
 * 代理抖动 / 渠道切换 / 超时 / 连接重置 等可安全重试；
 * 持续性业务错误（schema、空正文策略错误等）不在此层处理。
 *
 * 取消 / AbortError 不是瞬时故障：不得重试（与 job 层 isPipelineCancellationError 对齐）。
 * 调用方仍应在 signal 已 abort 时停止重试（用户取消 / 流水线取消）。
 */

export const TRANSPORT_RETRY_MAX_ATTEMPTS = Math.max(
  0,
  Number.parseInt(process.env.LLM_TRANSPORT_RETRY_MAX_ATTEMPTS ?? "4", 10) || 0,
);

export const TRANSPORT_RETRY_BACKOFF_BASE_MS = Math.max(
  0,
  Number.parseInt(process.env.LLM_TRANSPORT_RETRY_BACKOFF_BASE_MS ?? "1500", 10) || 0,
);

const TRANSIENT_TRANSPORT_ERROR_PATTERNS = [
  "timed out",
  "timeout",
  // 注意：不匹配 "aborted"——AbortError / 取消透传不得当瞬时重试（见 isCancellationLikeTransportError）
  "econnreset",
  "econnrefused",
  "enetunreach",
  "esockettimedout",
  "socket hang",
  "fetch failed",
  "network error",
  "upstream service",
  "502",
  "503",
  "504",
  "429",
  "reading 'message'",
  "reading 'content'",
  "cannot read properties of undefined",
  "bad gateway",
  "service unavailable",
];

/**
 * 取消 / abort 形态：transport 层不得当瞬时重试。
 * 与 pipelineJobAutoRetry.isPipelineCancellationError 口径对齐（不必 import 以免 llm↔novel 环依赖）。
 */
export function isCancellationLikeTransportError(error: unknown): boolean {
  if (!error) {
    return false;
  }
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
  const lower = msg.toLowerCase();
  // TimeoutError 另走瞬时
  if (error instanceof Error && error.name === "TimeoutError") {
    return false;
  }
  return lower === "aborted"
    || lower.includes("request aborted")
    || lower.includes("the operation was aborted")
    || lower.includes("user cancelled")
    || lower.includes("cancelled mid-flight");
}

export function isTransientTransportError(error: unknown): boolean {
  if (isCancellationLikeTransportError(error)) {
    return false;
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error ?? "");
  if (!message) {
    return false;
  }
  const lower = message.toLowerCase();
  // TimeoutError 仍瞬时；AbortError 已在 isCancellationLikeTransportError 排除
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  return TRANSIENT_TRANSPORT_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

export interface TransportRetryOptions {
  /** 额外重试次数（不含首次）。默认 LLM_TRANSPORT_RETRY_MAX_ATTEMPTS。 */
  maxAttempts?: number;
  backoffBaseMs?: number;
  signal?: AbortSignal;
  label?: string;
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    error: unknown;
    backoffMs: number;
  }) => void;
}

/**
 * 对瞬时 transport 错误做有限重试。
 * - 首次 + maxAttempts 次重试（默认共 5 次）
 * - signal 已 abort 时不重试（用户/流水线取消）
 * - AbortError / 取消文案 / 非瞬时错误立即抛出
 */
export async function runWithTransportRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: TransportRetryOptions = {},
): Promise<T> {
  const maxExtra = options.maxAttempts ?? TRANSPORT_RETRY_MAX_ATTEMPTS;
  const maxAttempts = Math.max(1, maxExtra + 1);
  const backoffBaseMs = options.backoffBaseMs ?? TRANSPORT_RETRY_BACKOFF_BASE_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("aborted");
    }
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      const shouldRetry = isTransientTransportError(error)
        && attempt < maxAttempts
        && !options.signal?.aborted;
      if (!shouldRetry) {
        throw error;
      }
      const backoffMs = backoffBaseMs * attempt;
      options.onRetry?.({
        attempt,
        maxAttempts,
        error,
        backoffMs,
      });
      await sleep(backoffMs, options.signal);
    }
  }

  throw lastError;
}
