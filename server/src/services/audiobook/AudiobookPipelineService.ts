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
  normalizeAnnotationDiagnostics,
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
  ensureDirExistsUnderAudiobookRoot,
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
import { ensureAudiobookTtsTransportCacheWarm } from "../settings/AudiobookTtsTransportSettingsService";
import {
  hasEffectiveMimoTtsMultiEndpointChain,
  isMimoTtsEndpointChainExhaustedError,
} from "./MimoChatAudioTTSProvider";
import { getEngine } from "./engine/engineRegistry";
import type { SynthesisRequest } from "./engine/synthesisRequest";
import {
  buildChunkSynthesisRequest,
  compileDeliveryStyleForSegment,
} from "./frontend/synthesisBuilder";
import {
  applyDeliveryToSegment,
  fingerprintStyleParts,
  peelCompiledDeliveryMarks,
  resolveDeliveryStyleMode,
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

// M3: peelCompiledDeliveryMarks 已迁 `deliveryStyle.ts`（破 pipeline↔builder 互引环）。
// 保留 re-export 以维持旧 importer（含 audiobookSynthSotFingerprint / audiobookDeliveryPipeline /
// audiobookUnresolvedSpeaker 等单测 from dist）零改动。M5 删 peel 时连 re-export 一起清。
export { peelCompiledDeliveryMarks };

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
      // 与 synth SoT 一致：卡/旁白 base 先剥编译标记，避免指纹与 TTS 双路径
      const baseStyle = peelCompiledDeliveryMarks(input.narrator.style || null);
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
      const baseStyle = peelCompiledDeliveryMarks(input.narrator.style || null);
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
    const baseStyle = peelCompiledDeliveryMarks(
      (matched.ttsStyle ?? input.narrator.style) || null,
    );
    const baseDesignPrompt = peelCompiledDeliveryMarks(matched.ttsDesignPrompt ?? null);
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
      // 对账到真实角色卡后清除未匹配标记
      speakerUnresolved: false,
      unresolvedSpeakerName: null,
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
  /** 逐章生成进度快照（顺序与 chapterIds 一致）；纯展示，调用方写 progressJson 供前端逐章列表。 */
  chapterProgress?: Array<{
    chapterId: string;
    status: "pending" | "annotating" | "synthesizing" | "merging" | "ready" | "failed";
    completedChunks: number;
    totalChunks: number;
    detail?: string;
  }>;
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
  /** 已有的任务输出目录绝对路径（如父任务 outputDir）。
   * 传入则优先使用，跳过 `ensureAudiobookTaskDir(novelId, taskId)` 派生。
   * 续生成子任务传入父目录，章 wav 落父目录，父 reconcile 才能看见。 */
  outputDir?: string | null;
  /** 续生成子任务标记。为 true 时输出目录是**父任务共享目录**，
   * 跳过 finalize 全书 wav 合并 / m4b：子任务 chapterIds 是父章集子集，
   * 用 subset concat 覆写父 full-book.wav 会造成静默数据损坏（全书只剩子集章）。
   * 父任务在所有章 ready 后由 reconcileParent 重拼全书。 */
  isContinueChild?: boolean;
}

export interface RunAudiobookPipelineResult {
  annotations: AudiobookChapterAnnotation[];
  chapterAudioPaths: Array<{ chapterId: string; path: string; bytes: number }>;
  /** 全书 wav 路径；续生成子任务跳过全书合并，为 null（子不可覆写父 full-book）。 */
  fullAudioPath: string | null;
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
    return parsed
      .filter((item): item is AudiobookChapterAnnotation => {
        return Boolean(
          item
          && typeof item === "object"
          && typeof (item as AudiobookChapterAnnotation).chapterId === "string"
          && Array.isArray((item as AudiobookChapterAnnotation).segments),
        );
      })
      .map((item) => normalizeAnnotationDiagnostics(item));
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
    return normalizeAnnotationDiagnostics(parsed);
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
 * M6 灰度开关：`AUDIOBOOK_FP_V2=1` 开启指纹 v2（含 engine.fingerprintKey）。
 * 关闭（缺省）时指纹形态与旧完全一致——灰度期间既有任务 resume 仍 skip 正常。
 * 一次定后全量打开即可删除本开关与旧路径（见 doc §6 灰度策略）。
 */
export function isAudiobookFingerprintV2Enabled(): boolean {
  const raw = (process.env.AUDIOBOOK_FP_V2 ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * 章内 chunk 布局指纹。
 * D11：style + designPrompt 必须与 TTS 注入一致（compileDeliveryStyleForSegment SoT）；
 * 另含 refAudioPath 与全文 sha1，防 clone 换文件/正文中部改写仍 skip。
 *
 * M6（P-5）：开启 `AUDIOBOOK_FP_V2` 时追加 `engine.fingerprintKey(req)`（含 engineId + 按
 * mode 解析的 model 版本），消灭「换 model/换引擎不致缓存失效」。版本号 `v2:` 前缀写进指纹值，
 * 与旧裸 hash 天然字符串不等 → 旧 `chunk-layout.sha1` 一次性全章 miss、book 重合成一次，
 * 无需手动清。灰度由 env 控制；关闭时形态与旧完全一致（既有 fingerprint 稳定性测试零回归）。
 *
 * 写盘读取：`writeChunkLayoutFingerprint` 直接落本函数返回值（含 `v2:` 前缀时一并写入文件，
 * 兼当持久化版本标记）；`readChunkLayoutFingerprint` 仅 `.trim()`，原样比对。
 */
export function chunkLayoutFingerprint(
  jobs: Array<{ text: string; segment: AudiobookDialogueSegment }>,
): string {
  const fpV2 = isAudiobookFingerprintV2Enabled();
  const hash = createHash("sha1");
  if (fpV2) {
    // 版本号前缀：与旧裸 hash 字符串不等 → 旧缓存一次性全失效，自然重合成一次
    hash.update("v2:");
  }
  for (const job of jobs) {
    // 与 synthesize 同一 SoT（compileDeliveryStyleForSegment），避免缓存 style 与
    // peel/recompile 后注入漂移导致错误 skip/wipe
    const synth = compileDeliveryStyleForSegment(job.segment);
    const styleParts = fingerprintStyleParts({
      style: synth.style ?? "",
      designPrompt: synth.designPrompt ?? "",
    });
    const textHash = createHash("sha1").update(job.text).digest("hex").slice(0, 12);
    if (fpV2) {
      // P-5：进缓存的引擎身份（engineId + model 版本）。mode→model 映射在 MimoTtsEngine
      // 一处定义；换 model 或换第二引擎 → fingerprintKey 变 → 章 skip 正确失效。
      const req = buildChunkSynthesisRequest({
        segment: job.segment,
        text: job.text,
        provider: null,
      });
      hash.update(getEngine("mimo").fingerprintKey(req));
      hash.update("\0");
    }
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
 * @deprecated M3: 逻辑已搬至 `synthesisBuilder.compileDeliveryStyleForSegment`。
 * 此处保留为薄别名，供旧 importer（含 audiobookSynthSotFingerprint / audiobookUnresolvedSpeaker
 * 等单测 `from dist`）零改动并可行 golden 对照；M4/M5 稳定后连同 re-export 一并删除。
 *
 * - 无 delivery：只用干净 base（剥编译标记），不盲信缓存 style/design
 * - 有 delivery：旁白/角色均以干净 base + delivery 重 compile
 */
export function resolveChunkSynthesizeFields(segment: AudiobookDialogueSegment): {
  style: string | null;
  designPrompt: string | null;
} {
  return compileDeliveryStyleForSegment(segment);
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
    if (annotation.assemblyNote?.trim()) {
      warnings.push(`第 ${annotation.chapterOrder} 章：${annotation.assemblyNote.trim()}`);
    }
    if (annotation.contentTruncated) {
      warnings.push(`第 ${annotation.chapterOrder} 章：正文超窗且未分块覆盖，标注可能不全`);
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

/** 外层合成重试次数：有效多端点链时默认 1，否则 3；显式 maxAttempts 优先。 */
export function resolveSynthesizeChunkMaxAttempts(maxAttempts?: number): number {
  const defaultAttempts = hasEffectiveMimoTtsMultiEndpointChain() ? 1 : 3;
  return Math.max(1, maxAttempts ?? defaultAttempts);
}

/**
 * @internal 导出供门禁单测；生产仅 pipeline 调用。
 *
 * M3: 形参从「散字段 + provider」收敛为单个 `SynthesisRequest`（由 SynthesisBuilder 一次编译）。
 * 重试语义、warm cache、状态码分流、chain-exhausted 短路与旧实现逐字节等价。
 */
export async function synthesizeChunkWithRetry(input: {
  req: SynthesisRequest;
  signal?: AbortSignal;
  maxAttempts?: number;
}): Promise<Buffer> {
  // 有效多端点时 provider 内已走完整链；外层默认 1，避免 chain×N。
  // 仅 primary（含 FALLBACK 与 primary 去重后仍单端）保留短暂 5xx/504 重试（默认 3）。
  // 先 warm 运输缓存，避免 cold probe 仍按 openai primary 误判 multi-endpoint。
  if (input.maxAttempts == null) {
    try {
      await ensureAudiobookTtsTransportCacheWarm();
    } catch {
      // warm 失败时退回 env/cache probe，不阻断合成
    }
  }
  const maxAttempts = resolveSynthesizeChunkMaxAttempts(input.maxAttempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const synth = await getEngine("mimo").synthesize(input.req, { signal: input.signal });
      return synth.audio;
    } catch (error) {
      lastError = error;
      if (input.signal?.aborted) {
        throw error;
      }
      // 400 客户端错误、408 取消：不重试；401/403 鉴权也不重试
      if (
        error instanceof AppError
        && (error.statusCode === 400
          || error.statusCode === 401
          || error.statusCode === 403
          || error.statusCode === 408)
      ) {
        throw error;
      }
      // provider 已耗尽多端点链：禁止外层再整链放大
      if (isMimoTtsEndpointChainExhaustedError(error)) {
        throw error;
      }
      // 504 超时、502 上游：可重试（仅 primary-only 默认路径）
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
    const inheritedDir = input.outputDir?.trim();
    let taskDir: string;
    try {
      taskDir = inheritedDir
        ? ensureDirExistsUnderAudiobookRoot(inheritedDir)
        : ensureAudiobookTaskDir(input.novelId, input.taskId);
    } catch (error) {
      // 不做 fail-open：无法写入给定的父目录属硬性环境错误，应中断。
      if (error instanceof Error) {
        throw new Error(
          `有声书任务输出目录无法创建：${error.message}`,
        );
      }
      throw error;
    }
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
    const chapterProgress = orderedChapters.map((chapter) => ({
      chapterId: chapter.id,
      status: "pending" as "pending" | "annotating" | "synthesizing" | "merging" | "ready" | "failed",
      completedChunks: 0,
      totalChunks: 0,
      detail: undefined as string | undefined,
    }));
    // 快照副本（深拷 entry，避免后续就地 mutate 污染已发出的历史快照）
    const snapshotChapterProgress = (): typeof chapterProgress =>
      chapterProgress.map((entry) => ({ ...entry }));

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
        chapterProgress[chapterIndex].status = "annotating";
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
          chapterProgress: snapshotChapterProgress(),
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
      chapterProgress[chapterIndex].status = "annotating";
      chapterProgress[chapterIndex].totalChunks = expandSegmentsToChunkJobs(estimateReconcile.segments).length;

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
        chapterProgress: snapshotChapterProgress(),
      });

      // ── 合成 + 章合并（逐章：标注完即合成该章，chapter.wav 提前落盘供前端逐章交付）──
      await throwIfCancelled(input.signal, input.isCancelRequested);

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
        // orphan 是 cast 降级诊断，不进 error（避免旧逻辑/UI 当成硬失败旁白回退）
        assemblyNote: orphanNote
          ? [annotation.assemblyNote?.trim(), orphanNote].filter(Boolean).join("；")
          : annotation.assemblyNote,
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
        chapterProgress[chapterIndex].status = "ready";
        chapterProgress[chapterIndex].completedChunks = chunkJobsPreview.length;
        chapterProgress[chapterIndex].totalChunks = chunkJobsPreview.length;
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
          chapterProgress: snapshotChapterProgress(),
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
        chapterProgress[chapterIndex].status = "ready";
        chapterProgress[chapterIndex].completedChunks = 0;
        chapterProgress[chapterIndex].totalChunks = 0;
        continue;
      }

      // F1：在 chunk 合成前先落布局指纹。否则合成中途崩溃 resume 时 prevFp 为空，
      // 上面的 wipe 分支会清掉已完成的 chunk，续跑逻辑（listExistingChunkPaths）失效。
      // 指纹已在 wipe/ensureChapterAudioDir 后写入，chapter.wav 尚不存在时不会被上面的
      // skip 分支误跳过（isValidPcmWavFile 为 false），仅保留 chunk 续跑。
      writeChunkLayoutFingerprint(taskDir, chapter.id, layoutFp);

      const existing = listExistingChunkPaths(taskDir, chapter.id, chunkJobs.length);
      const nextChunkIndex = existing.length;

      for (let i = nextChunkIndex; i < chunkJobs.length; i += 1) {
        await throwIfCancelled(input.signal, input.isCancelRequested);
        const job = chunkJobs[i];
        chapterProgress[chapterIndex].status = "synthesizing";
        chapterProgress[chapterIndex].completedChunks = i;
        chapterProgress[chapterIndex].totalChunks = chunkJobs.length;
        chapterProgress[chapterIndex].detail = `${job.segment.speakerLabel} ${nextChunkIndex > 0 ? `续跑 ${nextChunkIndex}/` : ""}${i + 1}/${chunkJobs.length}`;
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
          chapterProgress: snapshotChapterProgress(),
        });

        // M3: SynthesisBuilder 一次编译 delivery，产出 SynthesisRequest；retry wrapper 直接消费。
        // golden 等价于旧 resolveChunkSynthesizeFields(job.segment) → synthesizeChunkWithRetry(扁平字段)
        const req = buildChunkSynthesisRequest({
          segment: job.segment,
          text: job.text,
          provider: input.provider ?? null,
        });
        const audioBuffer = await synthesizeChunkWithRetry({
          req,
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
        chapterProgress: (() => {
          chapterProgress[chapterIndex].status = "merging";
          chapterProgress[chapterIndex].completedChunks = chunkJobs.length;
          return snapshotChapterProgress();
        })(),
      });

      const merged = concatWavFiles(allChunkPaths, chapterWavPath, chunkGapMs);
      // F1：布局指纹已在 chunk 合成前写入，此处无需重复；保留注释以明确原子化边界。
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
        chapterProgress: (() => {
          chapterProgress[chapterIndex].status = "ready";
          chapterProgress[chapterIndex].completedChunks = chunkJobs.length;
          chapterProgress[chapterIndex].totalChunks = chunkJobs.length;
          chapterProgress[chapterIndex].detail = undefined;
          return snapshotChapterProgress();
        })(),
      });
    }

    await throwIfCancelled(input.signal, input.isCancelRequested);

    // 续生成子任务：输出目录是父任务共享目录，chapterIds 是父章集子集。
    // 跳过全书合并/m4b：用 subset concat 覆写父 full-book.wav 是静默数据损坏
    // （全书只剩子集章）。父全章 ready 后由 reconcileParent 重拼全书。
    const isContinueChild = Boolean(input.isContinueChild);
    const qualityWarnings = collectQualityWarnings(annotations);
    if (isContinueChild) {
      await input.onProgress({
        phase: "finalizing",
        chapterIndex: orderedChapters.length - 1,
        chapterCount: orderedChapters.length,
        chapterId: orderedChapters[orderedChapters.length - 1].id,
        chapterTitle: orderedChapters[orderedChapters.length - 1].title,
        completedChapters: orderedChapters.length,
        completedChunks,
        totalChunksEstimate,
        message: "续生成章完成，全书合并由父任务接管",
        annotations,
        chapterAudioPaths: chapterAudioPaths.map((item) => ({ chapterId: item.chapterId, path: item.path })),
        fullAudioPath: undefined,
        qualityWarnings,
        chapterProgress: snapshotChapterProgress(),
      });
      return {
        annotations,
        chapterAudioPaths,
        fullAudioPath: null,
        completedChapterCount: orderedChapters.length,
        completedChunks,
        outputDir: taskDir,
        qualityWarnings,
        m4b: { status: "skipped", path: null, relativePath: null, reason: "continue-child" },
      };
    }

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
      chapterProgress: snapshotChapterProgress(),
    });

    const betweenChapterGaps = chapterPathsOrdered.length > 1
      ? Array.from({ length: chapterPathsOrdered.length - 1 }, () => resolveBetweenChapterGapMs())
      : [];
    concatWavFiles(chapterPathsOrdered, fullAudioPath, betweenChapterGaps);

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
      chapterProgress: snapshotChapterProgress(),
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
      chapterProgress: snapshotChapterProgress(),
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
