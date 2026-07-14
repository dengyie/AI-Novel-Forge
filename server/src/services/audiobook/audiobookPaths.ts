import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "../../runtime/appPaths";

function assertSafePathSegment(value: string, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} 不能为空。`);
  }
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(`${label} 含非法路径字符。`);
  }
  // 仅允许常见 id 字符（cuid / uuid / 短 token）
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(`${label} 格式非法。`);
  }
  return trimmed;
}

/** 有声书产物根目录（磁盘树，不写 PG base64）。 */
export function resolveAudiobookRoot(): string {
  return path.join(resolveDataRoot(), "storage", "audiobooks");
}

export function resolveAudiobookTaskDir(novelId: string, taskId: string): string {
  const safeNovelId = assertSafePathSegment(novelId, "novelId");
  const safeTaskId = assertSafePathSegment(taskId, "taskId");
  return path.join(resolveAudiobookRoot(), safeNovelId, safeTaskId);
}

export function ensureAudiobookTaskDir(novelId: string, taskId: string): string {
  const dir = resolveAudiobookTaskDir(novelId, taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveChapterAudioDir(taskDir: string, chapterId: string): string {
  const safeChapterId = assertSafePathSegment(chapterId, "chapterId");
  return path.join(taskDir, "chapters", safeChapterId);
}

export function ensureChapterAudioDir(taskDir: string, chapterId: string): string {
  const dir = resolveChapterAudioDir(taskDir, chapterId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveChunkAudioPath(taskDir: string, chapterId: string, chunkIndex: number): string {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("chunkIndex 必须是非负整数。");
  }
  return path.join(resolveChapterAudioDir(taskDir, chapterId), `chunk-${String(chunkIndex).padStart(4, "0")}.wav`);
}

export function resolveChapterAudioPath(taskDir: string, chapterId: string): string {
  return path.join(resolveChapterAudioDir(taskDir, chapterId), "chapter.wav");
}

export function resolveFullBookAudioPath(taskDir: string): string {
  return path.join(taskDir, "full-book.wav");
}

export function resolveChapterAnnotationPath(taskDir: string, chapterId: string): string {
  const safeChapterId = assertSafePathSegment(chapterId, "chapterId");
  return path.join(taskDir, "annotations", `${safeChapterId}.json`);
}

/** 删除文件；不存在则忽略。 */
export function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

/**
 * 清除单章音频产物（chunk + chapter.wav + .part），保留 annotations 由调用方决定。
 * 同时删除全书 full-book.wav（章变则全书必须重拼）。
 */
export function wipeChapterAudioArtifacts(taskDir: string, chapterId: string): void {
  const chapterDir = resolveChapterAudioDir(taskDir, chapterId);
  if (fs.existsSync(chapterDir)) {
    for (const name of fs.readdirSync(chapterDir)) {
      if (name.startsWith("chunk-") || name === "chapter.wav" || name.endsWith(".part")) {
        safeUnlink(path.join(chapterDir, name));
      }
    }
  }
  safeUnlink(resolveFullBookAudioPath(taskDir));
  safeUnlink(`${resolveFullBookAudioPath(taskDir)}.part`);
}

export function wipeChapterAnnotationArtifact(taskDir: string, chapterId: string): void {
  const ann = resolveChapterAnnotationPath(taskDir, chapterId);
  safeUnlink(ann);
  safeUnlink(`${ann}.part`);
}
