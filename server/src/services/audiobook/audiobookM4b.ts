import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWavInfo } from "./audiobookWav";
import { resolveFullBookAudioPath } from "./audiobookPaths";

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

export function resolveFullBookM4bPath(taskDir: string): string {
  return path.join(taskDir, M4B_RELATIVE);
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
    const which = spawnSync("which", [candidate], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) {
      return which.stdout.trim();
    }
  }
  return null;
}

function wavDurationMs(wavPath: string): number {
  const buf = fs.readFileSync(wavPath);
  const info = parseWavInfo(buf);
  const bytesPerSec = info.sampleRate * info.numChannels * (info.bitsPerSample / 8);
  if (bytesPerSec <= 0) {
    return 0;
  }
  return Math.max(0, Math.round((info.dataSize / bytesPerSec) * 1000));
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

function escapeFfmetadata(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/;/g, "\\;")
    .replace(/#/g, "\\#")
    .replace(/\n/g, " ");
}

/**
 * 从章 WAV + 全书 WAV 生成 m4b（AAC）。
 * 无 ffmpeg 时 status=skipped，不抛错，保证 WAV 交付仍成功。
 */
export function encodeFullBookM4b(input: {
  taskDir: string;
  bookTitle: string;
  chapters: AudiobookM4bChapterInput[];
  /** 默认用 full-book.wav 作音源 */
  sourceWavPath?: string;
}): AudiobookM4bEncodeResult {
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

  const ffmpeg = resolveFfmpegBinary();
  if (!ffmpeg) {
    return {
      status: "skipped",
      path: null,
      relativePath: null,
      reason: "未检测到 ffmpeg（可设 AUDIOBOOK_FFMPEG_PATH）；已保留 WAV 交付。",
    };
  }

  const ordered = [...input.chapters].sort((a, b) => a.chapterOrder - b.chapterOrder);
  let cursor = 0;
  const metaChapters: Array<{ title: string; startMs: number; endMs: number }> = [];
  for (const chapter of ordered) {
    if (!fs.existsSync(chapter.wavPath)) {
      continue;
    }
    let duration = 0;
    try {
      duration = wavDurationMs(chapter.wavPath);
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
  }

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

    // 清理旧产物
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
    const result = spawnSync(ffmpeg, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || !fs.existsSync(partPath)) {
      const stderr = (result.stderr || result.stdout || "").toString().slice(0, 400);
      return {
        status: "failed",
        path: null,
        relativePath: null,
        reason: `ffmpeg 封装 m4b 失败：${stderr || `exit ${result.status}`}`,
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
