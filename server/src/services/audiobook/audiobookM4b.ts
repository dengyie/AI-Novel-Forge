import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBetweenChapterGapMs } from "./audiobookGap";
import { resolveFullBookAudioPath, resolveFullBookM4bPath } from "./audiobookPaths";
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

/** 默认 20 分钟；可用 AUDIOBOOK_M4B_FFMPEG_TIMEOUT_MS 覆盖。 */
const DEFAULT_FFMPEG_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.AUDIOBOOK_M4B_FFMPEG_TIMEOUT_MS ?? 20 * 60_000) || 20 * 60_000,
);

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

function runFfmpeg(input: {
  ffmpeg: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("m4b 封装已取消。"));
      return;
    }
    const child = spawn(input.ffmpeg, input.args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
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
    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      fail(new Error("m4b 封装已取消。"));
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      fail(new Error(`ffmpeg 封装 m4b 超时（>${input.timeoutMs}ms）。`));
    }, input.timeoutMs);

    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4000) {
        stderr += chunk.toString();
      }
    });
    child.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("close", (code) => {
      finish(code, stderr.slice(0, 400));
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
  timeoutMs?: number;
}): Promise<AudiobookM4bEncodeResult> {
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
  const partPath = `${outPath}.part`;
  try {
    fs.writeFileSync(
      metaPath,
      buildM4bFfmetadata({
        title: input.bookTitle?.trim() || "有声书",
        chapters: metaChapters,
      }),
      "utf8",
    );

    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      // ignore
    }

    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
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
        timeoutMs: Math.max(5_000, input.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS),
        signal: input.signal,
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
