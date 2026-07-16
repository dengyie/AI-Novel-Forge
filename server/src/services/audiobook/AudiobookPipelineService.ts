import fs from "node:fs";
import path from "node:path";
import type {
  AudiobookChapterAnnotation,
  AudiobookCharacterVoiceConfig,
  AudiobookDialogueSegment,
  AudiobookNarratorConfig,
  DeliveryStyleMode,
} from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import {
  audiobookAnnotationService,
  hashAudiobookChapterContent,
} from "./AudiobookAnnotationService";
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
import {
  applyDeliveryToSegment,
  fingerprintStyleParts,
  resolveDeliveryStyleMode,
  resolveSynthesizeInput,
  shouldApplyDelivery,
} from "./deliveryStyle";

/**
 * resume 是否应丢弃缓存标注并 reannotate。
 * - mode 戳与任务不一致
 * - 正文 contentSha1 缺失或与当前章不一致（防改稿后盲用旧音）
 * - 任务 off 且旧标注无 mode 戳却仍带 delivery（防脏 SoT 透传）
 */
export function shouldInvalidateCachedAnnotation(input: {
  annotation: AudiobookChapterAnnotation | null | undefined;
  deliveryStyleMode: DeliveryStyleMode;
  chapterContent: string | null | undefined;
}): boolean {
  const annotation = input.annotation;
  if (!annotation || annotation.segments.length === 0) {
    return true;
  }

  const cachedMode = annotation.deliveryStyleMode;
  if (cachedMode != null && cachedMode !== input.deliveryStyleMode) {
    return true;
  }

  // 旧标注无 mode 戳 + 任务 off + 段上仍有 delivery → 强制重标，避免合成透传表演
  if (
    cachedMode == null
    && input.deliveryStyleMode === "off"
    && annotation.segments.some((seg) => Boolean(seg.delivery))
  ) {
    return true;
  }

  const currentSha = hashAudiobookChapterContent(input.chapterContent);
  const cachedSha = annotation.contentSha1?.trim() || "";
  // 缺指纹或与当前正文不一致 → 失效（新写出必带 sha；缺戳旧任务 resume 重标一次）
  if (!cachedSha || cachedSha !== currentSha) {
    return true;
  }

  return false;
}

export type ReconcileAnnotationSegmentsResult = {
  segments: AudiobookDialogueSegment[];
  /** 标注仍挂 characterId 但当前角色表已无该卡 → 已强制旁白回退 */
  orphanCharacterIds: string[];
  orphanSpeakerLabels: string[];
};

/**
 * 剥除已编译的表演/叙述/指令行，避免缺 baseStyle 时把「本句表演」再当 base 二次编译。
 */
export function peelCompiledDeliveryMarks(value: string | null | undefined): string | null {
  if (value == null) return null;
  const raw = String(value);
  if (
    !raw.includes("本句表演：")
    && !raw.includes("本句叙述：")
    && !raw.includes("表演指令：")
    && !raw.includes("保持该角色声线与身份一致")
  ) {
    const trimmed = raw.trim();
    return trimmed || null;
  }
  const cleaned = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith("本句表演：") || line.startsWith("本句叙述：") || line.startsWith("表演指令：")) {
        return false;
      }
      if (line.includes("保持该角色声线与身份一致")) {
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
  return cleaned || null;
}

/**
 * 合成前用任务当前 characterVoices / narrator 覆盖段绑定。
 * 标注冻结 speaker/text/delivery；音色/mode/ref/base 以卡为准，有 delivery 则按 base 重 apply。
 * 改卡后 resume 不必 reannotate 也能换声线（layout fingerprint 会变）。
 * 角色卡已删除：强制旁白 + 登记 orphan（禁止 silent 继续用旧 clone/脏 voice）。
 */
export function reconcileAnnotationSegmentsWithVoices(
  segments: AudiobookDialogueSegment[],
  input: {
    characterVoices: AudiobookCharacterVoiceConfig[];
    narrator: AudiobookNarratorConfig;
    deliveryStyleMode: DeliveryStyleMode;
  },
): ReconcileAnnotationSegmentsResult {
  const byId = new Map(
    input.characterVoices.map((item) => [item.characterId, item] as const),
  );
  const mode = resolveDeliveryStyleMode(input.deliveryStyleMode);
  const orphanCharacterIds: string[] = [];
  const orphanSpeakerLabels: string[] = [];
  const orphanSeen = new Set<string>();

  const nextSegments = segments.map((seg) => {
    if (seg.speakerKind === "narrator" || !seg.characterId) {
      const baseStyle = input.narrator.style || null;
      const base: AudiobookDialogueSegment = {
        ...seg,
        speakerKind: "narrator",
        characterId: null,
        ttsMode: "preset",
        voice: input.narrator.voice,
        refAudioPath: null,
        baseStyle,
        baseDesignPrompt: null,
        style: baseStyle,
        designPrompt: null,
      };
      if (seg.delivery && shouldApplyDelivery(mode, "narrator")) {
        return applyDeliveryToSegment(base, seg.delivery, {
          deliveryStyleMode: mode,
          baseStyle,
          baseDesignPrompt: null,
        });
      }
      return applyDeliveryToSegment(base, null, {
        deliveryStyleMode: "off",
        baseStyle,
        baseDesignPrompt: null,
      });
    }

    const matched = byId.get(seg.characterId);
    if (!matched) {
      // 角色卡已移除：禁止沿用旧 voice/ref；强制旁白并记录 orphan
      if (!orphanSeen.has(seg.characterId)) {
        orphanSeen.add(seg.characterId);
        orphanCharacterIds.push(seg.characterId);
        orphanSpeakerLabels.push(seg.speakerLabel || seg.characterId);
      }
      const baseStyle = input.narrator.style || null;
      const base: AudiobookDialogueSegment = {
        ...seg,
        speakerKind: "narrator",
        characterId: null,
        speakerLabel: "旁白",
        ttsMode: "preset",
        voice: input.narrator.voice,
        refAudioPath: null,
        baseStyle,
        baseDesignPrompt: null,
        style: baseStyle,
        designPrompt: null,
        // 身份丢失时不保留角色表演，避免旁白串戏
        delivery: null,
        deliveryMergeKey: "none",
      };
      return applyDeliveryToSegment(base, null, {
        deliveryStyleMode: "off",
        baseStyle,
        baseDesignPrompt: null,
      });
    }

    const rawMode = matched.ttsMode?.trim() || "preset";
    const ttsMode = rawMode === "design" || rawMode === "clone" ? rawMode : "preset";
    const baseStyle = (matched.ttsStyle ?? input.narrator.style) || null;
    const baseDesignPrompt = matched.ttsDesignPrompt ?? null;
    const base: AudiobookDialogueSegment = {
      ...seg,
      speakerKind: "character",
      characterId: matched.characterId,
      speakerLabel: matched.characterName || seg.speakerLabel,
      ttsMode,
      voice: matched.ttsVoice?.trim() || "",
      refAudioPath: matched.ttsRefAudioPath ?? null,
      baseStyle,
      baseDesignPrompt,
      style: baseStyle,
      designPrompt: baseDesignPrompt,
    };

    if (seg.delivery && shouldApplyDelivery(mode, "character")) {
      return applyDeliveryToSegment(base, seg.delivery, {
        deliveryStyleMode: mode,
        baseStyle,
        baseDesignPrompt,
      });
    }
    return applyDeliveryToSegment(base, null, {
      deliveryStyleMode: "off",
      baseStyle,
      baseDesignPrompt,
    });
  });

  return {
    segments: nextSegments,
    orphanCharacterIds,
    orphanSpeakerLabels,
  };
}

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
  /** 段级表演模式；缺省 resolve → off */
  deliveryStyleMode?: DeliveryStyleMode | null;
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


/**
 * 章内 chunk 布局指纹。
 * D11：style + designPrompt；另含 refAudioPath 与全文 sha1，防 clone 换文件/正文中部改写仍 skip。
 */
export function chunkLayoutFingerprint(
  jobs: Array<{ text: string; segment: AudiobookDialogueSegment }>,
): string {
  const hash = createHash("sha1");
  for (const job of jobs) {
    const styleParts = fingerprintStyleParts(job.segment);
    const textHash = createHash("sha1").update(job.text).digest("hex").slice(0, 12);
    hash.update(speakerKeyFromSegment(job.segment));
    hash.update("\0");
    hash.update(job.segment.ttsMode ?? "preset");
    hash.update("\0");
    hash.update(job.segment.voice ?? "");
    hash.update("\0");
    hash.update((job.segment.refAudioPath ?? "").trim());
    hash.update("\0");
    hash.update(styleParts.style);
    hash.update("\0");
    hash.update(styleParts.designPrompt);
    hash.update("\0");
    hash.update(String(job.text.length));
    hash.update("\0");
    hash.update(textHash);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * 合成前唯一解析 style/designPrompt（SoT = base* + delivery）。
 * - 无 delivery：只用干净 base（剥编译标记），不盲信缓存 style/design
 * - 有 delivery：旁白/角色均以干净 base + delivery 重 compile
 */
export function resolveChunkSynthesizeFields(segment: AudiobookDialogueSegment): {
  style?: string | null;
  designPrompt?: string | null;
} {
  const styleRaw = typeof segment.style === "string" ? segment.style : "";
  const designRaw = typeof segment.designPrompt === "string" ? segment.designPrompt : "";
  const dirtyStyle = styleRaw.includes("本句表演：")
    || styleRaw.includes("本句叙述：")
    || styleRaw.includes("表演指令：");
  const dirtyDesign = designRaw.includes("表演指令：");

  const baseStyleClean = peelCompiledDeliveryMarks(segment.baseStyle)
    ?? (dirtyStyle
      ? peelCompiledDeliveryMarks(segment.style)
      : (segment.baseStyle ?? segment.style ?? null));
  const baseDesignClean = peelCompiledDeliveryMarks(segment.baseDesignPrompt)
    ?? (dirtyDesign
      ? peelCompiledDeliveryMarks(segment.designPrompt)
      : (segment.baseDesignPrompt ?? segment.designPrompt ?? null));

  if (!segment.delivery) {
    return {
      style: baseStyleClean,
      designPrompt: baseDesignClean,
    };
  }

  if (segment.speakerKind === "narrator") {
    const rebuilt = applyDeliveryToSegment(
      {
        ...segment,
        style: baseStyleClean,
        designPrompt: baseDesignClean,
      },
      segment.delivery,
      {
        deliveryStyleMode: "all",
        baseStyle: baseStyleClean,
        baseDesignPrompt: baseDesignClean,
      },
    );
    return {
      style: rebuilt.style,
      designPrompt: rebuilt.designPrompt,
    };
  }

  return resolveSynthesizeInput({
    ttsMode: segment.ttsMode,
    baseStyle: baseStyleClean,
    baseDesignPrompt: baseDesignClean,
    style: baseStyleClean,
    designPrompt: baseDesignClean,
    delivery: segment.delivery,
    text: segment.text,
  });
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
    if (annotation.contentTruncated) {
      warnings.push(`第 ${annotation.chapterOrder} 章：正文超 28k，标注仅见前部`);
    }
    const stats = annotation.deliveryStats;
    if (stats && stats.deliveryPeeled > 0) {
      warnings.push(
        `第 ${annotation.chapterOrder} 章：剥除 ${stats.deliveryPeeled} 段坏表演（已回退静态 style）`,
      );
    }
    if (stats && stats.mergeChunkMultiplier != null && stats.mergeChunkMultiplier > 1.8) {
      warnings.push(
        `第 ${annotation.chapterOrder} 章：chunk 倍率 ${stats.mergeChunkMultiplier}（表演分桶偏碎）`,
      );
    }
    const unresolved = stats?.unresolvedSpeakerCount ?? 0;
    if (unresolved > 0) {
      const names = (stats?.unresolvedSpeakerNames ?? []).filter(Boolean);
      const nameHint = names.length
        ? `：${names.slice(0, 6).join("、")}${names.length > 6 ? "…" : ""}`
        : "";
      warnings.push(
        `第 ${annotation.chapterOrder} 章：${unresolved} 段角色名未匹配卡表已用旁白音色${nameHint}（请补 speaker 别名后重标）`,
      );
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
    const deliveryStyleMode = resolveDeliveryStyleMode(input.deliveryStyleMode ?? null);
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

      // 无段 / 空段 / mode 不一致 / 正文漂移 / 旧脏 delivery → 重标（防 resume 盲用旧音）
      const shouldReannotate = shouldInvalidateCachedAnnotation({
        annotation,
        deliveryStyleMode,
        chapterContent: chapter.content ?? "",
      });
      if (shouldReannotate) {
        if (annotation && annotation.segments.length > 0) {
          wipeChapterAudioArtifacts(taskDir, chapter.id);
        }
        await input.onProgress({
          phase: "annotating",
          chapterIndex,
          chapterCount: orderedChapters.length,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          completedChapters: chapterIndex,
          completedChunks,
          totalChunksEstimate,
          message: annotation && annotation.segments.length > 0
            ? `标注缓存失效，重标第 ${chapter.order} 章：${chapter.title}`
            : `标注第 ${chapter.order} 章：${chapter.title}`,
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
          deliveryStyleMode,
        });
        writeAnnotationFileSafe(taskDir, annotation);
      }

      if (!annotation || annotation.segments.length === 0) {
        throw new AppError(`章节标注失败：${chapter.id}`, 500);
      }

      annotations.push(annotation);
      // 与合成侧同一套 reconcile→expand，避免改卡后进度分母偏离实际 chunk 数
      const estimateReconcile = reconcileAnnotationSegmentsWithVoices(annotation.segments, {
        characterVoices: input.characterVoices,
        narrator: input.narrator,
        deliveryStyleMode,
      });
      totalChunksEstimate += expandSegmentsToChunkJobs(estimateReconcile.segments).length;

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
      // 合成侧对账：标注保留 speaker/text/delivery；绑定以当前角色卡为准
      const reconcileResult = reconcileAnnotationSegmentsWithVoices(
        annotation.segments,
        {
          characterVoices: input.characterVoices,
          narrator: input.narrator,
          deliveryStyleMode,
        },
      );
      const reconciledSegments = reconcileResult.segments;
      // 写回对账后的绑定视图（UI/annotationsJson 与真实合成一致）；orphan 记入 qualityWarnings
      const orphanNote = reconcileResult.orphanSpeakerLabels.length > 0
        ? `角色卡缺失已回退旁白：${reconcileResult.orphanSpeakerLabels.slice(0, 6).join("、")}${
          reconcileResult.orphanSpeakerLabels.length > 6
            ? ` 等 ${reconcileResult.orphanSpeakerLabels.length} 人`
            : ""
        }`
        : null;
      const annotationForPersist: AudiobookChapterAnnotation = {
        ...annotation,
        segments: reconciledSegments,
        error: orphanNote
          ? [annotation.error?.trim(), orphanNote].filter(Boolean).join("；")
          : annotation.error,
      };
      const annotationIndex = annotations.findIndex((item) => item.chapterId === chapter.id);
      if (annotationIndex >= 0) {
        annotations[annotationIndex] = annotationForPersist;
      }
      writeAnnotationFileSafe(taskDir, annotationForPersist);

      const chunkJobsPreview = expandSegmentsToChunkJobs(reconciledSegments);
      const layoutFp = chunkLayoutFingerprint(chunkJobsPreview);
      const prevFp = readChunkLayoutFingerprint(taskDir, chapter.id);
      // 章 wav 存在也必须对照指纹；不一致则 wipe 后重合成（防改 annotation 后 resume 复用旧音）
      if (isValidPcmWavFile(chapterWavPath) && prevFp && prevFp === layoutFp) {
        completedChunks += chunkJobsPreview.length;
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
          qualityWarnings: collectQualityWarnings(annotations),
        });
        continue;
      }

      // 指纹缺失/不一致：wipe 一次后重来；指纹一致仅缺 chapter.wav 时保留 chunk 续跑
      if (!prevFp || prevFp !== layoutFp) {
        wipeChapterAudioArtifacts(taskDir, chapter.id);
      }

      ensureChapterAudioDir(taskDir, chapter.id);
      const chunkJobs = chunkJobsPreview;
      if (chunkJobs.length === 0) {
        const silentPcm = createSilentPcm(50, 24_000, 1);
        const silent = buildWavBuffer(silentPcm, {
          numChannels: 1,
          sampleRate: 24_000,
          bitsPerSample: 16,
        });
        writeWavFileAtomic(chapterWavPath, silent);
        // 空作业也写布局指纹，避免 resume 反复 wipe 静音章
        writeChunkLayoutFingerprint(taskDir, chapter.id, layoutFp);
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

        const synth = resolveChunkSynthesizeFields(job.segment);
        const audioBuffer = await synthesizeChunkWithRetry({
          text: job.text,
          voice: job.segment.voice,
          style: synth.style,
          ttsMode: job.segment.ttsMode,
          designPrompt: synth.designPrompt,
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
