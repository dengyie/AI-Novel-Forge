/**
 * LLM transport 瞬时故障重试。
 *
 * structuredInvoke 与 text/stream prompt 路径共享同一套判据与退避：
 * 代理抖动 / 渠道切换 / 超时 / 连接重置 等可安全重试；
 * 持续性业务错误（schema、空正文策略错误等）不在此层处理。
 *
 * 显式用户/流水线取消不是瞬时故障：不得重试（与 job 层 isPipelineCancellationError 对齐）。
 * 墙钟 timeout 触发的泛化 AbortError("Request was aborted.") 不是取消：按 timeout 处理
 * （有 fallback 时 cascade、同模型限次），避免 thrash 或误掐 cascade。
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
  // 注意：不匹配裸 "aborted"——真取消走 isCancellationLike；timeout-driven abort 走 isTimeoutDriven
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
 * 显式用户/流水线取消文案（不含泛化 "Request was aborted."）。
 * 泛化 abort 常是墙钟 timeout abort 的 undici/fetch 表象，见 isTimeoutDrivenAbortError。
 */
function hasExplicitCancellationMessage(msg: string): boolean {
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
  return lower.includes("user cancelled")
    || lower.includes("cancelled mid-flight")
    || lower.includes("pipeline cancelled");
}

function isGenericAbortMessage(lower: string): boolean {
  return lower === "aborted"
    || lower === "request aborted."
    || lower === "request aborted"
    || lower === "request was aborted."
    || lower === "request was aborted"
    || lower === "the operation was aborted."
    || lower === "the operation was aborted"
    || lower.includes("request was aborted")
    || lower.includes("the operation was aborted")
    || lower.includes("request aborted");
}

/**
 * 墙钟 timeout 触发 AbortController.abort 后，SDK/undici 常把 workPromise
 * 以 AbortError("Request was aborted.") 抢先 reject；这不是用户取消。
 * 与 TimeoutError / "timed out" 同等对待：瞬时、可 cascade，但同模型少重试。
 */
export function isTimeoutDrivenAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
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
  if (hasExplicitCancellationMessage(msg)) {
    return false;
  }
  const lower = msg.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return true;
  }
  const isAbortName = error instanceof Error && error.name === "AbortError";
  // 无 name 的 Error("aborted") / "Request was aborted."：sleep/signal 透传也可能，
  // 但生产 thrash 主因是 AbortError + 泛化文案；无 name 的 "aborted" 仍偏取消
  // （pipeline sleep reject）。只把 AbortError + 泛化文案当 timeout-driven。
  return isAbortName && isGenericAbortMessage(lower);
}

/**
 * 取消 / abort 形态：transport 层不得当瞬时重试，也不得走 multi-hop fallback。
 * 权威实现：pipelineJobAutoRetry.isPipelineCancellationError 直接委托本函数
 * （novel→llm 单向依赖，无环）。
 *
 * 注意：泛化 AbortError("Request was aborted.") 在墙钟超时路径极常见，
 * 不得再当 cancellation（否则 cascade 被掐、错误表面成 Abort thrash）。
 * 这类走 isTimeoutLikeTransportError。
 */
export function isCancellationLikeTransportError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  // TimeoutError 永远不是取消
  if (error instanceof Error && error.name === "TimeoutError") {
    return false;
  }
  // 超时驱动的泛化 abort → 不是取消
  if (isTimeoutDrivenAbortError(error)) {
    return false;
  }
  const msg = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
  if (hasExplicitCancellationMessage(msg ?? "")) {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    // 空 message AbortError：保守当取消（调用方应用 signal.reason）
    if (!msg || !msg.trim()) {
      return true;
    }
    const lower = msg.toLowerCase();
    if (lower.includes("cancel") || lower.includes("取消")) {
      return true;
    }
    // 其它非 generic AbortError：保守当取消，避免误重试真取消
    return true;
  }
  // 无 AbortError name 的透传取消文案（sleep → Error("aborted")）
  if (!msg) {
    return false;
  }
  const lower = msg.toLowerCase();
  return lower === "aborted"
    || lower.includes("request aborted")
    || lower.includes("the operation was aborted");
}

/**
 * 墙钟/请求超时：同模型再重试往往只是再烧 600s，有 fallback 时应优先 cascade。
 * TimeoutError name、timed out / timeout 文案、以及 timeout 驱动的泛化 AbortError。
 */
export function isTimeoutLikeTransportError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (isCancellationLikeTransportError(error)) {
    return false;
  }
  if (isTimeoutDrivenAbortError(error)) {
    return true;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
  if (!message) {
    return false;
  }
  const lower = message.toLowerCase();
  return lower.includes("timed out") || lower.includes("timeout");
}

export function isTransientTransportError(error: unknown): boolean {
  if (isCancellationLikeTransportError(error)) {
    return false;
  }
  // 超时 / timeout-driven abort：瞬时（有 fallback 时 resolveStructuredTransportMaxAttempts 会限次）
  // TimeoutError 已含在 isTimeoutLikeTransportError 内，勿再单独分支。
  if (isTimeoutLikeTransportError(error)) {
    return true;
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
  return TRANSIENT_TRANSPORT_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * 同策略 transport 重试上限（含首次）。
 *
 * 墙钟 timeout（含 LLM_REQUEST_TIMEOUT_MS 到点）：再烧同模型一整轮几乎无收益。
 * - 有 fallback → 立刻 cascade（maxAttempts=1，不再同策略重试）
 * - 无 fallback（末跳 deepseek 等）→ 同样只 1 次，把失败交回业务层
 *   （有声 diarize 可 rules-fill；章节生成可上层重试/降级）
 *
 * 其它瞬时（ECONNRESET 等）：有 fallback 时最多 2 次；无 fallback 仍用完整预算。
 */
export function resolveStructuredTransportMaxAttempts(input: {
  fallbackAvailable: boolean;
  error?: unknown;
  defaultMaxAttempts?: number;
}): number {
  const full = Math.max(1, input.defaultMaxAttempts ?? (TRANSPORT_RETRY_MAX_ATTEMPTS + 1));
  if (input.error != null && isTimeoutLikeTransportError(input.error)) {
    // 首次已失败；不再同模型 timeout 重试 → 返回 1 使 attempt < maxAttempts 为 false
    return 1;
  }
  // 有 fallback 时：非 timeout 瞬时错误最多 2 次（首次+1），避免 5×600s 后才 cascade
  if (input.fallbackAvailable) {
    return Math.min(full, 2);
  }
  return full;
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
 * - 显式取消 / 非瞬时错误立即抛出
 * - timeout-driven abort 视为瞬时，但 resolveStructured… 会把同策略限为 1
 */
export async function runWithTransportRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: TransportRetryOptions = {},
): Promise<T> {
  const maxExtra = options.maxAttempts ?? TRANSPORT_RETRY_MAX_ATTEMPTS;
  let maxAttempts = Math.max(1, maxExtra + 1);
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
      // timeout 同模型不再烧整轮：把本轮上限收到 1，使 shouldRetry 为 false
      if (isTimeoutLikeTransportError(error)) {
        maxAttempts = resolveStructuredTransportMaxAttempts({
          fallbackAvailable: false,
          error,
          defaultMaxAttempts: maxAttempts,
        });
      }
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
