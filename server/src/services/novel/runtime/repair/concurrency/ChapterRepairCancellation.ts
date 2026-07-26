export function assertRepairAbortSignal(step: string, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(`repair aborted (signal) at ${step}`);
  }
}
