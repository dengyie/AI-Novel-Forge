import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBetweenChapterGapMs } from "./audiobookGap";
import { resolveFullBookAudioPath, resolveFullBookM4bPath, cleanupStaleM4bParts } from "./audiobookPaths";
import { parseWavInfo } from "./audiobookWav";

export type AudiobookM4bStatus = "ready" | "skipped" | "failed";

export interface AudiobookM4bChapterInput {
  chapterId: string;
  chapterTitle: string;
  chapterOrder: number;
  wavPath: string;
}

export interface AudiobookM4bEncodeResult {
  status: AudiobookM4bStatus;
  path: string | null;
  /** 相对任务目录的逻辑名，写入 resultJson */
  relativePath: string | null;
  reason?: string | null;
  bytes?: number;
  chapterCount?: number;
}

const M4B_RELATIVE = "full-book.m4b";

/**
 * 编码超时语义（根因修复 2026-09-03）：从「绝对墙钟时长」改为「停滞看门狗」。
 *
 * 旧模型：超时 = 固定 `timeoutMs`，一遍到就 kill。生产实测（《神通者》2GB WAV、
 * 降权+限 2 线程）推进中的 ffmpeg 跑到 ~37min 逼近 40min 绝对超时被误杀，而它
 * 明明在稳定往 `.part` 写盘（每次都被掐断后不得不全量重编码）。
 *
 * 新模型：只要 `.part` 仍在增长就视为健康，永不因“慢”被 kill；仅当 `.part`
 * 连续停滞超过 `stallTimeoutMs`（默认 5 分钟）才判真忙/真挂，kill 并报错。
 * 既保证大书/降权场景能跑完，又不丢失“ffmpeg 卡死”的资源保护。
 */
/** 停滞看门窗口：`.part` 连续不变超过它即掐。默认 5 分钟，可用 AUDIOBOOK_M4B_STALL_TIMEOUT_MS 覆盖。 */
const DEFAULT_STALL_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.AUDIOBOOK_M4B_STALL_TIMEOUT_MS ?? 5 * 60_000) || 5 * 60_000,
);

/**
 * ffmpeg 编码线程上限。大书 m4b 是对整本 WAV 的实时重采样+AAC 重编码，默认全核
 * 会把小巧/共享宿主占满、加剧与其它进程的争抢；这里默认封顶 2 线程，可用
 * AUDIOBOOK_M4B_FFMPEG_THREADS 覆盖（0 = 不传 `-threads`，交给 ffmpeg 自定）。
 */
const FFMPEG_THREADS_CAP = ((): number | null => {
  const raw = Number(process.env.AUDIOBOOK_M4B_FFMPEG_THREADS ?? 2);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.max(1, Math.floor(raw));
})();

/**
 * 编码进程 nice 值（IPC 优先级增量，1~19 更低优先）。默认 +10，让 ffmpeg 在共享
 * 宿主上主动让渡 CPU 给其它业务，减少被当作资源大户而牵连 novel-server 的 OOM。
 * 可用 AUDIOBOOK_M4B_FFMPEG_NICE 覆盖（0 = 不额外 renice）。
 */
const FFMPEG_NICE = (() => {
  const raw = Number(process.env.AUDIOBOOK_M4B_FFMPEG_NICE ?? 10);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.max(0, Math.min(19, Math.floor(raw)));
})();

/**
 * 进程级 m4b 并发上限。每本书的 taskDir 锁只能防止同书重复编码；没有这一层时，
 * 多本书会同时读取整部 WAV 并各自启动 ffmpeg，宿主的 CPU、内存和磁盘吞吐会被打满。
 * 默认串行，运维可通过合法的正整数 AUDIOBOOK_M4B_CONCURRENCY 调整。
 */
const M4B_GLOBAL_CONCURRENCY = (() => {
  const raw = Number(process.env.AUDIOBOOK_M4B_CONCURRENCY ?? 1);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.max(1, Math.min(32, Math.floor(raw)));
})();

const M4B_GLOBAL_ACTIVE = { count: 0 };
const M4B_GLOBAL_WAITERS: Array<() => void> = [];

export function getM4bGlobalConcurrency(): number {
  return M4B_GLOBAL_CONCURRENCY;
}

async function withGlobalM4bPermit<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new Error("m4b 封装已取消。");
  }
  if (M4B_GLOBAL_ACTIVE.count >= M4B_GLOBAL_CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = M4B_GLOBAL_WAITERS.indexOf(waiter);
        if (index >= 0) M4B_GLOBAL_WAITERS.splice(index, 1);
        reject(new Error("m4b 封装已取消。"));
      };
      M4B_GLOBAL_WAITERS.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  if (signal?.aborted) {
    throw new Error("m4b 封装已取消。");
  }
  M4B_GLOBAL_ACTIVE.count += 1;
  try {
    return await fn();
  } finally {
    M4B_GLOBAL_ACTIVE.count = Math.max(0, M4B_GLOBAL_ACTIVE.count - 1);
    const next = M4B_GLOBAL_WAITERS.shift();
    next?.();
  }
}

/**
 * 同 taskDir 并发编码互斥：模块级在途表，避免 pause/restart/后台队列多个入口
 * 对同一本书同时 spawn 多个 ffmpeg（每个都会重读整部 WAV，成倍放大资源占用）。
 * 同一 taskDir 再次请求 encode 时，后到者等待前一轮跑完（并发真正串行化）。
 */
const IN_FLIGHT_M4B = new Set<string>();
type M4bLockWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};
const M4B_WAITERS = new Map<string, Array<M4bLockWaiter>>();

function m4bAbortError(): Error {
  const error = new Error("m4b 封装已取消。");
  error.name = "AbortError";
  return error;
}

function wakeNextM4bWaiter(taskDir: string): void {
  const waiters = M4B_WAITERS.get(taskDir);
  while (waiters && waiters.length > 0) {
    const next = waiters.shift();
    if (!next) break;
    if (waiters.length === 0) M4B_WAITERS.delete(taskDir);
    if (next.signal?.aborted) {
      next.signal.removeEventListener("abort", next.onAbort as EventListener);
      next.reject(m4bAbortError());
      continue;
    }
    next.signal?.removeEventListener("abort", next.onAbort as EventListener);
    next.resolve();
    return;
  }
  if (waiters?.length === 0) M4B_WAITERS.delete(taskDir);
}

async function withTaskDirLock<T>(
  taskDir: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    // A waiter can be aborted after its wake-up microtask was queued. The
    // lock is already free in that narrow window; pass it on rather than
    // strand every later waiter.
    if (!IN_FLIGHT_M4B.has(taskDir)) wakeNextM4bWaiter(taskDir);
    throw m4bAbortError();
  }
  if (!IN_FLIGHT_M4B.has(taskDir)) {
    IN_FLIGHT_M4B.add(taskDir);
    try {
      return await fn();
    } finally {
      IN_FLIGHT_M4B.delete(taskDir);
      wakeNextM4bWaiter(taskDir);
    }
  }
  // 后到者排队；被唤醒后递归重试获取锁（而不是直接执行 fn），否则第三个及以后的
  // 请求会在第二个请求执行期间看到 IN_FLIGHT 为空而并发进入，锁就失效了。
  await new Promise<void>((resolve, reject) => {
    const list = M4B_WAITERS.get(taskDir) ?? [];
    const waiter: M4bLockWaiter = { resolve, reject, signal };
    const onAbort = () => {
      const current = M4B_WAITERS.get(taskDir);
      const index = current?.indexOf(waiter) ?? -1;
      if (current && index >= 0) {
        current.splice(index, 1);
        if (current.length === 0) M4B_WAITERS.delete(taskDir);
      }
      signal?.removeEventListener("abort", onAbort);
      reject(m4bAbortError());
    };
    waiter.onAbort = onAbort;
    list.push(waiter);
    M4B_WAITERS.set(taskDir, list);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return withTaskDirLock(taskDir, fn, signal);
}

/**
 * Serialize filesystem publication with task-level generation rotation/wipe.
 * Callers use this around the DB token CAS and any destructive artifact cleanup
 * so a worker cannot pass its token check while a new generation removes files.
 */
export function withAudiobookTaskDirArtifactLock<T>(
  taskDir: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withTaskDirLock(taskDir, async () => fn());
}

export function resolveFfmpegBinary(): string | null {
  const dedicated = process.env.AUDIOBOOK_FFMPEG_PATH?.trim();
  if (dedicated) {
    return fs.existsSync(dedicated) ? dedicated : null;
  }
  const soft = process.env.FFMPEG_PATH?.trim();
  if (soft && fs.existsSync(soft)) {
    return soft;
  }
  const candidates = [
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    try {
      const pathEnv = process.env.PATH ?? "";
      for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir) continue;
        const full = path.join(dir, candidate);
        if (fs.existsSync(full)) {
          return full;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/** 仅读 WAV 头（最多 64KB）计算时长，避免整文件入内存。 */
export function wavDurationMsFromFile(wavPath: string): number {
  const stat = fs.statSync(wavPath);
  if (stat.size < 44) {
    return 0;
  }
  const fd = fs.openSync(wavPath, "r");
  try {
    const header = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    fs.readSync(fd, header, 0, header.length, 0);
    const info = parseWavInfo(header);
    const bytesPerSec = info.sampleRate * info.numChannels * (info.bitsPerSample / 8);
    if (bytesPerSec <= 0) {
      return 0;
    }
    return Math.max(0, Math.round((info.dataSize / bytesPerSec) * 1000));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 生成 ffmetadata 章节表。TIMEBASE=1/1000，START/END 为毫秒。
 */
export function buildM4bFfmetadata(input: {
  title: string;
  chapters: Array<{ title: string; startMs: number; endMs: number }>;
}): string {
  const lines = [
    ";FFMETADATA1",
    `title=${escapeFfmetadata(input.title)}`,
  ];
  for (const chapter of input.chapters) {
    const start = Math.max(0, Math.floor(chapter.startMs));
    const end = Math.max(start + 1, Math.floor(chapter.endMs));
    lines.push(
      "",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${start}`,
      `END=${end}`,
      `title=${escapeFfmetadata(chapter.title)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 按章 WAV 时长 + 章间静音构建章节时间轴（与 full-book 合并语义一致）。
 */
export function buildM4bChapterTimeline(input: {
  chapters: AudiobookM4bChapterInput[];
  betweenChapterGapMs?: number;
}): Array<{ title: string; startMs: number; endMs: number }> {
  const gapMs = Math.max(
    0,
    Math.floor(input.betweenChapterGapMs ?? resolveBetweenChapterGapMs()),
  );
  const ordered = [...input.chapters].sort((a, b) => a.chapterOrder - b.chapterOrder);
  let cursor = 0;
  const metaChapters: Array<{ title: string; startMs: number; endMs: number }> = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const chapter = ordered[i];
    if (!fs.existsSync(chapter.wavPath)) {
      continue;
    }
    let duration = 0;
    try {
      duration = wavDurationMsFromFile(chapter.wavPath);
    } catch {
      duration = 0;
    }
    if (duration <= 0) {
      continue;
    }
    const startMs = cursor;
    const endMs = cursor + duration;
    metaChapters.push({
      title: chapter.chapterTitle?.trim() || `第 ${chapter.chapterOrder} 章`,
      startMs,
      endMs,
    });
    cursor = endMs;
    if (i < ordered.length - 1) {
      cursor += gapMs;
    }
  }
  return metaChapters;
}

function escapeFfmetadata(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/;/g, "\\;")
    .replace(/#/g, "\\#")
    .replace(/\n/g, " ");
}

/**
 * 基于产物 `.part` 文件大小增长上报进度的定时器周期。
 * R2-2：m4b 封装是单次长时 spawn（大书数分钟至十几分钟），不加 onProgress 时
 * progress/stage/itemKey 五元组冻结，会被 watchdog 在 60s×stallPeriods 后误判假 running 杀掉。
 * 这里每隔 progressIntervalMs 上报一次 `.part` 字节数——只要 ffmpeg 还在写盘就有真推进。
 */
const M4B_PROGRESS_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.AUDIOBOOK_M4B_PROGRESS_INTERVAL_MS ?? 10_000) || 10_000,
);

/** SIGKILL 后等待 ChildProcess close 的上限，防止异常 fd/运行时让 permit 永久不释放。 */
const FFMPEG_KILL_CLOSE_WAIT_MS = 2_000;

export interface M4bFfmpegProgress {
  partBytes: number;
  elapsedMs: number;
}

export type M4bProgressCallback = (progress: M4bFfmpegProgress) => void;

/**
 * ffmpeg 产物路径：args 里最后一个非开关/非 `-` 的参数（`... -f mp4 <partPath>`）。
 * 与 encodeFullBookM4b 的 args 构造强耦合；显式 partPath 传入时优先。
 */
function resolveFfmpegOutputPath(args: string[], explicitPartPath: string | null | undefined): string | null {
  const explicit = explicitPartPath?.trim();
  if (explicit) return explicit;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg && arg !== "-" && !arg.startsWith("-")) {
      return arg;
    }
  }
  return null;
}

function runFfmpeg(input: {
  ffmpeg: string;
  args: string[];
  /** 停滞看门窗口：`.part` 连续不变超过它即掐。默认 AUDIOBOOK_M4B_STALL_TIMEOUT_MS。 */
  stallTimeoutMs?: number;
  signal?: AbortSignal;
  /** 可选：封装期间周期性上报 `.part` 文件增长，供 watchdog 推进信号。 */
  onProgress?: M4bProgressCallback | null;
  /** 产物 `.part` 路径；缺省从 args 最后一个非开关参数推导。 */
  partPath?: string | null;
}): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("m4b 封装已取消。"));
      return;
    }
    const child = spawn(input.ffmpeg, input.args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // 编码属长时降权任务：renice 到更低优先级，分享宿主下把 CPU 让给其它业务，
    // 避免大 ffmpeg 长跑被当作资源大户而牵连整机 OOM。renice 失败仅 warn 不中断。
    if (FFMPEG_NICE != null && child.pid) {
      execFile(
        "renice",
        [String(FFMPEG_NICE), "-p", String(child.pid)],
        { timeout: 2000 },
        (error) => {
          if (error) {
            console.warn("[audiobook] m4b ffmpeg renice 失败", (error as Error).message);
          }
        },
      );
    }
    const partPath = resolveFfmpegOutputPath(input.args, input.partPath);
    let stderr = "";
    let settled = false;
    let progressTimer: NodeJS.Timeout | null = null;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let killCloseTimer: NodeJS.Timeout | null = null;
    let pendingKillError: Error | null = null;
    const startedAt = Date.now();
    // 看门狗和进度日志是两个独立的观察者：进度采样不能推进停滞判定的基线。
    let lastObservedBytes = 0;
    let lastGrowthAt = startedAt;
    let lastProgressBytes = 0;
    // 停滞窗口：调用方可显式给 stallTimeoutMs，缺省用模块默认。
    const stallMs = input.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
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
    const killAndFail = (message: string) => {
      if (settled || pendingKillError) return;
      pendingKillError = new Error(message);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (progressTimer) clearInterval(progressTimer);
      input.signal?.removeEventListener("abort", onAbort);
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      // Keep task/global permits until the child lifecycle has ended. Releasing
      // immediately after kill() allows the next encoder to overlap briefly.
      killCloseTimer = setTimeout(() => {
        fail(pendingKillError ?? new Error(message));
      }, FFMPEG_KILL_CLOSE_WAIT_MS);
    };
    const onAbort = () => {
      killAndFail("m4b 封装已取消。");
    };

    const readPartBytes = (fallbackBytes: number): number => {
      try {
        if (partPath && fs.existsSync(partPath)) {
          return fs.statSync(partPath).size;
        }
      } catch {
        // ignore
      }
      return fallbackBytes;
    };

    /** 停滞看门狗：只要 `.part` 有增长就重置；连续停滞超过 stallTimeoutMs 判死。 */
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
        // 若推进中则从最近一次 watchdog 观察到的增长重新计时；否则已连续
        // 停滞整个窗口 → 判真挂。进度采样不会改变上述两个看门狗状态。
        if (remainingMs > 0) {
          scheduleWatchdog(remainingMs);
        } else {
          killAndFail(
            `ffmpeg 封装 m4b 停滞（>${Math.round(stallMs / 1000)}s 无产物产出）。`,
          );
        }
      }, delayMs);
    };
    // 造秒起点即排第一枪：若从头就一点 ".part" 都不写（如输入无效/FFmpeg 无法启动），
    // 停滞窗口走完直接 kill；若已开始写，增长会 reset 窗口。
    scheduleWatchdog();

    // 每 10s 取样 `.part` 字节数并上报 onProgress（>=0 即真推进）。
    // 仅用 dirty 读取观察变化，实际 stall 判定由停滞看门狗（stallTimeoutMs）驱动。
    if (typeof input.onProgress === "function" && partPath) {
      progressTimer = setInterval(() => {
        const partBytes = readPartBytes(lastProgressBytes);
        lastProgressBytes = partBytes;
        try {
          input.onProgress?.({ partBytes, elapsedMs: Date.now() - startedAt });
        } catch {
          // ignore
        }
      }, M4B_PROGRESS_INTERVAL_MS);
    }

    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4000) {
        stderr += chunk.toString();
      }
    });
    child.on("error", (error) => {
      fail(pendingKillError ?? (error instanceof Error ? error : new Error(String(error))));
    });
    child.on("close", (code) => {
      if (pendingKillError) {
        fail(pendingKillError);
      } else {
        finish(code, stderr.slice(0, 400));
      }
    });
  });
}

/**
 * 从章 WAV + 全书 WAV 生成 m4b（AAC）。
 * 无 ffmpeg 时 status=skipped，不抛错，保证 WAV 交付仍成功。
 * 异步子进程 + 超时 + AbortSignal，避免阻塞事件循环。
 */
export async function encodeFullBookM4b(input: {
  taskDir: string;
  bookTitle: string;
  chapters: AudiobookM4bChapterInput[];
  /** 默认用 full-book.wav 作音源 */
  sourceWavPath?: string;
  /** 章间静音，默认与全书合并一致 */
  betweenChapterGapMs?: number;
  signal?: AbortSignal;
  /** 停滞看门窗口：`.part` 连续不变超过它即掐。默认 AUDIOBOOK_M4B_STALL_TIMEOUT_MS。 */
  stallTimeoutMs?: number;
  /** 可选：封装期间周期性上报 `.part` 增长，喂给 watchdog 推进信号避免误杀。 */
  onProgress?: M4bProgressCallback | null;
  /** 持久化代际；传入时 rename 前必须确认 worker 仍属于当前代。 */
  generationToken?: string | null;
  isGenerationCurrent?: (generationToken: string) => Promise<boolean> | boolean;
}): Promise<AudiobookM4bEncodeResult> {
  // 同 taskDir 并发互斥：pause/restart/后台队列多个入口可能同时请求同一本书的 m4b，
  // 各自 spawn 会各读一遍整部 WAV 成倍放大资源占用。后到请求排队，前一轮跑完后
  // 再执行（此时若已 ready 则复用产物）。
  try {
    return await withTaskDirLock(
      input.taskDir,
      () => withGlobalM4bPermit(() => encodeFullBookM4bUnlocked(input), input.signal),
      input.signal,
    );
  } catch (error) {
    if (input.signal?.aborted) {
      return {
        status: "failed",
        path: null,
        relativePath: null,
        reason: "m4b 封装已取消。",
      };
    }
    throw error;
  }
}

/** encodeFullBookM4b 的实际实现；由 withTaskDirLock 串行化（见公开包装器）。 */
async function encodeFullBookM4bUnlocked(
  input: Parameters<typeof encodeFullBookM4b>[0],
): Promise<AudiobookM4bEncodeResult> {
  const relativePath = M4B_RELATIVE;
  const outPath = resolveFullBookM4bPath(input.taskDir);
  const sourceWav = input.sourceWavPath ?? resolveFullBookAudioPath(input.taskDir);

  if (!fs.existsSync(sourceWav)) {
    return {
      status: "failed",
      path: null,
      relativePath: null,
      reason: "全书 WAV 不存在，无法封装 m4b。",
    };
  }

  if (input.signal?.aborted) {
    return {
      status: "failed",
      path: null,
      relativePath: null,
      reason: "m4b 封装已取消。",
    };
  }

  const ffmpeg = resolveFfmpegBinary();
  if (!ffmpeg) {
    return {
      status: "skipped",
      path: null,
      relativePath: null,
      reason: "未检测到 ffmpeg（可设 AUDIOBOOK_FFMPEG_PATH）；已保留 WAV 交付。",
    };
  }

  const metaChapters = buildM4bChapterTimeline({
    chapters: input.chapters,
    betweenChapterGapMs: input.betweenChapterGapMs,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audiobook-m4b-"));
  const metaPath = path.join(tmpDir, "chapters.ffmeta");
  // 唯一 run part 名：并发的两次 encode 写不同 inode，绝不交错写同一文件；仍与 outPath
  // 同目录，保证成功后可原子 rename 覆盖规范名。宿主重启后孤儿 ffmpeg 继续写旧 part，
  // 不会与新 run 冲突。
  const runId = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const partPath = path.join(path.dirname(outPath), `${path.basename(outPath)}.${runId}.part`);
  try {
    // 进入串行区后、真正编码前：若排在前面的一轮已把产物写好（例如后台队列与
    // 重启兜底并发排队，前一轮先跑完），直接复用已就绪 m4b，不再重复整书编码。
    if (fs.existsSync(outPath) && fs.statSync(outPath).size >= 64) {
      return {
        status: "ready",
        path: outPath,
        relativePath,
        bytes: fs.statSync(outPath).size,
        chapterCount: metaChapters.length,
      };
    }
    // 起跑前 best-effort 清掉陈旧半成品（本次 run 的新 part mtime 新，不受影响）。
    // 不要再 unlink 共享 full-book.m4b.part——唯一名下不存在该文件，且 renameSync 原子覆盖规范名。
    cleanupStaleM4bParts(input.taskDir, outPath);
    fs.writeFileSync(
      metaPath,
      buildM4bFfmetadata({
        title: input.bookTitle?.trim() || "有声书",
        chapters: metaChapters,
      }),
      "utf8",
    );

    // 不再预删共享 part；唯一 run part 天然避免新旧交错。但成功覆盖规范名之前，
    // 若存在旧的成功产物也无需删除——renameSync 原子覆盖它。
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...(FFMPEG_THREADS_CAP ? ["-threads", String(FFMPEG_THREADS_CAP)] : []),
      "-i",
      sourceWav,
      "-i",
      metaPath,
      "-map",
      "0:a:0",
      "-map_metadata",
      "1",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      partPath,
    ];

    let runResult: { status: number | null; stderr: string };
    try {
      runResult = await runFfmpeg({
        ffmpeg,
        args,
        stallTimeoutMs: input.stallTimeoutMs,
        signal: input.signal,
        onProgress: input.onProgress,
        partPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        path: null,
        relativePath: null,
        reason: message.slice(0, 240),
      };
    }

    if (runResult.status !== 0 || !fs.existsSync(partPath)) {
      return {
        status: "failed",
        path: null,
        relativePath: null,
        reason: `ffmpeg 封装 m4b 失败：${runResult.stderr || `exit ${runResult.status}`}`,
      };
    }
    if (input.generationToken && input.isGenerationCurrent) {
      const current = await input.isGenerationCurrent(input.generationToken);
      if (!current) {
        return {
          status: "failed",
          path: null,
          relativePath: null,
          reason: "m4b 封装代际已失效，丢弃旧 worker 产物。",
        };
      }
    }
    fs.renameSync(partPath, outPath);
    const bytes = fs.statSync(outPath).size;
    if (bytes < 64) {
      try { fs.unlinkSync(outPath); } catch { /* ignore */ }
      return {
        status: "failed",
        path: null,
        relativePath: null,
        reason: "m4b 产物异常过小。",
      };
    }
    return {
      status: "ready",
      path: outPath,
      relativePath,
      bytes,
      chapterCount: metaChapters.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      path: null,
      relativePath: null,
      reason: `m4b 封装异常：${message.slice(0, 240)}`,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch {
      // ignore
    }
  }
}
