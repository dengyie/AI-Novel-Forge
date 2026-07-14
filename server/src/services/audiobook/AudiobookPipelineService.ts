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
import { splitTextForTts } from "./audiobookChunk";
import {
  ensureAudiobookTaskDir,
  ensureChapterAudioDir,
  resolveChapterAudioPath,
  resolveChunkAudioPath,
  resolveFullBookAudioPath,
} from "./audiobookPaths";
import { concatWavFiles } from "./audiobookWav";
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
  annotations: AudiobookChapterAnnotation[];
  chapterAudioPaths: Array<{ chapterId: string; path: string }>;
  fullAudioPath?: string | null;
}

export interface RunAudiobookPipelineInput {
  taskId: string;
  novelId: string;
  chapterIds: string[];
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
  provider?: LLMProvider | null;
  model?: string | null;
  temperature?: number | null;
  /** 标注 LLM provider（与 TTS provider 可不同；缺省用 task.provider） */
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

function writeAnnotationFile(taskDir: string, annotation: AudiobookChapterAnnotation): void {
  const dir = path.join(taskDir, "annotations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(annotationPath(taskDir, annotation.chapterId), JSON.stringify(annotation, null, 2), "utf8");
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
    if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size < 44) {
      break;
    }
    paths.push(chunkPath);
  }
  return paths;
}

function expandSegmentsToChunks(segments: AudiobookDialogueSegment[]): Array<{
  segment: AudiobookDialogueSegment;
  text: string;
  globalChunkIndex: number;
}> {
  const items: Array<{ segment: AudiobookDialogueSegment; text: string; globalChunkIndex: number }> = [];
  let globalChunkIndex = 0;
  for (const segment of segments) {
    const pieces = splitTextForTts(segment.text);
    if (pieces.length === 0) {
      continue;
    }
    for (const text of pieces) {
      items.push({ segment, text, globalChunkIndex });
      globalChunkIndex += 1;
    }
  }
  return items;
}

async function synthesizeChunkWithRetry(input: {
  text: string;
  voice: string;
  style?: string | null;
  provider?: LLMProvider | null;
  signal?: AbortSignal;
  maxAttempts?: number;
}): Promise<Buffer> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await mimoChatAudioTTSProvider.synthesize({
        text: input.text,
        voice: input.voice,
        style: input.style,
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
          annotations: [...annotations],
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
        writeAnnotationFile(taskDir, annotation);
      }

      annotations.push(annotation);
      totalChunksEstimate += expandSegmentsToChunks(annotation.segments).length;

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
        annotations: [...annotations],
        chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
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
      if (fs.existsSync(chapterWavPath) && fs.statSync(chapterWavPath).size >= 44) {
        const chunks = expandSegmentsToChunks(annotation.segments);
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
          annotations,
          chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
        });
        continue;
      }

      ensureChapterAudioDir(taskDir, chapter.id);
      const chunkJobs = expandSegmentsToChunks(annotation.segments);
      if (chunkJobs.length === 0) {
        // 空章：写极短静音 WAV 占位（24k mono 16bit 约 50ms）
        const silent = Buffer.alloc(44 + 2400);
        silent.write("RIFF", 0, "ascii");
        silent.writeUInt32LE(36 + 2400, 4);
        silent.write("WAVE", 8, "ascii");
        silent.write("fmt ", 12, "ascii");
        silent.writeUInt32LE(16, 16);
        silent.writeUInt16LE(1, 20);
        silent.writeUInt16LE(1, 22);
        silent.writeUInt32LE(24_000, 24);
        silent.writeUInt32LE(48_000, 28);
        silent.writeUInt16LE(2, 32);
        silent.writeUInt16LE(16, 34);
        silent.write("data", 36, "ascii");
        silent.writeUInt32LE(2400, 40);
        fs.writeFileSync(chapterWavPath, silent);
        chapterAudioPaths.push({ chapterId: chapter.id, path: chapterWavPath, bytes: silent.length });
        continue;
      }

      const existing = listExistingChunkPaths(taskDir, chapter.id, chunkJobs.length);
      let nextChunkIndex = existing.length;

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
          annotations,
          chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
        });

        const audioBuffer = await synthesizeChunkWithRetry({
          text: job.text,
          voice: job.segment.voice,
          style: job.segment.style,
          provider: input.provider,
          signal: input.signal,
        });
        const chunkPath = resolveChunkAudioPath(taskDir, chapter.id, i);
        fs.writeFileSync(chunkPath, audioBuffer);
      }

      const allChunkPaths = chunkJobs.map((_, i) => resolveChunkAudioPath(taskDir, chapter.id, i));
      for (const chunkPath of allChunkPaths) {
        if (!fs.existsSync(chunkPath)) {
          throw new AppError(`chunk 文件缺失：${chunkPath}`, 500);
        }
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
        annotations,
        chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
      });

      const merged = concatWavFiles(allChunkPaths, chapterWavPath);
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
        annotations,
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
      annotations,
      chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
    });

    concatWavFiles(chapterPathsOrdered, fullAudioPath);

    await input.onProgress({
      phase: "finalizing",
      chapterIndex: orderedChapters.length - 1,
      chapterCount: orderedChapters.length,
      chapterId: orderedChapters[orderedChapters.length - 1].id,
      chapterTitle: orderedChapters[orderedChapters.length - 1].title,
      completedChapters: orderedChapters.length,
      completedChunks,
      totalChunksEstimate,
      message: "有声书合成完成",
      annotations,
      chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
      fullAudioPath,
    });

    return {
      annotations,
      chapterAudioPaths,
      fullAudioPath,
      completedChapterCount: orderedChapters.length,
      completedChunks,
      outputDir: taskDir,
    };
  }
}

export const audiobookPipelineService = new AudiobookPipelineService();
export { PipelineCancelledError };
