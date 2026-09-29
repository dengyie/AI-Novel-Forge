import type { EventEmitter } from "node:events";

/** Every HTTP attempt is bounded by the remaining startup deadline. */
export async function waitForServerHealth(
  port: number,
  timeoutMs = 45_000,
  hasExited?: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `http://127.0.0.1:${port}/api/health/ready`;
  while (Date.now() < deadline) {
    if (hasExited?.()) throw new Error(`Desktop server exited before becoming healthy at ${healthUrl}.`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(1000, Math.max(1, deadline - Date.now())));
    const exitCheck = hasExited ? setInterval(() => { if (hasExited()) controller.abort(); }, 50) : null;
    try {
      const response = await fetch(healthUrl, { signal: controller.signal });
      await response.body?.cancel();
      if (response.ok && !controller.signal.aborted && Date.now() <= deadline && !hasExited?.()) return;
    } catch {
      // Network errors retry within the shared deadline.
    } finally {
      clearTimeout(timer);
      if (exitCheck) clearInterval(exitCheck);
    }
    if (hasExited?.()) throw new Error(`Desktop server exited before becoming healthy at ${healthUrl}.`);
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
  throw new Error(`Timed out waiting for server health at ${healthUrl}.`);
}

/** Wait for actual exit, escalating only the process this handle owns. */
export function stopOwnedServerProcess(options: {
  events: EventEmitter;
  hasExited: () => boolean;
  terminate: () => void;
  forceKill: () => void;
  graceMs?: number;
  forceMs?: number;
}): Promise<void> {
  if (options.hasExited()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      options.events.off("exit", onExit);
      if (error) reject(error); else resolve();
    };
    const onExit = () => finish();
    options.events.once("exit", onExit);
    timer = setTimeout(() => {
      if (options.hasExited()) { finish(); return; }
      timer = setTimeout(() => finish(new Error("Desktop server did not exit after forced shutdown.")), options.forceMs ?? 5000);
      try { options.forceKill(); } catch (error) { finish(error); }
    }, options.graceMs ?? 25000);
    try { options.terminate(); } catch (error) { finish(error); }
  });
}

/** Electron does not await asynchronous before-quit listeners. */
export function createServerQuitHandler(
  stop: () => Promise<void>,
  quit: () => void,
  onError: (error: unknown) => void,
): (event: { preventDefault(): void }) => void {
  let ready = false;
  let stopping: Promise<void> | null = null;
  return (event) => {
    if (ready) return;
    event.preventDefault();
    if (stopping) return;
    stopping = Promise.resolve().then(stop).then(() => {
      ready = true;
      quit();
    }).catch((error) => {
      stopping = null;
      onError(error);
    });
  };
}
