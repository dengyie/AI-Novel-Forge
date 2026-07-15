import fs from "node:fs";
import path from "node:path";
import type {
  AudiobookChapterAnnotation,
  AudiobookCharacterVoiceConfig,
  AudiobookDialogueSegment,
  AudiobookNarratorConfig,
} from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { audiobookAnnotationService } from "./AudiobookAnnotationService";
import { expandSegmentsToChunkJobs } from "./audiobookChunk";
import {
  resolveBetweenChapterGapMs,
  resolveInterChunkGapMs,
  speakerKeyFromSegment,
  type AudiobookChunkSpeakerRef,
} from "./audiobookGap";
import {
  ensureAudiobookTaskDir,
  ensureChapterAudioDir,
  resolveChapterAudioPath,
  resolveChunkAudioPath,
  resolveFullBookAudioPath,
  wipeChapterAudioArtifacts,
} from "./audiobookPaths";
import { createHash } from "node:crypto";
import {
  encodeFullBookM4b,
  type AudiobookM4bEncodeResult,
} from "./audiobookM4b";
import {
  buildWavBuffer,
  concatWavFiles,
  createSilentPcm,
  isValidPcmWavFile,
  parseWavInfo,
  writeWavFileAtomic,
} from "./audiobookWav";
import { mimoChatAudioTTSProvider } from "./MimoChatAudioTTSProvider";

export type AudiobookCancelChecker = () => Promise<boolean>;

export interface AudiobookPipelineProgress {
  phase: "annotating" | "synthesizing" | "merging" | "finalizing";
  chapterIndex: number;
  chapterCount: number;
  chapterId: string;
  chapterTitle: string;
  completedChapters: number;
  completedChunks: number;
  totalChunksEstimate: number;
  message: string;
  /** 仅在标注完成/终态时带上全量 annotations，避免每 chunk 写库 */
  annotations?: AudiobookChapterAnnotation[];
  /** 标注阶段增量：刚完成的一章 */
  annotationDelta?: AudiobookChapterAnnotation;
  chapterAudioPaths: Array<{ chapterId: string; path: string }>;
  fullAudioPath?: string | null;
  /** 旁白回退等质量警告（聚合） */
  qualityWarnings?: string[];
}

export interface RunAudiobookPipelineInput {
  taskId: string;
  novelId: string;
  /** 书名，用于 m4b 元数据 */
  novelTitle?: string | null;
  chapterIds: string[];
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
  provider?: LLMProvider | null;
  model?: string | null;
  temperature?: number | null;
  annotateProvider?: LLMProvider | null;
  annotateModel?: string | null;
  signal?: AbortSignal;
  isCancelRequested: AudiobookCancelChecker;
  onProgress: (progress: AudiobookPipelineProgress) => Promise<void> | void;
}

export interface RunAudiobookPipelineResult {
  annotations: AudiobookChapterAnnotation[];
  chapterAudioPaths: Array<{ chapterId: string; path: string; bytes: number }>;
  fullAudioPath: string;
  completedChapterCount: number;
  completedChunks: number;
  outputDir: string;
  qualityWarnings: string[];
  m4b: AudiobookM4bEncodeResult;
}

class PipelineCancelledError extends Error {
  constructor(message = "有声书任务已取消。") {
    super(message);
    this.name = "PipelineCancelledError";
  }
}

async function throwIfCancelled(
  signal: AbortSignal | undefined,
  isCancelRequested: AudiobookCancelChecker,
): Promise<void> {
  if (signal?.aborted || (await isCancelRequested())) {
    throw new PipelineCancelledError();
  }
}

function loadExistingAnnotations(annotationsJson: string | null | undefined): AudiobookChapterAnnotation[] {
  if (!annotationsJson?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(annotationsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is AudiobookChapterAnnotation => {
      return Boolean(
        item
        && typeof item === "object"
        && typeof (item as AudiobookChapterAnnotation).chapterId === "string"
        && Array.isArray((item as AudiobookChapterAnnotation).segments),
      );
    });
  } catch {
    return [];
  }
}

function annotationPath(taskDir: string, chapterId: string): string {
  return path.join(taskDir, "annotations", `${chapterId}.json`);
}

function writeAnnotationFileSafe(taskDir: string, annotation: AudiobookChapterAnnotation): void {
  const dir = path.join(taskDir, "annotations");
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = annotationPath(taskDir, annotation.chapterId);
  const tmp = `${finalPath}.part`;
  fs.writeFileSync(tmp, JSON.stringify(annotation, null, 2), "utf8");
  fs.renameSync(tmp, finalPath);
}

function readAnnotationFile(taskDir: string, chapterId: string): AudiobookChapterAnnotation | null {
  const file = annotationPath(taskDir, chapterId);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as AudiobookChapterAnnotation;
    if (!parsed?.chapterId || !Array.isArray(parsed.segments)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function listExistingChunkPaths(taskDir: string, chapterId: string, expectedCount: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < expectedCount; i += 1) {
    const chunkPath = resolveChunkAudioPath(taskDir, chapterId, i);
    if (!isValidPcmWavFile(chunkPath)) {
      break;
    }
    paths.push(chunkPath);
  }
  return paths;
}


function chunkLayoutFingerprint(jobs: Array<{ text: string; segment: AudiobookDialogueSegment }>): string {
  const hash = createHash("sha1");
  for (const job of jobs) {
    hash.update(speakerKeyFromSegment(job.segment));
    hash.update("\0");
    hash.update(job.segment.ttsMode ?? "preset");
    hash.update("\0");
    hash.update(job.segment.voice ?? "");
    hash.update("\0");
    hash.update(String(job.text.length));
    hash.update("\0");
    hash.update(job.text.slice(0, 64));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

function resolveChunkLayoutPath(taskDir: string, chapterId: string): string {
  return path.join(ensureChapterAudioDir(taskDir, chapterId), "chunk-layout.sha1");
}

function readChunkLayoutFingerprint(taskDir: string, chapterId: string): string | null {
  const filePath = resolveChunkLayoutPath(taskDir, chapterId);
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeChunkLayoutFingerprint(taskDir: string, chapterId: string, fingerprint: string): void {
  const filePath = resolveChunkLayoutPath(taskDir, chapterId);
  fs.writeFileSync(filePath, `${fingerprint}\n`, "utf8");
}

function collectQualityWarnings(annotations: AudiobookChapterAnnotation[]): string[] {
  const warnings: string[] = [];
  for (const annotation of annotations) {
    if (annotation.error?.trim()) {
      warnings.push(`第 ${annotation.chapterOrder} 章：${annotation.error.trim()}`);
    }
  }
  return warnings;
}

async function synthesizeChunkWithRetry(input: {
  text: string;
  voice: string;
  style?: string | null;
  ttsMode?: string | null;
  designPrompt?: string | null;
  refAudioPath?: string | null;
  provider?: LLMProvider | null;
  signal?: AbortSignal;
  maxAttempts?: number;
}): Promise<Buffer> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const modeRaw = input.ttsMode?.trim();
      const mode = modeRaw === "design" || modeRaw === "clone" ? modeRaw : "preset";
      const result = await mimoChatAudioTTSProvider.synthesize({
        text: input.text,
        mode,
        voice: input.voice,
        style: input.style,
        designPrompt: input.designPrompt,
        refAudioPath: input.refAudioPath,
        format: "wav",
        provider: input.provider ?? undefined,
        signal: input.signal,
      });
      return Buffer.from(result.audioBase64, "base64");
    } catch (error) {
      lastError = error;
      if (input.signal?.aborted) {
        throw error;
      }
      // 400 客户端错误、408 取消：不重试；504 超时、502 上游：可重试
      if (error instanceof AppError && (error.statusCode === 400 || error.statusCode === 408)) {
        throw error;
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AppError("MiMo TTS 合成失败。", 502);
}

export class AudiobookPipelineService {
  async run(input: RunAudiobookPipelineInput): Promise<RunAudiobookPipelineResult> {
    const taskDir = ensureAudiobookTaskDir(input.novelId, input.taskId);
    const chapters = await prisma.chapter.findMany({
      where: {
        novelId: input.novelId,
        id: { in: input.chapterIds },
      },
      select: {
        id: true,
        order: true,
        title: true,
        content: true,
      },
    });
    const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
    const orderedChapters = input.chapterIds.map((id) => {
      const row = chapterById.get(id);
      if (!row) {
        throw new AppError(`章节不存在：${id}`, 404);
      }
      return row;
    });

    if (orderedChapters.length === 0) {
      throw new AppError("任务章节列表为空。", 400);
    }

    const taskRow = await prisma.audiobookTask.findUnique({
      where: { id: input.taskId },
      select: { annotationsJson: true },
    });
    const annotationsByChapter = new Map(
      loadExistingAnnotations(taskRow?.annotationsJson).map((item) => [item.chapterId, item]),
    );

    const annotations: AudiobookChapterAnnotation[] = [];
    const chapterAudioPaths: Array<{ chapterId: string; path: string; bytes: number }> = [];
    let completedChunks = 0;
    let totalChunksEstimate = 0;

    // ── 标注阶段 ──
    for (let chapterIndex = 0; chapterIndex < orderedChapters.length; chapterIndex += 1) {
      await throwIfCancelled(input.signal, input.isCancelRequested);
      const chapter = orderedChapters[chapterIndex];
      let annotation = annotationsByChapter.get(chapter.id) ?? readAnnotationFile(taskDir, chapter.id);

      if (!annotation || annotation.segments.length === 0) {
        await input.onProgress({
          phase: "annotating",
          chapterIndex,
          chapterCount: orderedChapters.length,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          completedChapters: chapterIndex,
          completedChunks,
          totalChunksEstimate,
          message: `标注第 ${chapter.order} 章：${chapter.title}`,
          chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
        });

        annotation = await audiobookAnnotationService.annotateChapter({
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          chapterTitle: chapter.title,
          chapterContent: chapter.content ?? "",
          narrator: input.narrator,
          characterVoices: input.characterVoices,
          provider: input.annotateProvider ?? input.provider,
          model: input.annotateModel ?? input.model,
          temperature: input.temperature,
          signal: input.signal,
        });
        writeAnnotationFileSafe(taskDir, annotation);
      }

      annotations.push(annotation);
      totalChunksEstimate += expandSegmentsToChunkJobs(annotation.segments).length;

      await input.onProgress({
        phase: "annotating",
        chapterIndex,
        chapterCount: orderedChapters.length,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        completedChapters: chapterIndex,
        completedChunks,
        totalChunksEstimate,
        message: `已标注第 ${chapter.order} 章（${annotation.segments.length} 段）`,
        annotationDelta: annotation,
        annotations: [...annotations],
        chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
        qualityWarnings: collectQualityWarnings(annotations),
      });
    }

    // ── 合成 + 章合并 ──
    for (let chapterIndex = 0; chapterIndex < orderedChapters.length; chapterIndex += 1) {
      await throwIfCancelled(input.signal, input.isCancelRequested);
      const chapter = orderedChapters[chapterIndex];
      const annotation = annotations.find((item) => item.chapterId === chapter.id);
      if (!annotation) {
        throw new AppError(`缺少章节标注：${chapter.id}`, 500);
      }

      const chapterWavPath = resolveChapterAudioPath(taskDir, chapter.id);
      if (isValidPcmWavFile(chapterWavPath)) {
        const chunks = expandSegmentsToChunkJobs(annotation.segments);
        completedChunks += chunks.length;
        chapterAudioPaths.push({
          chapterId: chapter.id,
          path: chapterWavPath,
          bytes: fs.statSync(chapterWavPath).size,
        });
        await input.onProgress({
          phase: "synthesizing",
          chapterIndex,
          chapterCount: orderedChapters.length,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          completedChapters: chapterIndex + 1,
          completedChunks,
          totalChunksEstimate,
          message: `跳过已完成第 ${chapter.order} 章音频`,
          chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
        });
        continue;
      }

      ensureChapterAudioDir(taskDir, chapter.id);
      const chunkJobs = expandSegmentsToChunkJobs(annotation.segments);
      const layoutFp = chunkLayoutFingerprint(chunkJobs);
      const prevFp = readChunkLayoutFingerprint(taskDir, chapter.id);
      if (prevFp && prevFp !== layoutFp) {
        // 布局变更（如 group_by_speaker 升级）时丢弃旧 chunk，避免 resume 错位
        wipeChapterAudioArtifacts(taskDir, chapter.id);
        ensureChapterAudioDir(taskDir, chapter.id);
      }
      if (chunkJobs.length === 0) {
        const silentPcm = createSilentPcm(50, 24_000, 1);
        const silent = buildWavBuffer(silentPcm, {
          numChannels: 1,
          sampleRate: 24_000,
          bitsPerSample: 16,
        });
        writeWavFileAtomic(chapterWavPath, silent);
        chapterAudioPaths.push({ chapterId: chapter.id, path: chapterWavPath, bytes: silent.length });
        continue;
      }

      const existing = listExistingChunkPaths(taskDir, chapter.id, chunkJobs.length);
      const nextChunkIndex = existing.length;

      for (let i = nextChunkIndex; i < chunkJobs.length; i += 1) {
        await throwIfCancelled(input.signal, input.isCancelRequested);
        const job = chunkJobs[i];
        await input.onProgress({
          phase: "synthesizing",
          chapterIndex,
          chapterCount: orderedChapters.length,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          completedChapters: chapterIndex,
          completedChunks: completedChunks + i,
          totalChunksEstimate,
          message: `合成第 ${chapter.order} 章 chunk ${i + 1}/${chunkJobs.length}（${job.segment.speakerLabel}）`,
          chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
        });

        const audioBuffer = await synthesizeChunkWithRetry({
          text: job.text,
          voice: job.segment.voice,
          style: job.segment.style,
          ttsMode: job.segment.ttsMode,
          designPrompt: job.segment.designPrompt,
          refAudioPath: job.segment.refAudioPath,
          provider: input.provider,
          signal: input.signal,
        });
        if (!isValidPcmWavBuffer(audioBuffer)) {
          throw new AppError(`MiMo TTS 返回了非法 WAV（chunk ${i}）。`, 502);
        }
        writeWavFileAtomic(resolveChunkAudioPath(taskDir, chapter.id, i), audioBuffer);
      }

      const allChunkPaths = chunkJobs.map((_, i) => resolveChunkAudioPath(taskDir, chapter.id, i));
      for (const chunkPath of allChunkPaths) {
        if (!isValidPcmWavFile(chunkPath)) {
          throw new AppError(`chunk 文件缺失或损坏：${chunkPath}`, 500);
        }
      }

      const chunkGapMs: number[] = [];
      for (let i = 0; i < chunkJobs.length - 1; i += 1) {
        const prevJob = chunkJobs[i];
        const nextJob = chunkJobs[i + 1];
        const prevRef: AudiobookChunkSpeakerRef = {
          speakerKey: speakerKeyFromSegment(prevJob.segment),
          speakerKind: prevJob.segment.speakerKind === "character" ? "character" : "narrator",
          text: prevJob.text,
        };
        const nextRef: AudiobookChunkSpeakerRef = {
          speakerKey: speakerKeyFromSegment(nextJob.segment),
          speakerKind: nextJob.segment.speakerKind === "character" ? "character" : "narrator",
          text: nextJob.text,
        };
        chunkGapMs.push(resolveInterChunkGapMs(prevRef, nextRef));
      }

      await input.onProgress({
        phase: "merging",
        chapterIndex,
        chapterCount: orderedChapters.length,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        completedChapters: chapterIndex,
        completedChunks: completedChunks + chunkJobs.length,
        totalChunksEstimate,
        message: `合并第 ${chapter.order} 章 WAV`,
        chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
      });

      const merged = concatWavFiles(allChunkPaths, chapterWavPath, chunkGapMs);
      writeChunkLayoutFingerprint(taskDir, chapter.id, layoutFp);
      completedChunks += chunkJobs.length;
      chapterAudioPaths.push({
        chapterId: chapter.id,
        path: chapterWavPath,
        bytes: merged.bytes,
      });

      await input.onProgress({
        phase: "synthesizing",
        chapterIndex,
        chapterCount: orderedChapters.length,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        completedChapters: chapterIndex + 1,
        completedChunks,
        totalChunksEstimate,
        message: `第 ${chapter.order} 章完成`,
        chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
      });
    }

    await throwIfCancelled(input.signal, input.isCancelRequested);

    const fullAudioPath = resolveFullBookAudioPath(taskDir);
    const chapterPathsOrdered = orderedChapters.map((chapter) => {
      const found = chapterAudioPaths.find((item) => item.chapterId === chapter.id);
      if (!found) {
        throw new AppError(`缺少章音频：${chapter.id}`, 500);
      }
      return found.path;
    });

    await input.onProgress({
      phase: "merging",
      chapterIndex: orderedChapters.length - 1,
      chapterCount: orderedChapters.length,
      chapterId: orderedChapters[orderedChapters.length - 1].id,
      chapterTitle: orderedChapters[orderedChapters.length - 1].title,
      completedChapters: orderedChapters.length,
      completedChunks,
      totalChunksEstimate,
      message: "合并全书 WAV",
      chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
    });

    const betweenChapterGaps = chapterPathsOrdered.length > 1
      ? Array.from({ length: chapterPathsOrdered.length - 1 }, () => resolveBetweenChapterGapMs())
      : [];
    concatWavFiles(chapterPathsOrdered, fullAudioPath, betweenChapterGaps);
    const qualityWarnings = collectQualityWarnings(annotations);

    await throwIfCancelled(input.signal, input.isCancelRequested);
    await input.onProgress({
      phase: "finalizing",
      chapterIndex: orderedChapters.length - 1,
      chapterCount: orderedChapters.length,
      chapterId: orderedChapters[orderedChapters.length - 1].id,
      chapterTitle: orderedChapters[orderedChapters.length - 1].title,
      completedChapters: orderedChapters.length,
      completedChunks,
      totalChunksEstimate,
      message: "封装 m4b（可选）",
      chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
      fullAudioPath,
      qualityWarnings,
    });

    const m4b = await encodeFullBookM4b({
      taskDir,
      bookTitle: input.novelTitle?.trim() || "有声书",
      sourceWavPath: fullAudioPath,
      betweenChapterGapMs: resolveBetweenChapterGapMs(),
      signal: input.signal,
      chapters: orderedChapters.map((chapter) => {
        const found = chapterAudioPaths.find((item) => item.chapterId === chapter.id);
        return {
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          chapterOrder: chapter.order,
          wavPath: found?.path ?? resolveChapterAudioPath(taskDir, chapter.id),
        };
      }),
    });

    await input.onProgress({
      phase: "finalizing",
      chapterIndex: orderedChapters.length - 1,
      chapterCount: orderedChapters.length,
      chapterId: orderedChapters[orderedChapters.length - 1].id,
      chapterTitle: orderedChapters[orderedChapters.length - 1].title,
      completedChapters: orderedChapters.length,
      completedChunks,
      totalChunksEstimate,
      message: qualityWarnings.length > 0
        ? `有声书合成完成（${qualityWarnings.length} 项警告）`
        : "有声书合成完成",
      annotations,
      chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
      fullAudioPath,
      qualityWarnings,
    });

    return {
      annotations,
      chapterAudioPaths,
      fullAudioPath,
      completedChapterCount: orderedChapters.length,
      completedChunks,
      outputDir: taskDir,
      qualityWarnings,
      m4b,
    };
  }
}

function isValidPcmWavBuffer(buffer: Buffer): boolean {
  try {
    if (buffer.length < 44) {
      return false;
    }
    const info = parseWavInfo(buffer);
    return info.dataSize >= 2 && buffer.length >= info.dataOffset + Math.min(info.dataSize, 2);
  } catch {
    return false;
  }
}

export const audiobookPipelineService = new AudiobookPipelineService();
export { PipelineCancelledError };
