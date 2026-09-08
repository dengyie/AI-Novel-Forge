import { execFile, spawn } from "node:child_process";
import fs from "node:fs";

const MAX_NODE_TIMER_MS = 2_147_483_647;
const DEFAULT_M4B_STALL_TIMEOUT_MS = 5 * 60_000;

export function resolveM4bStallTimeoutMs(
  value = process.env.AUDIOBOOK_M4B_STALL_TIMEOUT_MS,
): number {
  const raw = Number(value ?? DEFAULT_M4B_STALL_TIMEOUT_MS);
  if (!Number.isSafeInteger(raw) || raw <= 0) return DEFAULT_M4B_STALL_TIMEOUT_MS;
  return Math.max(30_000, Math.min(MAX_NODE_TIMER_MS, raw));
}

const DEFAULT_STALL_TIMEOUT_MS = resolveM4bStallTimeoutMs();

const FFMPEG_NICE = (() => {
  const raw = Number(process.env.AUDIOBOOK_M4B_FFMPEG_NICE ?? 10);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.max(0, Math.min(19, Math.floor(raw)));
})();

const M4B_PROGRESS_INTERVAL_MS = (() => {
  const raw = Number(process.env.AUDIOBOOK_M4B_PROGRESS_INTERVAL_MS ?? 10_000);
  if (!Number.isSafeInteger(raw) || raw <= 0) return 10_000;
  return Math.max(5_000, Math.min(MAX_NODE_TIMER_MS, raw));
})();

/** SIGKILL 后等待 ChildProcess close 的上限，防止异常 fd 让许可永久不释放。 */
const FFMPEG_KILL_CLOSE_WAIT_MS = 2_000;

export interface M4bFfmpegProgress {
  partBytes: number;
  elapsedMs: number;
}

export type M4bProgressCallback = (progress: M4bFfmpegProgress) => void;

function resolveOutputPath(args: string[], explicitPartPath?: string | null): string | null {
  const explicit = explicitPartPath?.trim();
  if (explicit) return explicit;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg && arg !== "-" && !arg.startsWith("-")) return arg;
  }
  return null;
}

/**
 * 运行 ffmpeg，并以 `.part` 增长作为健康信号。POSIX 下创建独立进程组，确保 wrapper
 * 与其长寿命后代在取消/停滞时一并退出；Windows 保留直接 child kill。
 */
export function runFfmpegProcess(input: {
  ffmpeg: string;
  args: string[];
  stallTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: M4bProgressCallback | null;
  partPath?: string | null;
}): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("m4b 封装已取消。"));
      return;
    }
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(input.ffmpeg, input.args, {
      detached: useProcessGroup,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (FFMPEG_NICE != null && child.pid) {
      execFile("renice", [String(FFMPEG_NICE), "-p", String(child.pid)], { timeout: 2_000 }, (error) => {
        if (error) console.warn("[audiobook] m4b ffmpeg renice 失败", error.message);
      });
    }

    const partPath = resolveOutputPath(input.args, input.partPath);
    let stderr = "";
    let settled = false;
    let progressTimer: NodeJS.Timeout | null = null;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let killCloseTimer: NodeJS.Timeout | null = null;
    let pendingKillError: Error | null = null;
    const startedAt = Date.now();
    let lastObservedBytes = 0;
    let lastGrowthAt = startedAt;
    let lastProgressBytes = 0;
    const requestedStallMs = input.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const stallMs = Number.isSafeInteger(requestedStallMs) && requestedStallMs > 0
      ? Math.min(MAX_NODE_TIMER_MS, requestedStallMs)
      : DEFAULT_STALL_TIMEOUT_MS;

    const cleanup = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      input.signal?.removeEventListener("abort", onAbort);
      if (progressTimer) clearInterval(progressTimer);
      if (killCloseTimer) clearTimeout(killCloseTimer);
    };
    const finish = (status: number | null, errText: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ status, stderr: errText });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const killProcessTree = () => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
          console.warn(
            "[audiobook] m4b ffmpeg process-group kill failed; falling back to child kill",
            error instanceof Error ? error.message : error,
          );
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited / spawn failed
      }
    };
    const killAndFail = (message: string) => {
      if (settled || pendingKillError) return;
      pendingKillError = new Error(message);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (progressTimer) clearInterval(progressTimer);
      input.signal?.removeEventListener("abort", onAbort);
      killProcessTree();
      // 许可持有到 child close；异常 fd 时最多等待固定上限。
      killCloseTimer = setTimeout(() => fail(pendingKillError ?? new Error(message)), FFMPEG_KILL_CLOSE_WAIT_MS);
    };
    const onAbort = () => killAndFail("m4b 封装已取消。");

    const readPartBytes = (fallbackBytes: number): number => {
      try {
        if (partPath && fs.existsSync(partPath)) return fs.statSync(partPath).size;
      } catch {
        // observation is best-effort
      }
      return fallbackBytes;
    };

    const scheduleWatchdog = (delayMs = stallMs) => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        const now = Date.now();
        const nowBytes = readPartBytes(lastObservedBytes);
        if (nowBytes > lastObservedBytes) {
          lastObservedBytes = nowBytes;
          lastGrowthAt = now;
        }
        const remainingMs = stallMs - (now - lastGrowthAt);
        if (remainingMs > 0) {
          scheduleWatchdog(remainingMs);
        } else {
          killAndFail(`ffmpeg 封装 m4b 停滞（>${Math.round(stallMs / 1_000)}s 无产物产出）。`);
        }
      }, delayMs);
    };
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4_000) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      fail(pendingKillError ?? (error instanceof Error ? error : new Error(String(error))));
    });
    child.on("close", (code) => {
      if (pendingKillError) fail(pendingKillError);
      else finish(code, stderr.slice(0, 400));
    });

    scheduleWatchdog();

    if (typeof input.onProgress === "function" && partPath) {
      progressTimer = setInterval(() => {
        const partBytes = readPartBytes(lastProgressBytes);
        lastProgressBytes = partBytes;
        try {
          input.onProgress?.({ partBytes, elapsedMs: Date.now() - startedAt });
        } catch {
          // progress callbacks do not own encoder lifecycle
        }
      }, M4B_PROGRESS_INTERVAL_MS);
    }

    input.signal?.addEventListener("abort", onAbort, { once: true });
    // Abort may race the pre-spawn check and listener registration. Re-check
    // only after child error/close handlers exist so process-group cleanup and
    // permit release cannot be lost in that window.
    if (input.signal?.aborted) onAbort();
  });
}
