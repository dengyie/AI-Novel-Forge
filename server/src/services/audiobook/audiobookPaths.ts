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

/** clone 参考音频根目录（角色级资产，非任务产物）。 */
export function resolveVoiceRefRoot(): string {
  return path.join(resolveDataRoot(), "storage", "voice-refs");
}

export function resolveCharacterVoiceRefDir(novelId: string, characterId: string): string {
  const safeNovelId = assertSafePathSegment(novelId, "novelId");
  const safeCharacterId = assertSafePathSegment(characterId, "characterId");
  return path.join(resolveVoiceRefRoot(), safeNovelId, safeCharacterId);
}

export function resolveCharacterVoiceRefPath(novelId: string, characterId: string, ext = "wav"): string {
  const safeExt = (ext || "wav").replace(/[^a-z0-9]/gi, "").toLowerCase() || "wav";
  return path.join(resolveCharacterVoiceRefDir(novelId, characterId), `ref.${safeExt}`);
}

/**
 * 将 base64（可带 data: 前缀）落盘为角色 clone 参考音频，返回绝对路径。
 */
export function writeCharacterVoiceRefFromBase64(input: {
  novelId: string;
  characterId: string;
  base64: string;
  maxBytes?: number;
}): string {
  const maxBytes = input.maxBytes ?? 8 * 1024 * 1024;
  const raw = input.base64.trim();
  if (!raw) {
    throw new Error("参考音频 base64 不能为空。");
  }
  const match = /^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i.exec(raw);
  const mimeSubtype = match?.[1]?.toLowerCase() ?? "wav";
  const bare = (match ? match[2] : raw).replace(/\s+/g, "");
  if (!bare) {
    throw new Error("参考音频 base64 无效。");
  }
  const buf = Buffer.from(bare, "base64");
  if (buf.length <= 0) {
    throw new Error("参考音频解码后为空。");
  }
  if (buf.length > maxBytes) {
    throw new Error(`参考音频过大（>${maxBytes} bytes）。`);
  }
  // RIFF 优先 wav；否则按 mime 猜扩展
  const isRiff = buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF";
  const ext = isRiff
    ? "wav"
    : mimeSubtype.includes("mpeg") || mimeSubtype === "mp3"
      ? "mp3"
      : mimeSubtype.includes("ogg")
        ? "ogg"
        : "wav";

  const dir = resolveCharacterVoiceRefDir(input.novelId, input.characterId);
  fs.mkdirSync(dir, { recursive: true });
  const target = resolveCharacterVoiceRefPath(input.novelId, input.characterId, ext);
  const tmp = `${target}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
  return target;
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

export function resolveFullBookM4bPath(taskDir: string): string {
  return path.join(taskDir, "full-book.m4b");
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
  safeUnlink(resolveFullBookM4bPath(taskDir));
  safeUnlink(`${resolveFullBookM4bPath(taskDir)}.part`);
}

export function wipeChapterAnnotationArtifact(taskDir: string, chapterId: string): void {
  const ann = resolveChapterAnnotationPath(taskDir, chapterId);
  safeUnlink(ann);
  safeUnlink(`${ann}.part`);
}

/** 章音频已落盘（存在且大于最小 WAV 头），用于任务摘要/渐进播放。 */
export function isChapterAudioReady(taskDir: string, chapterId: string): boolean {
  try {
    const filePath = resolveChapterAudioPath(taskDir, chapterId);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    return fs.statSync(filePath).size > 44;
  } catch {
    return false;
  }
}

/** 按任务章节顺序返回已有 chapter.wav 的 id。 */
export function listReadyChapterAudioIds(taskDir: string, chapterIds: string[]): string[] {
  return chapterIds.filter((chapterId) => isChapterAudioReady(taskDir, chapterId));
}

export function isFullBookAudioReady(taskDir: string): boolean {
  try {
    const filePath = resolveFullBookAudioPath(taskDir);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    return fs.statSync(filePath).size > 44;
  } catch {
    return false;
  }
}

/**
 * 全书合成成功后删除 chunk-*.wav，保留 chapter.wav / full-book.* / annotations。
 * 重合成走 wipeChapterAudioArtifacts，不依赖 chunk 续跑。
 * @returns 删除的文件数
 */
export function pruneChunkWavArtifacts(taskDir: string, chapterIds: string[]): number {
  let removed = 0;
  for (const chapterId of chapterIds) {
    let chapterDir: string;
    try {
      chapterDir = resolveChapterAudioDir(taskDir, chapterId);
    } catch {
      continue;
    }
    if (!fs.existsSync(chapterDir)) {
      continue;
    }
    for (const name of fs.readdirSync(chapterDir)) {
      if (name.startsWith("chunk-") || (name.startsWith("chunk") && name.endsWith(".part"))) {
        safeUnlink(path.join(chapterDir, name));
        removed += 1;
      }
    }
  }
  return removed;
}
