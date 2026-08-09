/**
 * Process-local concurrency gate for non-writer chapter LLM work
 * (artifact_delta extract, optional timeline helpers).
 *
 * Writer draft/extend must never share this slot — those paths call LLM
 * directly. Cap keeps multi-chapter background backlog from starving the
 * next chapter write on small hosts (e.g. 2c pxed).
 */

const DEFAULT_MAX_IN_FLIGHT = 1;
/** Max time waiting for a free slot before failing the background call. */
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  label: string;
  timer: NodeJS.Timeout | null;
  signal?: AbortSignal;
  abortListener?: () => void;
};

let maxInFlight = resolveMaxInFlight();
let inFlight = 0;
const waiters: Waiter[] = [];

function resolveMaxInFlight(): number {
  const raw = Number(process.env.BACKGROUND_CHAPTER_LLM_MAX_IN_FLIGHT);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 8) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_IN_FLIGHT;
}

function resolveWaitTimeoutMs(): number {
  const raw = Number(process.env.BACKGROUND_CHAPTER_LLM_WAIT_TIMEOUT_MS);
  // Allow short values for tests; production default remains 10m.
  if (Number.isFinite(raw) && raw >= 50 && raw <= 60 * 60 * 1000) {
    return Math.floor(raw);
  }
  return DEFAULT_WAIT_TIMEOUT_MS;
}

export function getBackgroundChapterLlmStats(): { inFlight: number; maxInFlight: number; waiting: number } {
  return { inFlight, maxInFlight, waiting: waiters.length };
}

/** Test / hot-reload helper. */
export function setBackgroundChapterLlmMaxInFlight(next: number): void {
  if (Number.isFinite(next) && next >= 1 && next <= 8) {
    maxInFlight = Math.floor(next);
  }
}

export async function withBackgroundChapterLlmSlot<T>(
  label: string,
  runner: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await acquireSlot(label, signal);
  try {
    throwIfBackgroundChapterLlmAborted(signal, label);
    return await runner();
  } finally {
    releaseSlot();
  }
}

function throwIfBackgroundChapterLlmAborted(signal: AbortSignal | undefined, label: string): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(`background LLM slot cancelled (${label})`);
}

function cleanupWaiter(waiter: Waiter): void {
  if (waiter.timer) {
    clearTimeout(waiter.timer);
    waiter.timer = null;
  }
  if (waiter.signal && waiter.abortListener) {
    waiter.signal.removeEventListener("abort", waiter.abortListener);
    waiter.abortListener = undefined;
  }
}

function acquireSlot(label: string, signal?: AbortSignal): Promise<void> {
  throwIfBackgroundChapterLlmAborted(signal, label);
  if (inFlight < maxInFlight) {
    inFlight += 1;
    return Promise.resolve();
  }
  const waitTimeoutMs = resolveWaitTimeoutMs();
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      label,
      timer: null,
      signal,
      resolve: () => {
        cleanupWaiter(waiter);
        inFlight += 1;
        resolve();
      },
      reject: (error) => {
        cleanupWaiter(waiter);
        reject(error);
      },
    };
    if (signal) {
      waiter.abortListener = () => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) {
          waiters.splice(idx, 1);
        }
        try {
          throwIfBackgroundChapterLlmAborted(signal, label);
        } catch (error) {
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      signal.addEventListener("abort", waiter.abortListener, { once: true });
    }
    waiter.timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) {
        waiters.splice(idx, 1);
      }
      console.warn("[background-llm-gate] wait timeout", {
        label,
        waitTimeoutMs,
        inFlight,
        maxInFlight,
        waiting: waiters.length,
      });
      waiter.reject(new Error(
        `background LLM slot wait timeout after ${waitTimeoutMs}ms (${label})`,
      ));
    }, waitTimeoutMs);
    waiter.timer.unref?.();
    waiters.push(waiter);
    if (signal?.aborted) {
      waiter.abortListener?.();
      return;
    }
    if (waiters.length === 1 || waiters.length % 5 === 0) {
      console.info("[background-llm-gate] waiting for slot", {
        label,
        inFlight,
        maxInFlight,
        waiting: waiters.length,
        waitTimeoutMs,
      });
    }
  });
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) {
    next.resolve();
  }
}
