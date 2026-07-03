function createTimeoutError(timeoutMs: number, label?: string): Error {
  const error = new Error(
    label?.trim()
      ? `[${label}] Request timed out after ${timeoutMs}ms.`
      : `Request timed out after ${timeoutMs}ms.`,
  );
  error.name = "TimeoutError";
  return error;
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const message = typeof reason === "string" && reason.trim()
    ? reason.trim()
    : "Request aborted.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

// 硬性墙钟超时兜底：调用方不显式传 timeoutMs 时（planner/章节生成核心路径都不传），
// runWithEnforcedTimeout 仍必须启用 AbortController + Promise.race 超时。仅靠 LLM 客户端
// （ChatOpenAI/Anthropic）的 HTTP timeout 不够——CPA 某渠道可能已返回响应头但 body 流
// 静默 hang，SDK 的 timeout 管不到流式 body，导致 invoke promise 永久挂死（无 reject=
// Phase 4 重试够不着=director 循环卡死=假 running）。这里的墙钟超时不依赖 SDK/fetch
// 语义，到点无条件 abort + reject（"timed out" 命中 isTransientTransportError）→ 重试接管。
const DEFAULT_ENFORCED_TIMEOUT_MS = (() => {
  const raw = process.env.LLM_REQUEST_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 30_000 && parsed <= 900_000) {
    return Math.floor(parsed);
  }
  return 300_000;
})();

export async function runWithEnforcedTimeout<T>(input: {
  label?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  run: (signal?: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? Math.floor(input.timeoutMs)
    : DEFAULT_ENFORCED_TIMEOUT_MS;

  if (!timeoutMs && !input.signal) {
    return input.run(undefined);
  }

  const controller = new AbortController();
  const upstreamSignal = input.signal;
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  let removeAbortListener: (() => void) | null = null;

  const raceCandidates: Array<Promise<T>> = [];
  const workPromise = input.run(controller.signal);
  raceCandidates.push(workPromise);

  if (timeoutMs) {
    raceCandidates.push(new Promise<T>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort(createTimeoutError(timeoutMs, input.label));
        reject(createTimeoutError(timeoutMs, input.label));
      }, timeoutMs);
    }));
  }

  if (upstreamSignal) {
    raceCandidates.push(new Promise<T>((_resolve, reject) => {
      const onAbort = () => {
        controller.abort(upstreamSignal.reason);
        reject(createAbortError(upstreamSignal.reason));
      };

      if (upstreamSignal.aborted) {
        onAbort();
        return;
      }

      upstreamSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        upstreamSignal.removeEventListener("abort", onAbort);
      };
    }));
  }

  try {
    return await Promise.race(raceCandidates);
  } catch (error) {
    if (timedOut) {
      throw createTimeoutError(timeoutMs ?? 0, input.label);
    }
    if (upstreamSignal?.aborted) {
      throw createAbortError(upstreamSignal.reason);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    const cleanupAbortListener = removeAbortListener as (() => void) | null;
    if (cleanupAbortListener) {
      cleanupAbortListener();
    }
  }
}
