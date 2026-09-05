import { createM4bAbortError } from "./M4bAbortError";

/**
 * 进程级 m4b 并发上限。每本书的 taskDir 锁只能防止同书重复编码；没有这一层时，
 * 多本书会同时读取整部 WAV 并各自启动 ffmpeg，宿主的 CPU、内存和磁盘吞吐会被打满。
 * 默认串行，运维可通过合法的正整数 AUDIOBOOK_M4B_CONCURRENCY 调整。
 */
const MAX_M4B_GLOBAL_CONCURRENCY = 4;

export function resolveM4bGlobalConcurrency(
  value = process.env.AUDIOBOOK_M4B_CONCURRENCY,
): number {
  const raw = Number(value ?? 1);
  if (!Number.isSafeInteger(raw) || raw < 1) return 1;
  return Math.min(MAX_M4B_GLOBAL_CONCURRENCY, raw);
}

const M4B_GLOBAL_CONCURRENCY = resolveM4bGlobalConcurrency();

const active = { count: 0 };
type WaiterState = "queued" | "granted" | "acquired" | "cancelled";
type Waiter = {
  resolve: (waiter: Waiter) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  state: WaiterState;
};
const waiters: Waiter[] = [];

export function getM4bGlobalConcurrency(): number {
  return M4B_GLOBAL_CONCURRENCY;
}

function wakeWaiters(): void {
  while (active.count < M4B_GLOBAL_CONCURRENCY && waiters.length > 0) {
    const next = waiters.shift();
    if (!next || next.state !== "queued") continue;
    if (next.signal?.aborted) {
      next.state = "cancelled";
      next.signal.removeEventListener("abort", next.onAbort as EventListener);
      next.reject(createM4bAbortError());
      continue;
    }
    // 先预留许可再 resolve；否则新调用者能在 promise continuation 恢复前插队超发。
    next.state = "granted";
    active.count += 1;
    next.resolve(next);
  }
}

function releasePermit(): void {
  active.count = Math.max(0, active.count - 1);
  wakeWaiters();
}

async function acquirePermit(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw createM4bAbortError();

  const granted = await new Promise<Waiter>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, signal, state: "queued" };
    const onAbort = () => {
      if (waiter.state === "queued") {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
      } else if (waiter.state === "granted") {
        // 许可已为该 waiter 预留但 continuation 尚未恢复：归还并继续交接。
        waiter.state = "cancelled";
        signal?.removeEventListener("abort", onAbort);
        releasePermit();
        reject(createM4bAbortError());
        return;
      } else {
        return;
      }
      waiter.state = "cancelled";
      signal?.removeEventListener("abort", onAbort);
      reject(createM4bAbortError());
    };
    waiter.onAbort = onAbort;
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    waiters.push(waiter);
    wakeWaiters();
  });

  // 监听器保留到 continuation 真正接管预留许可；remove 即 ownership acknowledgement。
  signal?.removeEventListener("abort", granted.onAbort as EventListener);
  if (signal?.aborted || granted.state !== "granted") {
    if (granted.state === "granted") {
      granted.state = "cancelled";
      releasePermit();
    }
    throw createM4bAbortError();
  }
  granted.state = "acquired";
}

export async function withGlobalM4bPermit<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await acquirePermit(signal);
  try {
    return await operation();
  } finally {
    releasePermit();
  }
}
