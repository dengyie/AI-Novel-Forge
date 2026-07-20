import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "../../runtime/appPaths";
import { isValidPcmWavFile, parseWavInfo } from "./audiobookWav";

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

/** 全站 VoiceAsset 库根：位于 voice-refs 内，保证 checkVoiceRefAudioPath 可通过。 */
export function resolveGlobalVoiceLibraryRoot(): string {
  return path.join(resolveVoiceRefRoot(), "global");
}

export function resolveGlobalVoiceRegistryPath(): string {
  return path.join(resolveGlobalVoiceLibraryRoot(), "registry.json");
}

export function resolveGlobalVoiceAssetDir(assetId: string): string {
  const safeId = assertSafePathSegment(assetId, "voiceAssetId");
  return path.join(resolveGlobalVoiceLibraryRoot(), "assets", safeId);
}

export function resolveGlobalVoiceAssetRefPath(assetId: string, ext = "wav"): string {
  const safeExt = (ext || "wav").replace(/[^a-z0-9]/gi, "").toLowerCase() || "wav";
  return path.join(resolveGlobalVoiceAssetDir(assetId), `ref.${safeExt}`);
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

/** 角色卡固定试听 WAV（与 clone ref 同目录）。 */
export function resolveCharacterVoicePreviewPath(novelId: string, characterId: string): string {
  return path.join(resolveCharacterVoiceRefDir(novelId, characterId), "preview.wav");
}

/**
 * 多抽候选 WAV：candidate-0.wav …（同目录，未 adopt 前不覆盖 preview.wav）。
 * index 须为 0–9 整数。
 */
export function resolveCharacterVoicePreviewCandidatePath(
  novelId: string,
  characterId: string,
  index: number,
): string {
  const safeIndex = Math.max(0, Math.min(9, Math.floor(index)));
  return path.join(
    resolveCharacterVoiceRefDir(novelId, characterId),
    `preview-candidate-${safeIndex}.wav`,
  );
}

/** 多抽元数据（JSON）：记录最近一次候选列表，供 adopt 校验。 */
export function resolveCharacterVoicePreviewCandidatesMetaPath(
  novelId: string,
  characterId: string,
): string {
  return path.join(resolveCharacterVoiceRefDir(novelId, characterId), "preview-candidates.json");
}

/**
 * 将 base64 落盘为 preview 候选 WAV，返回绝对路径。
 */
export function writeCharacterVoicePreviewCandidateFromBase64(input: {
  novelId: string;
  characterId: string;
  index: number;
  base64: string;
  maxBytes?: number;
}): string {
  const maxBytes = input.maxBytes ?? 3 * 1024 * 1024;
  const raw = input.base64.trim();
  if (!raw) {
    throw new Error("试听候选 base64 不能为空。");
  }
  const match = /^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i.exec(raw);
  const bare = (match ? match[2] : raw).replace(/\s+/g, "");
  if (!bare) {
    throw new Error("试听候选 base64 无效。");
  }
  const buf = Buffer.from(bare, "base64");
  if (buf.length <= 0) {
    throw new Error("试听候选解码后为空。");
  }
  if (buf.length > maxBytes) {
    throw new Error(`试听候选过大（>${maxBytes} bytes）。`);
  }
  try {
    const info = parseWavInfo(buf);
    if (info.dataSize < 2 || buf.length < info.dataOffset + Math.min(info.dataSize, 2)) {
      throw new Error("试听候选不是合法 PCM WAV。");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("试听候选")) {
      throw error;
    }
    throw new Error("试听候选仅接受合法 PCM WAV。");
  }

  const dir = resolveCharacterVoiceRefDir(input.novelId, input.characterId);
  fs.mkdirSync(dir, { recursive: true });
  const target = resolveCharacterVoicePreviewCandidatePath(
    input.novelId,
    input.characterId,
    input.index,
  );
  const tmp = `${target}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
  return target;
}

/**
 * 将 base64（可带 data: 前缀）落盘为角色固定试听 WAV，返回绝对路径。
 * 与 preview ready / chapter ready 同一套：必须为合法 PCM WAV。
 */
export function writeCharacterVoicePreviewFromBase64(input: {
  novelId: string;
  characterId: string;
  base64: string;
  maxBytes?: number;
}): string {
  const maxBytes = input.maxBytes ?? 3 * 1024 * 1024;
  const raw = input.base64.trim();
  if (!raw) {
    throw new Error("试听音频 base64 不能为空。");
  }
  const match = /^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i.exec(raw);
  const bare = (match ? match[2] : raw).replace(/\s+/g, "");
  if (!bare) {
    throw new Error("试听音频 base64 无效。");
  }
  const buf = Buffer.from(bare, "base64");
  if (buf.length <= 0) {
    throw new Error("试听音频解码后为空。");
  }
  if (buf.length > maxBytes) {
    throw new Error(`试听音频过大（>${maxBytes} bytes）。`);
  }
  try {
    const info = parseWavInfo(buf);
    if (info.dataSize < 2 || buf.length < info.dataOffset + Math.min(info.dataSize, 2)) {
      throw new Error("试听资产不是合法 PCM WAV。");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("试听资产")) {
      throw error;
    }
    throw new Error("试听资产仅接受合法 PCM WAV。");
  }

  const dir = resolveCharacterVoiceRefDir(input.novelId, input.characterId);
  fs.mkdirSync(dir, { recursive: true });
  const target = resolveCharacterVoicePreviewPath(input.novelId, input.characterId);
  const tmp = `${target}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
  return target;
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


/**
 * 将正式 preview.wav 原子拷贝为 clone ref.wav（Design→Clone）。
 * 源必须是合法 PCM WAV；返回 ref 绝对路径。
 */
export function copyCharacterVoicePreviewToRef(input: {
  novelId: string;
  characterId: string;
  previewPath?: string | null;
}): string {
  const source = (input.previewPath?.trim()
    || resolveCharacterVoicePreviewPath(input.novelId, input.characterId));
  if (!isValidPcmWavFile(source)) {
    throw new Error("升格 clone 需要合法 PCM WAV 试听文件。");
  }
  const target = resolveCharacterVoiceRefPath(input.novelId, input.characterId, "wav");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buf = fs.readFileSync(source);
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

/**
 * 用既有的任务输出目录（如父任务 outputDir）创建路径并回。
 * 续生成子任务传入父 outputDir 时用此：章 wav 落父目录，父 reconcile 才能看见。
 * 关键安全约束：传入的绝对路径必须落在有声书产物根之下，拒绝越界/相对/非本根路径。
 */
export function ensureDirExistsUnderAudiobookRoot(absoluteDir: string): string {
  const trimmed = absoluteDir?.trim();
  if (!trimmed) {
    throw new Error("任务输出目录不能为空。");
  }
  const resolved = path.resolve(trimmed);
  const root = resolveAudiobookRoot();
  const rootResolved = path.resolve(root);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (resolved !== rootResolved && !resolved.startsWith(prefix)) {
    throw new Error(`任务输出目录越界，必须位于有声书产物根之下：${resolved}`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
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
 * 清除单章音频产物（chunk + chapter.wav + layout 指纹 + .part），保留 annotations 由调用方决定。
 * 同时删除全书 full-book.wav（章变则全书必须重拼）。
 */
export function wipeChapterAudioArtifacts(taskDir: string, chapterId: string): void {
  const chapterDir = resolveChapterAudioDir(taskDir, chapterId);
  if (fs.existsSync(chapterDir)) {
    for (const name of fs.readdirSync(chapterDir)) {
      if (
        name.startsWith("chunk-")
        || name === "chapter.wav"
        || name === "chunk-layout.sha1"
        || name.endsWith(".part")
      ) {
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

/** 章音频已落盘且为合法 PCM WAV，用于任务摘要/渐进播放。 */
export function isChapterAudioReady(taskDir: string, chapterId: string): boolean {
  try {
    return isValidPcmWavFile(resolveChapterAudioPath(taskDir, chapterId));
  } catch {
    return false;
  }
}

/** 按任务章节顺序返回已有 chapter.wav 的 id。 */
export function listReadyChapterAudioIds(taskDir: string, chapterIds: string[]): string[] {
  return chapterIds.filter((chapterId) => isChapterAudioReady(taskDir, chapterId));
}

/** 全书 WAV 已落盘且为合法 PCM（与 chapter ready / preview 同一套校验）。 */
export function isFullBookAudioReady(taskDir: string): boolean {
  try {
    return isValidPcmWavFile(resolveFullBookAudioPath(taskDir));
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
