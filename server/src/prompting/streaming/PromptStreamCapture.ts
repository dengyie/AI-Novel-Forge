import type { BaseMessageChunk } from "@langchain/core/messages";
import { resolveEnforcedTimeoutMs } from "../../llm/invokeTimeout";
import { safeLiveCall } from "../../llm/live/llmLiveSession";
import type { LlmLiveSession } from "../../llm/live/LlmLiveBroker";
import {
  extractLlmTokenUsage,
  mergeStreamTokenUsage,
  type LlmTokenUsageSnapshot,
} from "../../llm/usageTracking";
import { toText } from "../../services/novel/novelP0Utils";

export interface PromptStreamCompletion {
  text: string;
  usage: LlmTokenUsageSnapshot | null;
}

export interface CapturedPromptStream {
  stream: AsyncIterable<BaseMessageChunk>;
  completion: Promise<PromptStreamCompletion>;
}

export interface CapturePromptStreamOptions {
  label?: string;
  /** 相对超时（毫秒）；若同时给 deadlineAt，以 deadlineAt 为准 */
  timeoutMs?: number;
  /** 绝对截止时间（Date.now() 毫秒），与建流阶段共享单墙钟预算 */
  deadlineAt?: number;
  signal?: AbortSignal;
  /** Live 旁路：不得影响生成主路径 */
  liveSession?: LlmLiveSession | null;
}

function createStreamTimeoutError(timeoutMs: number, label?: string): Error {
  const error = new Error(
    label?.trim()
      ? `[${label}] Request timed out after ${timeoutMs}ms.`
      : `Request timed out after ${timeoutMs}ms.`,
  );
  error.name = "TimeoutError";
  return error;
}

function createStreamAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error
    ? reason
    : Object.assign(
        new Error(typeof reason === "string" && reason.trim() ? reason.trim() : "Request aborted."),
        { name: "AbortError" },
      );
}

/**
 * 消费模型流并用单一 completion Promise 交付正文与 usage。
 * timeout/abort/iterator error 只 reject 这一份 Promise，避免某个派生 Promise
 * 没有 rejection owner 时触发进程级 unhandled rejection。
 */
export function capturePromptStream(
  rawStream: AsyncIterable<BaseMessageChunk>,
  options: CapturePromptStreamOptions = {},
): CapturedPromptStream {
  let resolveCompletion!: (value: PromptStreamCompletion) => void;
  let rejectCompletion!: (reason?: unknown) => void;
  const completion = new Promise<PromptStreamCompletion>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const budgetMs = resolveEnforcedTimeoutMs(options.timeoutMs);
  const deadlineAt = typeof options.deadlineAt === "number" && Number.isFinite(options.deadlineAt)
    ? Math.floor(options.deadlineAt)
    : Date.now() + budgetMs;
  let settled = false;
  let timedOut = false;

  const settleReject = (error: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    rejectCompletion(error);
  };
  const settleResolve = (value: PromptStreamCompletion): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolveCompletion(value);
  };
  const remainingMs = (): number => Math.max(0, deadlineAt - Date.now());
  const makeTimeoutError = (): Error => createStreamTimeoutError(budgetMs, options.label);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true;
    settleReject(makeTimeoutError());
  }, Math.max(1, remainingMs()));
  const clearStreamTimeout = (): void => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const upstreamSignal = options.signal;
  const onUpstreamAbort = (): void => {
    clearStreamTimeout();
    if (upstreamSignal) {
      settleReject(createStreamAbortError(upstreamSignal));
    }
  };
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      onUpstreamAbort();
    } else {
      upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }

  const stream = {
    async *[Symbol.asyncIterator]() {
      const chunks: string[] = [];
      let usage: LlmTokenUsageSnapshot | null = null;
      const iterator = rawStream[Symbol.asyncIterator]();
      try {
        if (timedOut || remainingMs() <= 0) {
          throw makeTimeoutError();
        }
        if (upstreamSignal?.aborted) {
          throw createStreamAbortError(upstreamSignal);
        }

        while (true) {
          const left = remainingMs();
          if (timedOut || left <= 0) {
            throw makeTimeoutError();
          }
          if (upstreamSignal?.aborted) {
            throw createStreamAbortError(upstreamSignal);
          }

          const nextResult = await new Promise<IteratorResult<BaseMessageChunk>>((resolve, reject) => {
            let completed = false;
            let timeoutRaceHandle: ReturnType<typeof setTimeout> | null = null;
            const cleanup = (): void => {
              if (timeoutRaceHandle) {
                clearTimeout(timeoutRaceHandle);
                timeoutRaceHandle = null;
              }
              upstreamSignal?.removeEventListener("abort", rejectForAbort);
            };
            const finishResolve = (value: IteratorResult<BaseMessageChunk>): void => {
              if (completed) return;
              completed = true;
              cleanup();
              resolve(value);
            };
            const finishReject = (error: unknown): void => {
              if (completed) return;
              completed = true;
              cleanup();
              reject(error);
            };
            const rejectForAbort = (): void => {
              if (upstreamSignal) {
                finishReject(createStreamAbortError(upstreamSignal));
              }
            };

            timeoutRaceHandle = setTimeout(() => {
              timedOut = true;
              finishReject(makeTimeoutError());
            }, left);
            upstreamSignal?.addEventListener("abort", rejectForAbort, { once: true });
            Promise.resolve(iterator.next()).then(
              finishResolve,
              finishReject,
            );
          });

          if (nextResult.done) {
            break;
          }
          const chunk = nextResult.value;
          const chunkText = toText(chunk.content);
          chunks.push(chunkText);
          usage = mergeStreamTokenUsage(usage, extractLlmTokenUsage(chunk));
          if (chunkText && options.liveSession) {
            safeLiveCall(() => options.liveSession!.delta(chunkText));
          }
          yield chunk;
        }

        clearStreamTimeout();
        settleResolve({ text: chunks.join(""), usage });
      } catch (error) {
        clearStreamTimeout();
        settleReject(error);
        throw error;
      } finally {
        if (upstreamSignal) {
          upstreamSignal.removeEventListener("abort", onUpstreamAbort);
        }
        try {
          await iterator.return?.();
        } catch {
          // 底层 provider cleanup 失败不能覆盖原始 stream 结果。
        }
      }
    },
  };

  return { stream, completion };
}
