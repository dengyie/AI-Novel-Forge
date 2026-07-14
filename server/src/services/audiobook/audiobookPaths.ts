import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "../../runtime/appPaths";

/** 有声书产物根目录（磁盘树，不写 PG base64）。 */
export function resolveAudiobookRoot(): string {
  return path.join(resolveDataRoot(), "storage", "audiobooks");
}

export function resolveAudiobookTaskDir(novelId: string, taskId: string): string {
  return path.join(resolveAudiobookRoot(), novelId, taskId);
}

export function ensureAudiobookTaskDir(novelId: string, taskId: string): string {
  const dir = resolveAudiobookTaskDir(novelId, taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveChapterAudioDir(taskDir: string, chapterId: string): string {
  return path.join(taskDir, "chapters", chapterId);
}

export function ensureChapterAudioDir(taskDir: string, chapterId: string): string {
  const dir = resolveChapterAudioDir(taskDir, chapterId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveChunkAudioPath(taskDir: string, chapterId: string, chunkIndex: number): string {
  return path.join(resolveChapterAudioDir(taskDir, chapterId), `chunk-${String(chunkIndex).padStart(4, "0")}.wav`);
}

export function resolveChapterAudioPath(taskDir: string, chapterId: string): string {
  return path.join(resolveChapterAudioDir(taskDir, chapterId), "chapter.wav");
}

export function resolveFullBookAudioPath(taskDir: string): string {
  return path.join(taskDir, "full-book.wav");
}
