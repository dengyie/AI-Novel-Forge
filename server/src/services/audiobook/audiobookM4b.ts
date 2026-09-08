import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBetweenChapterGapMs } from "./audiobookGap";
import { resolveFullBookAudioPath, resolveFullBookM4bPath, cleanupStaleM4bParts } from "./audiobookPaths";
import { parseWavInfo } from "./audiobookWav";
import {
  runFfmpegProcess,
  type M4bProgressCallback,
} from "./infrastructure/m4b/FfmpegProcessRunner";
import {
  getM4bGlobalConcurrency,
  withGlobalM4bPermit,
} from "./infrastructure/m4b/M4bPermitPool";
import {
  withAudiobookTaskDirArtifactLock,
  withM4bEncodeLock,
} from "./infrastructure/m4b/M4bTaskLocks";

export { getM4bGlobalConcurrency, withAudiobookTaskDirArtifactLock };
export type { M4bFfmpegProgress, M4bProgressCallback } from "./infrastructure/m4b/FfmpegProcessRunner";

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
 * ffmpeg 编码线程上限。大书 m4b 是对整本 WAV 的实时重采样+AAC 重编码，默认全核
 * 会把小巧/共享宿主占满、加剧与其它进程的争抢；这里默认封顶 2 线程，可用
 * AUDIOBOOK_M4B_FFMPEG_THREADS 覆盖。配置为 0 或其它非法值时回退默认值，不能
 * 让 ffmpeg 自行按宿主 CPU 扩张；显式线程数仍封顶 4，避免错误配置重新制造共享宿主 OOM。
 */
export function resolveM4bFfmpegThreads(
  value = process.env.AUDIOBOOK_M4B_FFMPEG_THREADS,
): number {
  const raw = Number(value ?? 2);
  if (raw === 0) return 2;
  if (!Number.isSafeInteger(raw) || raw < 1) return 2;
  return Math.min(4, raw);
}

const FFMPEG_THREADS_CAP = resolveM4bFfmpegThreads();

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

export function buildM4bFfmpegArgs(input: {
  sourceWavPath: string;
  metadataPath: string;
  outputPath: string;
  threads?: number | null;
}): string[] {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input.sourceWavPath,
    "-i",
    input.metadataPath,
    "-map",
    "0:a:0",
    "-map_metadata",
    "1",
    "-c:a",
    "aac",
    ...(input.threads ? ["-threads", String(input.threads)] : []),
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    input.outputPath,
  ];
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
    return await withM4bEncodeLock(
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
    const args = buildM4bFfmpegArgs({
      sourceWavPath: sourceWav,
      metadataPath: metaPath,
      outputPath: partPath,
      threads: FFMPEG_THREADS_CAP,
    });

    let runResult: { status: number | null; stderr: string };
    try {
      runResult = await runFfmpegProcess({
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
    return await withAudiobookTaskDirArtifactLock(input.taskDir, async () => {
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
    });
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
