import { AsyncLocalStorage } from "node:async_hooks";

export interface DirectorExecutionContext {
  signal?: AbortSignal;
  waitForCompletion?: boolean;
}

const storage = new AsyncLocalStorage<DirectorExecutionContext>();

export function getDirectorExecutionContext(): DirectorExecutionContext | undefined {
  return storage.getStore();
}

export function runWithDirectorExecutionContext<T>(
  context: DirectorExecutionContext,
  runner: () => Promise<T>,
): Promise<T> {
  return storage.run(context, runner);
}

export function throwIfDirectorExecutionAborted(
  signal = getDirectorExecutionContext()?.signal,
): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("自动导演命令已取消。");
}
