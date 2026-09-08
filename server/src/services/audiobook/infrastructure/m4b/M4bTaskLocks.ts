import { createM4bAbortError } from "./M4bAbortError";

type LockWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type LockState = {
  inFlight: Set<string>;
  waiters: Map<string, LockWaiter[]>;
};

const encodeLock: LockState = {
  inFlight: new Set<string>(),
  waiters: new Map<string, LockWaiter[]>(),
};

const artifactLock: LockState = {
  inFlight: new Set<string>(),
  waiters: new Map<string, LockWaiter[]>(),
};

function wakeNextWaiter(lock: LockState, taskDir: string): void {
  const waiters = lock.waiters.get(taskDir);
  while (waiters && waiters.length > 0) {
    const next = waiters.shift();
    if (!next) break;
    if (waiters.length === 0) lock.waiters.delete(taskDir);
    if (next.signal?.aborted) {
      next.signal.removeEventListener("abort", next.onAbort as EventListener);
      next.reject(createM4bAbortError());
      continue;
    }
    next.signal?.removeEventListener("abort", next.onAbort as EventListener);
    next.resolve();
    return;
  }
  if (waiters?.length === 0) lock.waiters.delete(taskDir);
}
async function withTaskDirLock<T>(
  lock: LockState,
  taskDir: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    // 唤醒后的 microtask 窗口也可能被取消；锁若已空闲则继续传给下一 waiter。
    if (!lock.inFlight.has(taskDir)) wakeNextWaiter(lock, taskDir);
    throw createM4bAbortError();
  }
  if (!lock.inFlight.has(taskDir)) {
    lock.inFlight.add(taskDir);
    try {
      return await operation();
    } finally {
      lock.inFlight.delete(taskDir);
      wakeNextWaiter(lock, taskDir);
    }
  }

  // 被唤醒后重新竞争锁，避免第三个 waiter 在第二个执行期间并发进入。
  await new Promise<void>((resolve, reject) => {
    const list = lock.waiters.get(taskDir) ?? [];
    const waiter: LockWaiter = { resolve, reject, signal };
    const onAbort = () => {
      const current = lock.waiters.get(taskDir);
      const index = current?.indexOf(waiter) ?? -1;
      if (current && index >= 0) {
        current.splice(index, 1);
        if (current.length === 0) lock.waiters.delete(taskDir);
      }
      signal?.removeEventListener("abort", onAbort);
      reject(createM4bAbortError());
    };
    waiter.onAbort = onAbort;
    list.push(waiter);
    lock.waiters.set(taskDir, list);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return withTaskDirLock(lock, taskDir, operation, signal);
}

/** 同一 taskDir 的完整编码互斥；不同 taskDir 仍受全局 permit 控制。 */
export function withM4bEncodeLock<T>(
  taskDir: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withTaskDirLock(encodeLock, taskDir, operation, signal);
}

/** 将产物发布与代际轮换/破坏性清理串行，避免旧 worker 在 wipe 后 rename 回规范名。 */
export function withAudiobookTaskDirArtifactLock<T>(
  taskDir: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  return withTaskDirLock(artifactLock, taskDir, async () => operation());
}
