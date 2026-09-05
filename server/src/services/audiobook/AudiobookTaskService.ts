import fs from "node:fs";
import type {
  AudiobookChapterAnnotation,
  AudiobookChapterReprocessMode,
  AudiobookQualityFlag,
  AudiobookTaskAnnotationsView,
  AudiobookTaskDetail,
  AudiobookTaskSummary,
  ContinueAudiobookTaskInput,
  CreateAudiobookTaskInput,
  DeliveryStyleMode,
} from "@ai-novel/shared/types/audiobook";
import { isMimoTtsPresetVoice } from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { toTaskTokenUsageSummary } from "../task/taskTokenUsageSummary";
import type { TaskCancelSource } from "../task/taskSupport";
import { isMissingAudiobookTaskTableError } from "./audiobookErrors";
import { parseSpeakerAliases } from "./audiobookSpeakerAliases";
export { parseSpeakerAliases } from "./audiobookSpeakerAliases";
import { audiobookPrecheckService } from "./AudiobookPrecheckService";
import {
  audiobookPipelineService,
  PipelineCancelledError,
} from "./AudiobookPipelineService";
import {
  ensureAudiobookTaskDir,
  hasInFlightM4bPart,
  isChapterAudioReady,
  isFullBookAudioReady,
  isFullBookM4bReady,
  listReadyChapterAudioIds,
  pruneChunkWavArtifacts,
  resolveAudiobookTaskDir,
  resolveChapterAudioPath,
  resolveFullBookAudioPath,
  resolveFullBookM4bPath,
  wipeChapterAnnotationArtifact,
  wipeChapterAudioArtifacts,
} from "./audiobookPaths";
import { resolveBetweenChapterGapMs } from "./audiobookGap";
import { encodeFullBookM4b, withAudiobookTaskDirArtifactLock } from "./audiobookM4b";
import { concatWavFiles } from "./audiobookWav";
import { resolveDeliveryStyleMode } from "./deliveryStyle";
import { BackgroundM4bSettleRetry } from "./application/BackgroundM4bSettleRetry";
import {
  prepareContinueArtifacts,
  projectContinuePreparationEnvelope,
  readContinuePreparationIntent,
  withContinuePreparationFailure,
} from "./application/continue/AudiobookContinuePreparation";
import {
  M4B_DONE_LABEL,
  M4B_ENCODING_LABEL,
  m4bGenerationWhere,
  markM4bEncodingInResultJson,
  mergeM4bIntoResultJson,
  newM4bGenerationToken,
  readBackgroundM4bState,
  readTerminalM4bState,
  removeM4bFromResultJson,
  type BackgroundM4bState,
} from "./application/m4b/M4bTaskProjection";
export {
  readBackgroundM4bState,
  type BackgroundM4bState,
} from "./application/m4b/M4bTaskProjection";
import {
  readReprocessIntent,
  withReprocessIntent,
  type AudiobookReprocessIntent,
} from "./application/reprocess/AudiobookReprocessIntent";
import {
  captureOrphanM4bProcessSnapshot,
  killOrphanM4bFfmpeg,
  selectOrphanM4bPids,
} from "./infrastructure/m4b-recovery/OrphanM4bProcessCleaner";
export {
  captureOrphanM4bProcessSnapshot,
  killOrphanM4bFfmpeg,
  selectOrphanM4bPids,
} from "./infrastructure/m4b-recovery/OrphanM4bProcessCleaner";
import { checkVoiceRefAudioPath } from "./voiceRefPath";
import { resolveEffectiveCloneRefPath, tryResolveEffectiveCloneRefPath } from "./voiceLibraryService";
import {
  buildQualityCompletionLabel,
  collectTaskQualityFlags,
  isWholeChapterNarratorFallback,
} from "./diarize/diarizeQualityGate";

const AUDIOBOOK_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.AUDIOBOOK_TASK_HEARTBEAT_INTERVAL_MS ?? 10_000) || 10_000,
);

/**
 * 运行期 watchdog：周期扫 status=running 任务，对比「推进信号」跨周期。
 * 心跳（startTaskHeartbeat）只刷 heartbeatAt、与是否真推进解耦——卡死任务
 * 心跳照活、PatrolAgent P1 判据 ` heartbeat > 30min` 永不命中。watchdog
 * 比较 (progress/stage/itemKey/completedChapters/completedChunks) 五元组，
 * 连续 stallPeriods 个周期无变化即 CAS markFailedIfRunning，把假 running 翻终态。
 */
const AUDIOBOOK_WATCHDOG_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.AUDIOBOOK_WATCHDOG_INTERVAL_MS ?? 60_000) || 60_000,
);
const AUDIOBOOK_WATCHDOG_STALL_PERIODS = Math.max(
  2,
  Number(process.env.AUDIOBOOK_WATCHDOG_STALL_PERIODS ?? 10) || 10,
);

/**
 * finalizing / m4b 封装期的容忍周期数。
 *
 * 现在 status=running + currentStage="finalizing" 的任务是单次长时 ffmpeg（大书 m4b 封装
 * 数分钟至十几分钟）。progress=98 已越过合并门槛，且 m4b 封装期间 onProgress 只写
 * 五元组里的 progress 递增、其它字段不再变化——固定 stallPeriods=10 时 60s×10=10min 不到
 * 就会误杀。R2-2 宽限到 40 周期（60s×40=40min），并配合 m4b `.part` 增长心跳兜底。
 * env `AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS` 可调。
 */
export const AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS = Math.max(
  2,
  Number(process.env.AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS ?? 40) || 40,
);

/**
 * 是否该行的 watchdog 对 finalizing/m4b 编码放宽容忍（纯函数，无 fs 依赖）。
 *
 * 宽松判据：
 * - `currentStage === "finalizing" && progress >= 98`：已越过合并进入封装期
 * - 或 `m4bEncoding` 置真：调用方把「`full-book.m4b.part` 存在」的磁盘判定传入。
 *
 * 这里把「宽限容忍」整体做在**决策层**：命中该分支时 stallPeriods 放宽到
 * AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS（默认 40），60s×40=40min 内不误杀。
 */
export function isWatchdogFinalizingTolerant(input: {
  currentStage: string | null;
  progress: number | null;
  /** ffmpeg 正在写盘：调用方将磁盘探测结果传入 */
  m4bEncodingOnDisk?: boolean;
}): boolean {
  const { currentStage, progress } = input;
  if (currentStage === "finalizing" && typeof progress === "number" && progress >= 98) {
    return true;
  }
  if (input.m4bEncodingOnDisk === true) {
    return true;
  }
  return false;
}

const DEFAULT_MAX_RETRIES = 3;

/** listByNovel 可见条数上限（API take 钳制后）。 */
const LIST_BY_NOVEL_VISIBLE_MAX = 100;
/** 单页扫描条数：迭代分页直到凑满 visible 或扫尽。 */
const LIST_BY_NOVEL_PAGE_SIZE = 200;
/** 单次 listByNovel 最多扫描行数（防失控扫库）。 */
const LIST_BY_NOVEL_SCAN_CAP = 5000;

/**
 * 单页扫描条数（可见 limit 的预取窗口）。
 * 真正凑满靠 listByNovel 游标迭代，不再用单次 500 封顶赌密度。
 */
export function listByNovelFetchTake(visibleLimit: number): number {
  const limit = Math.max(1, Math.min(LIST_BY_NOVEL_VISIBLE_MAX, Math.floor(visibleLimit) || 1));
  return Math.min(LIST_BY_NOVEL_PAGE_SIZE, Math.max(limit * 5, limit + 50));
}

/**
 * 从按 updatedAt/id 降序的行流中滤隐闭子，凑满 visibleLimit。
 * 纯函数便于单测；调用方负责分页推进 cursor。
 */
export function accumulateVisibleParents<T extends { progressJson?: string | null }>(
  pages: T[][],
  visibleLimit: number,
): T[] {
  const limit = Math.max(1, Math.min(LIST_BY_NOVEL_VISIBLE_MAX, Math.floor(visibleLimit) || 1));
  const out: T[] = [];
  const seen = new Set<T>();
  for (const page of pages) {
    for (const row of page) {
      if (readParentTaskIdFromProgress(row.progressJson ?? null)) continue;
      if (seen.has(row)) continue;
      seen.add(row);
      out.push(row);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function parseChapterIds(json: string | null | undefined): string[] {
  if (!json?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function parseProgressJson(json: string | null | undefined): Record<string, unknown> {
  if (!json?.trim()) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 续生成子任务 progressJson 内的父任务 id；父任务行恒为空。 */
export function readParentTaskIdFromProgress(json: string | null | undefined): string | null {
  const val = parseProgressJson(json).parentTaskId;
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

/** 父任务 progressJson 内已记录的续生成失败章。 */
export function readFailedContinueChapters(json: string | null | undefined): string[] {
  const val = parseProgressJson(json).failedContinueChapters;
  return Array.isArray(val)
    ? val.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
}

/**
 * watchdog 推进信号快照。心跳只刷 heartbeatAt 不算推进，故显式取 onProgress 实际会写的
 * 五元组：progress / currentStage / currentItemKey / completedChapterCount / completedChunks
 * （completedChunks 取自 progressJson）。slice 截断防超长 label 让 key 失稳。
 */
export interface AudiobookWatchdogSignal {
  progress: number;
  stage: string | null;
  itemKey: string | null;
  completedChapters: number;
  completedChunks: number;
}

/** 从 audiobookTask running 行投影出推进信号。纯函数便于单测。 */
export function projectWatchdogSignal(row: {
  progress: number | null;
  currentStage: string | null;
  currentItemKey: string | null;
  completedChapterCount: number | null;
  progressJson: string | null;
}): AudiobookWatchdogSignal {
  const progressJson = parseProgressJson(row.progressJson);
  const completedChunksRaw = progressJson.completedChunks;
  return {
    progress: typeof row.progress === "number" ? row.progress : 0,
    stage: (row.currentStage ?? "").slice(0, 32) || null,
    itemKey: (row.currentItemKey ?? "").slice(0, 40) || null,
    completedChapters: typeof row.completedChapterCount === "number" ? row.completedChapterCount : 0,
    completedChunks: typeof completedChunksRaw === "number" && Number.isFinite(completedChunksRaw)
      ? completedChunksRaw
      : 0,
  };
}

/** 两个推进信号是否相等（无变化即一个 stall 周期）。 */
export function watchdogSignalEqual(a: AudiobookWatchdogSignal, b: AudiobookWatchdogSignal): boolean {
  return a.progress === b.progress
    && a.stage === b.stage
    && a.itemKey === b.itemKey
    && a.completedChapters === b.completedChapters
    && a.completedChunks === b.completedChunks;
}

/**
 * watchdog 单 tick 决策（纯函数）。
 *
 * - 信号变化 → 重置 stallCount=0，存新信号
 * - 信号相等 → stallCount + 1
 * - stallCount >= stallPeriods → 返回 fail=true（调用方 CAS markFailedIfRunning）
 *
 * continuing 父由调用方在传入前过滤（父无自身 pipeline，推进信号无意义）；
 * 此函数只做信号对比，不臆测 stage 语义。
 */
export function computeWatchdogDecision(input: {
  prev: { signal: AudiobookWatchdogSignal; stallCount: number } | null;
  curr: AudiobookWatchdogSignal;
  stallPeriods: number;
}): { signal: AudiobookWatchdogSignal; stallCount: number; fail: boolean } {
  const { curr, stallPeriods } = input;
  if (input.prev && watchdogSignalEqual(input.prev.signal, curr)) {
    const stallCount = input.prev.stallCount + 1;
    return { signal: input.prev.signal, stallCount, fail: stallCount >= stallPeriods };
  }
  return { signal: curr, stallCount: 0, fail: false };
}

/**
 * 把失败章合并进父 progressJson 的 failedContinueChapters（去重，整串写一次）。
 *
 * 乐观 CAS：where 带上读到的 progressJson 原值，别的写者（reconcileParent / onProgress）
 * 若在读写窗口内改过整串 blob，本次写落空并重读重试。无 CAS 时后写覆盖先写，
 * 失败章列表会静默丢失，前端对照 list 不再标黄，用户无从重试那些章。
 */
async function appendFailedContinueChapters(
  parentTaskId: string,
  failedChapterIds: string[],
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parent = await prisma.audiobookTask.findUnique({
      where: { id: parentTaskId },
      select: { progressJson: true },
    });
    if (!parent) return;
    const progress = parseProgressJson(parent.progressJson);
    const existing = readFailedContinueChapters(parent.progressJson);
    const merged = Array.from(new Set([...existing, ...failedChapterIds]));
    if (merged.length === existing.length) return;
    const nextProgress: Record<string, unknown> = {
      ...progress,
      deliveryStyleMode: progress.deliveryStyleMode ?? null,
      failedContinueChapters: merged,
    };
    const claimed = await prisma.audiobookTask.updateMany({
      where: { id: parentTaskId, progressJson: parent.progressJson },
      data: { progressJson: JSON.stringify(nextProgress) },
    });
    if (claimed.count > 0) return;
  }
  console.warn(
    "[audiobook] appendFailedContinueChapters 连续 5 次 CAS 落空，失败章未记录",
    parentTaskId,
    failedChapterIds,
  );
}

type ChapterProgressEntry = {
  chapterId: string;
  status: "pending" | "annotating" | "synthesizing" | "merging" | "ready" | "failed";
  completedChunks: number;
  totalChunks: number;
  detail?: string;
};

/**
 * 逐章进度：以管线实时 emit 的 chapterProgress 为底，磁盘 chapter.wav 在盘的章强制 ready
 * （覆盖 cache-hit skip / empty-chapter / resume 崩溃恢复三种漂移）；chapterIds 中数组
 * 缺失的章补 pending 占位。纯展示，与 progress/completedChapterCount 不重复计数。
 */
export function deriveChapterProgress(
  progressJson: string | null | undefined,
  chapterIds: string[],
  readyChapterIds: string[],
): ChapterProgressEntry[] | undefined {
  const parsed = parseProgressJson(progressJson);
  const raw = parsed.chapterProgress;
  let entries: ChapterProgressEntry[] = [];
  if (Array.isArray(raw)) {
    entries = raw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        chapterId: typeof item.chapterId === "string" ? item.chapterId : "",
        status: normalizeChapterStatus(item.status),
        completedChunks: typeof item.completedChunks === "number" ? item.completedChunks : 0,
        totalChunks: typeof item.totalChunks === "number" ? item.totalChunks : 0,
        detail: typeof item.detail === "string" ? item.detail : undefined,
      }))
      .filter((item) => item.chapterId);
  }
  if (chapterIds.length === 0 && entries.length === 0) return undefined;

  const byId = new Map(entries.map((e) => [e.chapterId, e] as const));
  const readySet = new Set(readyChapterIds);
  return chapterIds.map((chapterId) => {
    const onDisk = readySet.has(chapterId);
    const base = byId.get(chapterId) ?? {
      chapterId,
      status: "pending" as const,
      completedChunks: 0,
      totalChunks: 0,
      detail: undefined,
    };
    if (onDisk) {
      // 磁盘在 → ready（终态以盘为准）
      return { ...base, status: "ready" as const, completedChunks: base.totalChunks || base.completedChunks };
    }
    // 磁盘不在：若数组残留 ready（如 wav 被删/失败后回退），降级 synthesizing，避免假「已可播」
    if (base.status === "ready") {
      return { ...base, status: "synthesizing" as const, completedChunks: Math.max(0, base.completedChunks) };
    }
    return base;
  });
}

function normalizeChapterStatus(
  raw: unknown,
): ChapterProgressEntry["status"] {
  if (raw === "pending" || raw === "annotating" || raw === "synthesizing" || raw === "merging" || raw === "ready" || raw === "failed") {
    return raw;
  }
  return "pending";
}

function readDeliveryStyleModeFromTask(row: {
  progressJson?: string | null;
}): DeliveryStyleMode {
  const progress = parseProgressJson(row.progressJson);
  const raw = progress.deliveryStyleMode;
  return resolveDeliveryStyleMode(typeof raw === "string" ? raw : null);
}

function buildTaskTitle(novelTitle: string, scopeMode: string, chapterCount: number): string {
  const scopeLabel = scopeMode === "full"
    ? "全书"
    : scopeMode === "range"
      ? `范围 ${chapterCount} 章`
      : "单章";
  return `有声书：${novelTitle}（${scopeLabel}）`;
}

function buildPrecheckRejectMessage(precheck: Awaited<ReturnType<typeof audiobookPrecheckService.precheck>>): string {
  const parts: string[] = [];
  if (precheck.missingVoices.length > 0) {
    const names = precheck.missingVoices.map((item) => item.characterName).join("、");
    parts.push(`以下角色未完成 TTS 绑定：${names}`);
  }
  if (precheck.blockingErrors.length > 0) {
    parts.push(...precheck.blockingErrors);
  }
  return `有声书启动被拒绝：${parts.join("；") || "预检未通过"}。请按角色 ttsMode 补齐 preset/design/clone 绑定后重试。`;
}

function buildRequirePreviewRejectMessage(
  precheck: Awaited<ReturnType<typeof audiobookPrecheckService.precheck>>,
): string {
  const names = precheck.preview.items
    .map((item) => {
      const tag = item.previewStatus === "stale" ? "过期" : "缺失";
      return `${item.characterName}（${tag}）`;
    })
    .slice(0, 12)
    .join("、");
  const more = precheck.preview.items.length > 12
    ? ` 等 ${precheck.preview.items.length} 人`
    : "";
  return `有声书启动被拒绝：已开启「要求试听就绪」，以下角色固定试听未 ready：${names || "若干角色"}${more}。请在有声书工作台一键就绪或单独生成试听后重试。`;
}

function parseAnnotationsJson(json: string | null | undefined): AudiobookChapterAnnotation[] {
  if (!json?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    // 延迟 require：避免 TaskService ↔ AnnotationService 循环依赖
    const { normalizeAnnotationDiagnostics } = require("./AudiobookAnnotationService") as typeof import("./AudiobookAnnotationService");
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

function collectAnnotationWarnings(annotations: AudiobookChapterAnnotation[]): string[] {
  const warnings: string[] = [];
  for (const annotation of annotations) {
    if (annotation.error?.trim()) {
      warnings.push(`第 ${annotation.chapterOrder} 章：${annotation.error.trim()}`);
    }
    if (annotation.assemblyNote?.trim()) {
      warnings.push(`第 ${annotation.chapterOrder} 章：${annotation.assemblyNote.trim()}`);
    }
    if (annotation.wholeChapterNarratorFallback || annotation.diarizeStats?.wholeChapterNarratorFallback) {
      warnings.push(`第 ${annotation.chapterOrder} 章：整章旁白回退（cast 不通过）`);
    }
    if (annotation.contentTruncated) {
      warnings.push(`第 ${annotation.chapterOrder} 章：正文超窗且未分块覆盖，标注可能不全`);
    }
    const d = annotation.diarizeStats;
    if (d && !d.castOk && d.failReasons?.length) {
      warnings.push(
        `第 ${annotation.chapterOrder} 章：cast 未通过（${d.failReasons.slice(0, 3).join("；")}）`,
      );
    }
    if (d && d.spokenQuoteSpanCount > 0 && d.spokenQuoteCoverage < 0.85) {
      warnings.push(
        `第 ${annotation.chapterOrder} 章：对白覆盖 ${Math.round(d.spokenQuoteCoverage * 100)}%`,
      );
    }
    if (d && (d.typedSkippedCount > 0 || d.chatSkippedCount > 0)) {
      warnings.push(
        `第 ${annotation.chapterOrder} 章：已跳过非口语 ${d.typedSkippedCount + d.chatSkippedCount + (d.onScreenSkippedCount || 0)} 段`,
      );
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
  }
  return warnings;
}

/** 仅统计「整章旁白回退」；只认 wholeChapterNarratorFallback 布尔位 */
function countNarratorFallbackChapters(annotations: AudiobookChapterAnnotation[]): number {
  return annotations.filter((item) => isWholeChapterNarratorFallback(item)).length;
}

type AudiobookTaskRow = {
  id: string;
  novelId: string;
  title: string;
  scopeMode: string;
  chapterIdsJson: string;
  chapterCount: number;
  completedChapterCount: number;
  narratorVoice: string;
  narratorStyle: string;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  status: string;
  progress: number;
  retryCount: number;
  maxRetries: number;
  pendingManualRecovery: boolean;
  heartbeatAt: Date | null;
  currentStage: string | null;
  currentItemKey: string | null;
  currentItemLabel: string | null;
  cancelRequestedAt: Date | null;
  error: string | null;
  summary: string | null;
  annotationsJson: string | null;
  progressJson: string | null;
  resultJson: string | null;
  m4bGenerationToken: string | null;
  outputDir: string | null;
  fullAudioPath: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCallCount: number;
  lastTokenRecordedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  novel?: { id: string; title: string } | null;
};

/**
 * Startup recovery only needs this small projection. Keep it separate from the
 * detail row so the recovery scan can be paged without loading historical task
 * payloads into one unbounded array.
 */
type AudiobookRecoveryRow = Pick<
  AudiobookTaskRow,
  | "id"
  | "novelId"
  | "title"
  | "chapterIdsJson"
  | "status"
  | "resultJson"
  | "outputDir"
  | "progress"
  | "progressJson"
  | "currentStage"
  | "cancelRequestedAt"
  | "m4bGenerationToken"
>;

/** Maximum number of rows (and large resultJson values) held per startup page. */
const AUDIOBOOK_RECOVERY_PAGE_SIZE = 100;

/**
 * 续生成抢占父任务时一次性落定的 progress baseline。
 *
 * 为什么能在 wipe 之前算：wipeChapterAudioArtifacts 只动被点名的那些章，
 * 所以 post-wipe ready == pre-wipe ready − requestedIds。预算出来直接并进
 * claim CAS，避免「先写 floor 再补真值」的两阶段窗口（那期间父显示 running@旧值）。
 *
 * 下限 2 / 上限 95：父此刻是 running+continuing，0 会让前端进度条看着像没启动，
 * 100 会与「仍在跑」矛盾——真正的 100 只由 reconcileParent 在全 ready 时落。
 *
 * 生产实测（2026-07-26，任务 cms1rikzm…）：2 章父续生 1 章 → 50。
 */
export function computeContinueParentBaseline(input: {
  preWipeReadyIds: readonly string[];
  requestedIds: readonly string[];
  totalChapterCount: number;
  /** mode=resynthesize：被点名的章会被 wipe，须从 ready 集中扣除 */
  wipesRequested: boolean;
}): number {
  const { preWipeReadyIds, requestedIds, totalChapterCount, wipesRequested } = input;
  if (totalChapterCount <= 0) {
    return 2;
  }
  const readySet = new Set(preWipeReadyIds);
  if (wipesRequested) {
    for (const cid of requestedIds) {
      readySet.delete(cid);
    }
  }
  return Math.max(2, Math.min(95, Math.round((readySet.size / totalChapterCount) * 100)));
}

function parseChunksPrunedFromResultJson(resultJson: string | null | undefined): boolean {
  if (!resultJson?.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(resultJson) as { chunksPruned?: unknown };
    return parsed?.chunksPruned === true;
  } catch {
    return false;
  }
}

function toSummary(row: AudiobookTaskRow): AudiobookTaskSummary {
  const chapterIds = parseChapterIds(row.chapterIdsJson);
  let readyChapterIds: string[] = [];
  // 以磁盘为准：DB fullAudioPath 可能残留而文件已 wipe
  let fullAudioReady = false;
  try {
    const taskDir = resolveAudiobookTaskDir(row.novelId, row.id);
    readyChapterIds = listReadyChapterAudioIds(taskDir, chapterIds);
    fullAudioReady = isFullBookAudioReady(taskDir);
  } catch {
    readyChapterIds = [];
    fullAudioReady = false;
  }

  const chapterProgress = deriveChapterProgress(row.progressJson, chapterIds, readyChapterIds);

  return {
    id: row.id,
    novelId: row.novelId,
    novelTitle: row.novel?.title ?? "",
    title: row.title,
    status: row.status as AudiobookTaskSummary["status"],
    progress: row.progress,
    scopeMode: row.scopeMode as AudiobookTaskSummary["scopeMode"],
    currentStage: row.currentStage,
    currentItemKey: row.currentItemKey,
    currentItemLabel: row.currentItemLabel,
    attemptCount: row.retryCount,
    maxAttempts: row.maxRetries,
    lastError: row.error,
    chapterCount: row.chapterCount,
    completedChapterCount: row.completedChapterCount,
    readyChapterIds,
    chapterProgress,
    outputDir: row.outputDir,
    fullAudioPath: row.fullAudioPath,
    fullAudioReady,
    m4bStatus: readTerminalM4bState(row.resultJson),
    chunksPruned: parseChunksPrunedFromResultJson(row.resultJson),
    failedContinueChapters: readFailedContinueChapters(row.progressJson),
    parentTaskId: readParentTaskIdFromProgress(row.progressJson) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    tokenUsage: toTaskTokenUsageSummary({
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      llmCallCount: row.llmCallCount,
      lastTokenRecordedAt: row.lastTokenRecordedAt,
    }),
  };
}

function toDetail(row: AudiobookTaskRow): AudiobookTaskDetail {
  return {
    ...toSummary(row),
    chapterIds: parseChapterIds(row.chapterIdsJson),
    narratorVoice: row.narratorVoice,
    narratorStyle: row.narratorStyle,
    provider: row.provider,
    model: row.model,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    summary: row.summary,
    annotationsJson: row.annotationsJson,
    progressJson: row.progressJson,
    resultJson: row.resultJson,
    meta: {
      scopeMode: row.scopeMode,
      chapterCount: row.chapterCount,
      completedChapterCount: row.completedChapterCount,
      pendingManualRecovery: row.pendingManualRecovery,
      temperature: row.temperature,
      outputDir: row.outputDir,
      fullAudioPath: row.fullAudioPath,
      deliveryStyleMode: readDeliveryStyleModeFromTask(row),
    },
  };
}

/**
 * 有声书任务：precheck 硬门禁、创建/取消/恢复、标注→TTS→章/全书 WAV 流水线。
 */
export class AudiobookTaskService {
  private readonly queue: string[] = [];

  private readonly queueSet = new Set<string>();

  private readonly activeControllers = new Map<string, AbortController>();

  /** taskId -> 当前后台 m4b worker；代际轮换时立即终止旧 ffmpeg。 */
  private readonly activeM4bControllers = new Map<string, { token: string; controller: AbortController }>();

  /** m4b 文件已产出后，仅重试终态 DB 投影；绝不重复编码。 */
  private readonly backgroundM4bSettleRetry = new BackgroundM4bSettleRetry();

  private processing = false;

  /**
   * Watchdog：任务 id → 上一周期观测的推进信号 + 连续停滞周期计数。
   * 键随 markFailedIfRunning/reconcile 自然消退——runWatchdogTick 每轮用当前 running 集重建。
   */
  private readonly watchdogStallState = new Map<
    string,
    { signal: AudiobookWatchdogSignal; stallCount: number }
  >();

  private watchdogTimer: NodeJS.Timeout | null = null;

  async precheck(input: CreateAudiobookTaskInput) {
    return audiobookPrecheckService.precheck(input);
  }

  async createTask(input: CreateAudiobookTaskInput) {
    const precheck = await audiobookPrecheckService.precheck(input);
    if (!precheck.ok) {
      throw new AppError(buildPrecheckRejectMessage(precheck), 400);
    }
    if (input.requireReadyPreview === true && !precheck.preview.ok) {
      throw new AppError(buildRequirePreviewRejectMessage(precheck), 400);
    }

    const novel = await prisma.novel.findUnique({
      where: { id: precheck.novelId },
      select: { id: true, title: true },
    });
    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    const title = buildTaskTitle(novel.title, precheck.scopeMode, precheck.chapterCount);
    const deliveryStyleMode = resolveDeliveryStyleMode(input.deliveryStyleMode ?? null);
    const task = await prisma.audiobookTask.create({
      data: {
        novelId: novel.id,
        title,
        scopeMode: precheck.scopeMode,
        chapterIdsJson: JSON.stringify(precheck.chapterIds),
        chapterCount: precheck.chapterCount,
        completedChapterCount: 0,
        narratorVoice: precheck.narrator.voice,
        narratorStyle: precheck.narrator.style,
        provider: input.provider ?? null,
        model: input.model?.trim() || null,
        temperature: typeof input.temperature === "number" ? input.temperature : null,
        status: "queued",
        progress: 0,
        currentStage: "queued",
        currentItemLabel: "排队中",
        maxRetries: DEFAULT_MAX_RETRIES,
        // 任务级开关快照：无 schema 列，落 progressJson 供 resume/重跑读取
        progressJson: JSON.stringify({ deliveryStyleMode }),
        m4bGenerationToken: newM4bGenerationToken(),
      },
      include: {
        novel: { select: { id: true, title: true } },
      },
    });

    const outputDir = ensureAudiobookTaskDir(novel.id, task.id);
    const updated = await prisma.audiobookTask.update({
      where: { id: task.id },
      data: { outputDir },
      include: {
        novel: { select: { id: true, title: true } },
      },
    });

    this.enqueueTask(updated.id);
    return toDetail(updated as AudiobookTaskRow);
  }

  async getTask(taskId: string): Promise<AudiobookTaskDetail | null> {
    try {
      const row = await prisma.audiobookTask.findUnique({
        where: { id: taskId },
        include: { novel: { select: { id: true, title: true } } },
      });
      return row ? toDetail(row as AudiobookTaskRow) : null;
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return null;
      }
      throw error;
    }
  }

  async listByNovel(novelId: string, take = 50): Promise<AudiobookTaskSummary[]> {
    try {
      const visibleLimit = Math.max(1, Math.min(LIST_BY_NOVEL_VISIBLE_MAX, take));
      const pageSize = listByNovelFetchTake(visibleLimit);
      // 游标迭代：隐闭子占窗口时继续往后扫，直到凑满 visible 或触扫尽/扫顶
      type ListRow = AudiobookTaskRow & { novel: { id: string; title: string } };
      const visible: ListRow[] = [];
      let scanned = 0;
      let cursor: { updatedAt: Date; id: string } | null = null;
      while (visible.length < visibleLimit && scanned < LIST_BY_NOVEL_SCAN_CAP) {
        const rows = await prisma.audiobookTask.findMany({
          where: cursor
            ? {
                novelId,
                OR: [
                  { updatedAt: { lt: cursor.updatedAt } },
                  { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
                ],
              }
            : { novelId },
          include: { novel: { select: { id: true, title: true } } },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: pageSize,
        });
        if (rows.length === 0) break;
        scanned += rows.length;
        for (const row of rows as ListRow[]) {
          if (readParentTaskIdFromProgress(row.progressJson)) continue;
          visible.push(row);
          if (visible.length >= visibleLimit) break;
        }
        const last = rows[rows.length - 1] as ListRow;
        cursor = { updatedAt: last.updatedAt, id: last.id };
        if (rows.length < pageSize) break;
      }
      return visible.map((row) => toSummary(row));
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return [];
      }
      throw error;
    }
  }

  /**
   * 取消有声书任务。
   * source 仅用于归因日志（UI / task-center / agent / ops curl），不改变取消语义。
   */
  async cancelTask(
    taskId: string,
    source?: TaskCancelSource,
  ): Promise<AudiobookTaskDetail> {
    let task = await prisma.audiobookTask.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }

    const attribution = {
      taskId,
      novelId: task.novelId,
      status: task.status,
      progress: task.progress,
      currentStage: task.currentStage,
      currentItemLabel: task.currentItemLabel,
      cancelRequestedAt: task.cancelRequestedAt?.toISOString() ?? null,
      route: source?.route ?? "unknown",
      via: source?.via ?? null,
      ip: source?.ip ?? null,
      userAgent: source?.userAgent ? String(source.userAgent).slice(0, 200) : null,
      referer: source?.referer ? String(source.referer).slice(0, 200) : null,
    };

    // 归因：双路径 cancel 的第二枪常为 400；attempt 也要落日志，否则只见 morgan 无 source。
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
      console.warn("[audiobook.cancel.rejected]", {
        ...attribution,
        reason: "already_terminal",
      });
      throw new AppError("仅排队中或运行中的有声书任务可取消。", 400);
    }

    // 归因：ch1 synth 曾被「双路径 POST cancel」打断；日志须区分 novel 面板 / 任务中心 / agent / curl。
    console.warn("[audiobook.cancel]", attribution);

    // 级联取消挂在本父上的隐闭续生成子任务（queued/running），避免父停子续在父目录产 wav
    if (!readParentTaskIdFromProgress(task.progressJson)) {
      await this.cancelChildContinueTasks(taskId);
    }

    // 取消请求必须绑定读到的状态和 m4b 代际。仅按 id 写入会在并发
    // retry/resume/reprocess 先轮换代际后，把新一代任务错误标记为待取消。
    // CAS 未命中时重读一次并只对当前活动代际重试，避免把用户对当前任务的
    // 取消意图静默丢掉；若期间已进入终态，则沿用终态拒绝语义。
    let cancelClaim = await prisma.audiobookTask.updateMany({
      where: {
        id: taskId,
        status: task.status,
        ...m4bGenerationWhere(task.m4bGenerationToken),
      },
      data: {
        cancelRequestedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
    if (cancelClaim.count === 0) {
      const latest = await prisma.audiobookTask.findUnique({ where: { id: taskId } });
      if (!latest) {
        throw new AppError("有声书任务不存在。", 404);
      }
      if (latest.status === "succeeded" || latest.status === "failed" || latest.status === "cancelled") {
        throw new AppError("仅排队中或运行中的有声书任务可取消。", 400);
      }
      task = latest;
      cancelClaim = await prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: task.status,
          ...m4bGenerationWhere(task.m4bGenerationToken),
        },
        data: {
          cancelRequestedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
      if (cancelClaim.count === 0) {
        throw new AppError("任务状态已被其它操作更新，请刷新后重试。", 409);
      }
    }

    const isContinueChild = Boolean(readParentTaskIdFromProgress(task.progressJson));
    const isContinuingParent = !isContinueChild && task.currentStage === "continuing";

    // continuing 父无自身 pipeline：不能只靠 cancelRequestedAt 等执行钩子，必须立刻落终态
    if (isContinuingParent) {
      this.removeFromQueue(taskId);
      this.activeControllers.get(taskId)?.abort();
      try {
        await this.reconcileParent(taskId);
      } catch (error) {
        console.warn(
          "[audiobook] cancelTask reconcileParent failed for continuing parent",
          taskId,
          error instanceof Error ? error.message : error,
        );
      }
      // reconcile 按磁盘翻 failed/succeeded；若仍非终态（空章等边角）则强制 cancelled
      this.abortBackgroundM4b(taskId);
      await prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: { in: ["running", "queued"] },
          ...m4bGenerationWhere(task.m4bGenerationToken),
        },
        data: {
          status: "cancelled",
          currentStage: "cancelled",
          currentItemLabel: "已取消",
          finishedAt: new Date(),
          cancelRequestedAt: null,
          heartbeatAt: new Date(),
        },
      });
      await prisma.audiobookTask.updateMany({
        where: { id: taskId },
        data: { cancelRequestedAt: null, heartbeatAt: new Date() },
      });
      const detail = await this.getTask(taskId);
      if (!detail) {
        throw new AppError("有声书任务不存在。", 404);
      }
      return detail;
    }

    // 无论 queued/running：先从内存队列剔除，并写 cancelRequestedAt + abort
    this.removeFromQueue(taskId);
    const controller = this.activeControllers.get(taskId);
    controller?.abort();

    if (task.status === "queued") {
      // CAS：仅当仍为 queued 时终态 cancelled，避免与已进入 execute 的 running 打架
      await this.markCancelledIfActive(taskId, task.progress, ["queued"], task.m4bGenerationToken);
    } else if (!controller) {
      // running 但本进程没有活控制器 = 无人会 ack 这次取消（执行器已随重启消失，或
      // cancel 落在执行器最后一次 isCancelRequested() 与终态 CAS 之间导致那次写落空）。
      // 此时三条路同时关闭：终态 CAS 要求 cancelRequestedAt=null、watchdog 查询排除
      // cancelRequestedAt 非空的行、markCancelledIfActive 又只在 queued 时调用——行会永久
      // 停在 running。既然没有执行器可 ack，就在此直接落 cancelled 终态。
      console.warn("[audiobook.cancel] running 任务无活控制器，直接落 cancelled", {
        taskId,
        stage: task.currentStage,
      });
      await this.markCancelledIfActive(taskId, task.progress, ["running"], task.m4bGenerationToken);
      // 该行若是续生成子任务，父同样需要收口，否则父卡 continuing
      if (isContinueChild) {
        try {
          await this.finalizeContinueChild(taskId, true, task.m4bGenerationToken);
        } catch (error) {
          console.warn(
            "[audiobook.cancel] 无控制器子任务收口父失败",
            taskId,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    const detail = await this.getTask(taskId);
    if (!detail) {
      throw new AppError("有声书任务不存在。", 404);
    }
    return detail;
  }

  async retryTask(taskId: string): Promise<AudiobookTaskDetail> {
    const task = await prisma.audiobookTask.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    if (task.status !== "failed" && task.status !== "cancelled") {
      throw new AppError("仅失败或已取消的有声书任务可重试。", 400);
    }
    if (task.retryCount >= task.maxRetries) {
      throw new AppError(
        `有声书任务已达最大重试次数（${task.maxRetries}）。请新建任务或提高 maxRetries。`,
        400,
      );
    }

    this.activeControllers.get(taskId)?.abort();
    this.abortBackgroundM4b(taskId);
    await prisma.audiobookTask.update({
      where: { id: taskId },
      data: {
        status: "queued",
        progress: 0,
        error: null,
        finishedAt: null,
        startedAt: null,
        cancelRequestedAt: null,
        pendingManualRecovery: false,
        heartbeatAt: null,
        currentStage: "queued",
        currentItemKey: null,
        currentItemLabel: "排队中",
        retryCount: { increment: 1 },
        m4bGenerationToken: newM4bGenerationToken(),
      },
    });
    this.enqueueTask(taskId);
    const detail = await this.getTask(taskId);
    if (!detail) {
      throw new AppError("有声书任务不存在。", 404);
    }
    return detail;
  }

  /**
   * P0-3：受控提高任务 retry 额度。默认 DEFAULT_MAX_RETRIES=3（原 1 太紧）。
   * 校验：
   * - maxRetries 整数 0-10（0=禁止重跑，仅用于显式关闭）
   * - 非 running 状态可改（queued/running 中被改会与排队语义冲突）
   * - 终态任务提高额度后可直接 retryTask
   * 返回更新后的 AudiobookTaskDetail。
   */
  async updateTaskMaxRetries(taskId: string, maxRetries: number): Promise<AudiobookTaskDetail> {
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      throw new AppError("maxRetries 必须是 0-10 的整数。", 400);
    }
    const task = await prisma.audiobookTask.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    const isAlive = task.status === "running" || task.status === "queued";
    if (isAlive) {
      throw new AppError("仅非运行中的有声书任务可调整重试额度。", 400);
    }
    const updated = await prisma.audiobookTask.update({
      where: { id: taskId },
      data: { maxRetries, currentItemLabel: task.currentItemLabel },
      include: { novel: { select: { id: true, title: true } } },
    });
    const detail = toDetail(updated as AudiobookTaskRow);
    if (!detail) {
      throw new AppError("有声书任务不存在。", 404);
    }
    return detail;
  }

  /**
   * 重做已 succeeded 任务的 m4b 封装（根因修复：m4b 失败/被取消后缺乏受支持的重做入口）。
   *
   * 背景：m4b 封装只在任务首次成功时随 scheduleBackgroundM4bEncode 后台触发一次；
   * 若途中失败（超时/资源争抢/宿主 OOM），任务保持 succeeded 且 label 变成
   * 「有声书生成完成；m4b 失败（…）」，前端没有按钮也无法再触发，只能靠手工
   * 脚本绕过代码库（2026-09-03 生产事故实测）。此方法补齐受支持路径：
   *
   * - 仅 succeeded 任务可重做（WAV 已在盘，无重合成成本）；
   * - m4b 已 ready 时幂等早退（不重复编码）；
   * - 入口先把 label 置回「m4b 后台封装中」、清掉旧 m4b 结论并轮换 generation，
   *   再走与首次一致的 scheduleBackgroundM4bEncode(force) 后台封装；
   * - 收口只接受当前 generation；旧失败文案不会参与所有权判断。
   *
   * 并发安全：encodeFullBookM4b 内部 withTaskDirLock 同 taskDir 串行化，
   * 重复触发也只 spawn 一个 ffmpeg；本方法与首次触发天然去重（锁内就绪复用）。
   */
  async redoTaskM4b(taskId: string): Promise<AudiobookTaskDetail> {
    const task = await prisma.audiobookTask.findUnique({
      where: { id: taskId },
      include: { novel: { select: { id: true, title: true } } },
    });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    const taskDir = task.outputDir?.trim();
    if (!taskDir) {
      throw new AppError("任务无输出目录，无法封装 m4b。", 400);
    }
    if (task.status !== "succeeded") {
      throw new AppError("仅生成完成（succeeded）的任务可重做 m4b。", 400);
    }
    const chapterIds = parseChapterIds(task.chapterIdsJson);
    const lockResult = await withAudiobookTaskDirArtifactLock(taskDir, async (): Promise<
      { kind: "ready"; detail: AudiobookTaskDetail } | { kind: "encode"; generationToken: string }
    > => {
      if (isFullBookM4bReady(taskDir)) {
        if (
          readTerminalM4bState(task.resultJson) === "ready"
          && task.currentItemLabel === M4B_DONE_LABEL
        ) {
          return { kind: "ready", detail: toDetail(task as AudiobookTaskRow) };
        }
        const bytes = fs.statSync(resolveFullBookM4bPath(taskDir)).size;
        const repaired = await prisma.audiobookTask.updateMany({
          where: {
            id: taskId,
            status: "succeeded",
            m4bGenerationToken: task.m4bGenerationToken,
            resultJson: task.resultJson,
          },
          data: {
            currentItemLabel: M4B_DONE_LABEL,
            resultJson: mergeM4bIntoResultJson(task.resultJson, {
              status: "ready",
              path: "full-book.m4b",
              bytes,
              chapterCount: chapterIds.length,
            }),
            heartbeatAt: new Date(),
          },
        });
        if (repaired.count === 0) {
          const latest = await prisma.audiobookTask.findUnique({
            where: { id: taskId },
            include: { novel: { select: { id: true, title: true } } },
          });
          if (
            latest
            && latest.status === "succeeded"
            && latest.currentItemLabel === M4B_DONE_LABEL
            && readTerminalM4bState(latest.resultJson) === "ready"
          ) {
            return { kind: "ready", detail: toDetail(latest as AudiobookTaskRow) };
          }
          throw new AppError("任务状态已被其它操作更新，请刷新后重试。", 409);
        }
        const detail = await this.getTask(taskId);
        if (!detail) throw new AppError("有声书任务不存在。", 404);
        return { kind: "ready", detail };
      }
      if (!isFullBookAudioReady(taskDir)) {
        throw new AppError("全书 WAV 未就绪，无法封装 m4b（请先完成全书合成）。", 400);
      }
      if (chapterIds.length === 0) {
        throw new AppError("任务章节列表为空，无法封装 m4b。", 400);
      }

      // 置回「封装中」label + 清掉 resultJson 里的旧 m4b 结论（有效避免重做期间
      // 前端仍看到旧 failed 状态）。CAS 只要求 status=succeeded：并发时谁先抢到
      // 谁有效；同时轮换持久化代际，令已在途的旧 worker 失效。
      const generationToken = newM4bGenerationToken();
      const clearedResultJson = removeM4bFromResultJson(task.resultJson) ?? "{}";
      const generationClaim = await prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: "succeeded",
          m4bGenerationToken: task.m4bGenerationToken,
        },
        data: {
          currentItemLabel: M4B_ENCODING_LABEL,
          resultJson: markM4bEncodingInResultJson(clearedResultJson),
          heartbeatAt: new Date(),
          m4bGenerationToken: generationToken,
        },
      });
      if (generationClaim.count === 0) {
        throw new AppError("任务已被其它 m4b 操作占用，请刷新后重试。", 409);
      }
      this.abortBackgroundM4b(taskId);
      return { kind: "encode", generationToken };
    });

    if (lockResult.kind === "ready") return lockResult.detail;
    const { generationToken } = lockResult;

    this.scheduleBackgroundM4bEncode({
      parentTaskId: taskId,
      novelId: task.novelId,
      parentTitle: task.title,
      taskDir,
      chapterIds,
      force: true,
      generationToken,
    });

    const detail = await this.getTask(taskId);
    if (!detail) {
      throw new AppError("有声书任务不存在。", 404);
    }
    return detail;
  }

  async getAnnotations(taskId: string): Promise<AudiobookTaskAnnotationsView> {
    const task = await prisma.audiobookTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        novelId: true,
        status: true,
        annotationsJson: true,
      },
    });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    const annotations = parseAnnotationsJson(task.annotationsJson);
    return {
      taskId: task.id,
      novelId: task.novelId,
      status: task.status as AudiobookTaskAnnotationsView["status"],
      annotations,
      qualityWarnings: collectAnnotationWarnings(annotations),
    };
  }

  /**
   * 失败章 / 质量回退章重做：
   * - reannotate：清标注 + 章音频 + 全书，resume 会重标并重合成该章
   * - resynthesize：保留标注，仅清章音频 + 全书
   * 仅 terminal 状态可操作；不占用 maxRetries。
   */
  async reprocessChapter(input: {
    taskId: string;
    chapterId: string;
    mode: AudiobookChapterReprocessMode;
  }): Promise<AudiobookTaskDetail> {
    const task = await prisma.audiobookTask.findUnique({ where: { id: input.taskId } });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    if (task.status !== "failed" && task.status !== "cancelled" && task.status !== "succeeded") {
      throw new AppError("仅已完成、失败或已取消的有声书任务可重做章节。", 400);
    }

    const chapterIds = parseChapterIds(task.chapterIdsJson);
    const chapterId = input.chapterId.trim();
    if (!chapterIds.includes(chapterId)) {
      throw new AppError("章节不在该有声书任务范围内。", 404);
    }

    // 先失效正在封装旧全书的 worker，再做 wipe；否则旧 worker 可能在 wipe 后
    // 仍把旧 full-book.m4b rename 回规范名。
    const generationToken = newM4bGenerationToken();
    const taskDir = task.outputDir?.trim() || resolveAudiobookTaskDir(task.novelId, task.id);
    const modeLabel = input.mode === "reannotate" ? "重标并重合成" : "重合成";
    // Persist the intent before touching the filesystem. If the process dies
    // after the wipe (or the follow-up DB write is unavailable), startup can
    // still identify the exact chapter and replay the idempotent cleanup.
    const pendingIntent: AudiobookReprocessIntent = {
      chapterId,
      mode: input.mode,
    };
    const pendingProgressJson = withReprocessIntent(task.progressJson, pendingIntent);
    const nextAnnotationsJson = input.mode === "reannotate"
      ? (() => {
        const remaining = parseAnnotationsJson(task.annotationsJson)
          .filter((item) => item.chapterId !== chapterId);
        return remaining.length > 0 ? JSON.stringify(remaining) : null;
      })()
      : task.annotationsJson;
    let durableIntentClaimed = false;
    try {
      await withAudiobookTaskDirArtifactLock(taskDir, async () => {
        const generationClaim = await prisma.audiobookTask.updateMany({
          where: {
            id: task.id,
            status: { in: ["failed", "cancelled", "succeeded"] },
            m4bGenerationToken: task.m4bGenerationToken,
          },
          data: {
            // This single write is the durable recovery boundary. It records a
            // runnable state and exact cleanup intent before any file is removed.
            status: "queued",
            progress: 0,
            error: null,
            finishedAt: null,
            startedAt: null,
            cancelRequestedAt: null,
            pendingManualRecovery: false,
            heartbeatAt: null,
            currentStage: "queued",
            currentItemKey: chapterId,
            currentItemLabel: `排队：${modeLabel}章节`,
            fullAudioPath: null,
            annotationsJson: nextAnnotationsJson,
            summary: null,
            resultJson: null,
            progressJson: pendingProgressJson,
            m4bGenerationToken: generationToken,
          },
        });
        if (generationClaim.count === 0) {
          throw new AppError("任务已被其它重处理请求占用，请刷新后重试。", 409);
        }
        durableIntentClaimed = true;
        this.abortBackgroundM4b(task.id);
        wipeChapterAudioArtifacts(taskDir, chapterId);
        if (input.mode === "reannotate") {
          wipeChapterAnnotationArtifact(taskDir, chapterId);
        }
      });
    } finally {
      // A cleanup error must not strand a durable queued task until restart.
      // executeTask replays the idempotent intent and will either recover or
      // settle the task failed with the concrete filesystem error.
      if (durableIntentClaimed) this.enqueueTask(task.id);
    }
    const detail = await this.getTask(task.id);
    if (!detail) {
      throw new AppError("有声书任务不存在。", 404);
    }
    return detail;
  }

  /**
   * 已交付父任务上续跑一个隐闭子任务，补齐缺失章。
   *  - 父须 succeeded/failed（running/queued → 409，避免父自己 onProgress 与子 reconcile 并发）
   *  - chapterIds 必须全在父 chapterIdsJson 内（否则 400，不破父 scope 契约）
   *  - 跑 precheck 做音色门禁（复用父 narrator/narratorStyle/provider/model/temperature）
   *  - 子 outputDir 显式写父目录路径：续跑章 chapter.wav 直接落父目录，父 reconcile 能看见
   *  - 子 progressJson 落 { parentTaskId, hidden:true, mode }；listByNovel 据此过滤
   *  - 子成功/失败钩子触发 reconcileParent + 失败章回写
   */
  async continueParentTask(input: ContinueAudiobookTaskInput): Promise<AudiobookTaskDetail> {
    const parentTaskId = input.parentTaskId?.trim();
    if (!parentTaskId) {
      throw new AppError("parentTaskId 不能为空。", 400);
    }
    const requestedIds = Array.from(
      new Set(
        (input.chapterIds ?? [])
          .map((id) => id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (requestedIds.length === 0) {
      throw new AppError("chapterIds 至少 1 章。", 400);
    }
    if (input.mode !== undefined && input.mode !== "resynthesize") {
      throw new AppError("mode 仅支持 resynthesize。", 400);
    }

    const parent = await prisma.audiobookTask.findUnique({ where: { id: parentTaskId } });
    if (!parent) {
      throw new AppError("父有声书任务不存在。", 404);
    }
    if (parent.status !== "succeeded" && parent.status !== "failed") {
      throw new AppError(
        "父任务仍在运行或排队，无法续生成。请等待父任务进入已完成/失败状态。",
        409,
      );
    }

    const parentChapterIds = parseChapterIds(parent.chapterIdsJson);
    const parentChapterSet = new Set(parentChapterIds);
    const outOfScope = requestedIds.filter((id) => !parentChapterSet.has(id));
    if (outOfScope.length > 0) {
      throw new AppError(
        `续生成章 ${outOfScope.join(", ")} 不在原任务范围内；如需扩范围请新建任务。`,
        400,
      );
    }

    // 音色门禁：复用父配置走 precheck explicit branch（只拒缺音色，不重建 scope）
    const precheck = await audiobookPrecheckService.precheck({
      novelId: parent.novelId,
      scopeMode: (parent.scopeMode as "chapter" | "range" | "full") || "chapter",
      explicitChapterIds: requestedIds,
      narratorVoice: parent.narratorVoice || undefined,
      narratorStyle: parent.narratorStyle || undefined,
      provider: (parent.provider as LLMProvider | null) ?? undefined,
      model: parent.model ?? undefined,
      temperature: parent.temperature ?? undefined,
    });
    if (!precheck.ok) {
      throw new AppError(buildPrecheckRejectMessage(precheck), 400);
    }

    const parentOutputDir = parent.outputDir?.trim() || resolveAudiobookTaskDir(parent.novelId, parent.id);

    // 先抢占父（CAS succeeded/failed → running+continuing），再做破坏性 wipe / 建子任务。
    // 原顺序把 CAS 放最后：:996 的读闸与 CAS 之间隔着 await precheck，双提交下两个请求都能过读闸，
    // 各自 wipe 同一批章的 wav（可能删掉另一个已产出的音频）并各建一个子任务，只有一个 CAS 命中，
    // 但两个子任务都被 enqueue。抢占前置后，第二枪 CAS 落空即 409，不动磁盘、不建子。
    //
    // MEDIUM-3 fix: progress baseline 预算（wipe 前算 ready 集、减去 requestedIds）在 CAS 前完成，
    // 避免两阶段写的「running @ 100%」窗口（一次原子抢占即落真 baseline）。
    let preWipeReadyIds: string[] = [];
    try {
      preWipeReadyIds = listReadyChapterAudioIds(parentOutputDir, parentChapterIds);
    } catch {
      // 读盘失败按「无就绪章」算：baseline 落到 floor，宁可低报也不高报
      preWipeReadyIds = [];
    }
    const parentProgressBaseline = computeContinueParentBaseline({
      preWipeReadyIds,
      requestedIds,
      totalChapterCount: parentChapterIds.length,
      wipesRequested: input.mode === "resynthesize",
    });

    const continuationGenerationToken = newM4bGenerationToken();
    const claimedParent = await withAudiobookTaskDirArtifactLock(parentOutputDir, async () => {
      const claimed = await prisma.audiobookTask.updateMany({
        where: {
          id: parent.id,
          status: { in: ["succeeded", "failed"] },
          ...m4bGenerationWhere(parent.m4bGenerationToken),
        },
        data: {
          status: "running",
          currentStage: "continuing",
          currentItemLabel: `续生成 ${precheck.chapterCount} 章`,
          progress: parentProgressBaseline,
          fullAudioPath: null,
          resultJson: removeM4bFromResultJson(parent.resultJson),
          cancelRequestedAt: null,
          finishedAt: null,
          heartbeatAt: new Date(),
          // 续生成会使旧父代际的 m4b worker 失效，必须在 wipe 前持久化轮换。
          m4bGenerationToken: continuationGenerationToken,
        },
      });
      if (claimed.count === 0) {
        throw new AppError(
          "父任务已被其它续生成请求占用或状态已变更，无法续生成。请刷新后重试。",
          409,
        );
      }
      this.abortBackgroundM4b(parent.id);
      return claimed;
    });

    // 抢占成功后父已是 running+continuing：此后任一步失败都必须把父放回原终态，
    // 否则父卡 continuing（watchdog 跳过 + resume 跳过 + 续生成 409，三条自愈路径同时关闭）。
    const releaseParentOnFailure = async (reason: string): Promise<void> => {
      try {
        await prisma.audiobookTask.updateMany({
          where: {
            id: parent.id,
            status: "running",
            currentStage: "continuing",
            m4bGenerationToken: continuationGenerationToken,
          },
          data: {
            status: parent.status,
            currentStage: parent.currentStage,
            currentItemLabel: parent.currentItemLabel,
            progress: parent.progress,
            fullAudioPath: parent.fullAudioPath,
            resultJson: parent.resultJson,
            error: `续生成启动失败：${reason}`.slice(0, 500),
            finishedAt: new Date(),
            heartbeatAt: new Date(),
          },
        });
      } catch (releaseError) {
        console.warn(
          "[audiobook] continueParentTask 回滚父状态失败（父可能卡 continuing）",
          parent.id,
          releaseError instanceof Error ? releaseError.message : releaseError,
        );
      }
    };

    const title = `${parent.title}（续生成 ${requestedIds.length} 章）`;
    const parentDeliveryMode = readDeliveryStyleModeFromTask(parent as AudiobookTaskRow);

    let child;
    try {
      child = await prisma.audiobookTask.create({
        data: {
          novelId: parent.novelId,
          title,
          scopeMode: precheck.scopeMode,
          chapterIdsJson: JSON.stringify(precheck.chapterIds),
          chapterCount: precheck.chapterCount,
          completedChapterCount: 0,
          narratorVoice: parent.narratorVoice,
          narratorStyle: parent.narratorStyle,
          provider: parent.provider,
          model: parent.model,
          temperature: parent.temperature,
          status: "queued",
          progress: 0,
          currentStage: "queued",
          currentItemLabel: "排队：续生成缺失章",
          maxRetries: DEFAULT_MAX_RETRIES,
          outputDir: parentOutputDir,
          m4bGenerationToken: newM4bGenerationToken(),
          progressJson: JSON.stringify({
            deliveryStyleMode: parentDeliveryMode,
            hidden: true,
            parentTaskId: parent.id,
            // Fence the durable cleanup intent to this exact parent continuation.
            // A delayed child from an older generation must never wipe newer audio.
            parentGenerationToken: continuationGenerationToken,
            mode: input.mode ?? null,
          }),
        },
        include: { novel: { select: { id: true, title: true } } },
      });
    } catch (createError) {
      // 子任务没建成 = 父的 continuing 永远等不到收口者，必须立刻放回终态。
      // wipe 排在 create 之后，此处磁盘还没动过，回滚回 parent.status/fullAudioPath 是真的。
      await releaseParentOnFailure(
        createError instanceof Error ? createError.message : String(createError),
      );
      throw createError;
    }

    // The child row is the durable cleanup intent. executeTask validates the
    // parent generation and performs strict, idempotent invalidation before
    // any cache-capable read. A crash after create but before enqueue is
    // recovered by resumePendingTasks without reusing stale output.
    this.enqueueTask(child.id);
    return toDetail(child as AudiobookTaskRow);
  }

  /**
   * A continuation cleanup failure cannot be reconciled from disk: an old,
   * still-readable chapter.wav is not proof that this generation succeeded.
   * Fence the parent update to the generation stored on the child and expose
   * every requested chapter as retryable without ever restoring fullAudioPath.
   */
  private async failContinueParentPreparation(input: {
    parentTaskId: string;
    parentGenerationToken: string | null;
    failedChapterIds: string[];
    reason: string;
  }): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const parent = await prisma.audiobookTask.findUnique({
        where: { id: input.parentTaskId },
        select: {
          status: true,
          currentStage: true,
          cancelRequestedAt: true,
          progressJson: true,
          m4bGenerationToken: true,
        },
      });
      if (
        !parent
        || parent.status !== "running"
        || parent.currentStage !== "continuing"
        || parent.cancelRequestedAt
        || (input.parentGenerationToken !== null
          && parent.m4bGenerationToken !== input.parentGenerationToken)
      ) {
        return false;
      }
      const message = `续生成准备失败：${input.reason}`.slice(0, 500);
      const claimed = await prisma.audiobookTask.updateMany({
        where: {
          id: input.parentTaskId,
          status: "running",
          currentStage: "continuing",
          cancelRequestedAt: null,
          progressJson: parent.progressJson,
          m4bGenerationToken: parent.m4bGenerationToken,
        },
        data: {
          status: "failed",
          currentStage: "failed",
          currentItemLabel: message.slice(0, 200),
          error: message,
          fullAudioPath: null,
          progressJson: withContinuePreparationFailure(
            parent.progressJson,
            input.failedChapterIds,
          ),
          finishedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
      if (claimed.count > 0) return true;
    }
    throw new Error(`续生成准备失败后无法收口父任务 ${input.parentTaskId}`);
  }

  /**
   * 续生成子任务终态后重算父 readyChapterIds / chapterProgress（磁盘唯一真相）。
   * 整串写父 progressJson，避免与父潜在并发 onProgress 抢写——子终态时父 status=running
   * 由本流程置入且无跑中管线，写安全。
   */
  async reconcileParent(parentTaskId: string): Promise<void> {
    const parent = await prisma.audiobookTask.findUnique({ where: { id: parentTaskId } });
    if (!parent) return;
    const chapterIds = parseChapterIds(parent.chapterIdsJson);
    if (chapterIds.length === 0) return;
    const taskDir = parent.outputDir?.trim() || resolveAudiobookTaskDir(parent.novelId, parent.id);
    let readyChapterIds: string[] = [];
    let fullAudioReady = false;
    try {
      readyChapterIds = listReadyChapterAudioIds(taskDir, chapterIds);
      fullAudioReady = isFullBookAudioReady(taskDir);
    } catch {
      readyChapterIds = [];
      fullAudioReady = false;
    }
    const chapterProgress = deriveChapterProgress(parent.progressJson, chapterIds, readyChapterIds);
    const progress = parseProgressJson(parent.progressJson);
    // 修剪 failedContinueChapters：已就绪的章不再标黄（磁盘成真后从失败列表移除，避免 stale 累积）
    const readySet = new Set(readyChapterIds);
    const prunedFailed = readFailedContinueChapters(parent.progressJson).filter(
      (id) => !readySet.has(id),
    );
    const nextProgress: Record<string, unknown> = {
      ...progress,
      deliveryStyleMode: progress.deliveryStyleMode ?? readDeliveryStyleModeFromTask(parent as AudiobookTaskRow),
      chapterProgress: chapterProgress ?? [],
      failedContinueChapters: prunedFailed,
    };

    const allReady = readyChapterIds.length === chapterIds.length;
    // 全就绪但 full-book.wav 不在/失效（续生成子曾按「章变则全书必须重拼」清掉）→
    // 用已就绪的 per-chapter.wav 就地重拼全书。全局任务队列串行，无其它写入发生。
    if (allReady && !fullAudioReady) {
      try {
        const chapterPaths = chapterIds.map((id) => resolveChapterAudioPath(taskDir, id));
        const gaps = chapterPaths.length > 1
          ? Array.from({ length: chapterPaths.length - 1 }, () => resolveBetweenChapterGapMs())
          : [];
        concatWavFiles(chapterPaths, resolveFullBookAudioPath(taskDir), gaps);
        fullAudioReady = isFullBookAudioReady(taskDir);
      } catch (restitchError) {
        console.warn(
          "[audiobook] reconcileParent 重拼全书失败（章可逐章播，全书播放暂缺）",
          parent.id,
          restitchError instanceof Error ? restitchError.message : restitchError,
        );
        fullAudioReady = false;
      }
    }
    // m4b：已存在则 skip；缺则先落父 succeeded，再后台 encode（不 await，避免占全局串行队列）
    const m4bAlreadyReady = allReady && fullAudioReady && isFullBookM4bReady(taskDir);
    if (allReady) {
      // 全部就绪：父翻 succeeded，currentStage 收尾
      // error:null —— 前次续生成失败留下的 error 文本必须清，否则父 succeeded 仍带旧红字
      // m4b 不在此 await：大书 ffmpeg 可 20min 级，会堵 processQueue；后台补标 label
      const successLabel = m4bAlreadyReady
        ? M4B_DONE_LABEL
        : fullAudioReady
          ? M4B_ENCODING_LABEL
          : "有声书生成完成";
      // 旧任务可能没有代际值；在父终态 CAS 中补齐，后续后台 worker 才有可校验的
      // 持久 token。continue 已在抢占父时轮换过 token，这里沿用该代际。
      const generationToken = parent.m4bGenerationToken?.trim() || newM4bGenerationToken();
      // CAS `status in (running, queued)`：reconcileParent 会被 cancelTask / finalizeContinueChild /
      // 恢复路径并发调用。无 CAS 时被取消的父会被迟到的子回调覆写成 succeeded/failed
      //（用户取消的任务谎报「生成完成」）。终态一旦落定即不可再被本函数改写。
      const claimed = await prisma.audiobookTask.updateMany({
        where: {
          id: parent.id,
          status: { in: ["running", "queued"] },
          resultJson: parent.resultJson,
          m4bGenerationToken: parent.m4bGenerationToken,
        },
        data: {
          progressJson: JSON.stringify(nextProgress),
          progress: 100,
          completedChapterCount: readyChapterIds.length,
          fullAudioPath: fullAudioReady ? "full-book.wav" : parent.fullAudioPath,
          status: "succeeded",
          currentStage: "finalizing",
          currentItemLabel: successLabel,
          resultJson: fullAudioReady && !m4bAlreadyReady
            ? markM4bEncodingInResultJson(parent.resultJson)
            : parent.resultJson,
          error: null,
          finishedAt: new Date(),
          heartbeatAt: new Date(),
          m4bGenerationToken: generationToken,
        },
      });
      if (claimed.count === 0) {
        return;
      }
      if (fullAudioReady && !m4bAlreadyReady) {
        this.scheduleBackgroundM4bEncode({
          parentTaskId: parent.id,
          novelId: parent.novelId,
          parentTitle: parent.title,
          taskDir,
          chapterIds,
          generationToken,
        });
      }
      return;
    }

    // 非全就绪：子已终态，父必须离开 running/continuing，否则
    //  - continueParentTask 拒绝重试（409 父仍 running）
    //  - resumePendingTasks 因 currentStage=="continuing" 跳过父，重启不 pull-back
    //  - 前端 continueable=false，"补全/逐章生成"按钮禁用，对照 list 标黄章不能再点
    // 有记录失败章 → 翻 failed（保留既有就绪比例 + failedContinueChapters 供前端标黄重试）；
    // 无失败章（纯取消/部分成功的子终态）→ 翻 failed 也让父回到 front-end continueable 终态。
    const failureLabel = prunedFailed.length > 0
      ? `续生成后有 ${prunedFailed.length} 章失败，可在对照 list 逐章重试`
      : `续生成未完成，已就绪 ${readyChapterIds.length}/${chapterIds.length} 章`;
    // 部分就绪的父保留真实就绪比例（上限 99：终态 failed 不该显示 100）
    const parentProgress = Math.max(
      2,
      Math.min(99, Math.round((readyChapterIds.length / Math.max(1, chapterIds.length)) * 100)),
    );
    // 同上 CAS：cancelTask 先落的 cancelled 不得被迟到的子回调改写成 failed。
    await prisma.audiobookTask.updateMany({
      where: {
        id: parent.id,
        status: { in: ["running", "queued"] },
        m4bGenerationToken: parent.m4bGenerationToken,
      },
      data: {
        progressJson: JSON.stringify(nextProgress),
        progress: parentProgress,
        completedChapterCount: readyChapterIds.length,
        // 磁盘 full-book.wav 不在/失效时清空 fullAudioPath，避免父行仍声称全书可播（子终态后失效场景）。
        fullAudioPath: fullAudioReady ? "full-book.wav" : null,
        status: "failed",
        currentStage: "failed",
        currentItemLabel: failureLabel,
        error: failureLabel,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
  }

  /**
   * 父已 succeeded 后后台封装 m4b：不 await、不占 processQueue。
   * 完成后按 generation + resultJson 快照 CAS 同步终态；失败进入小型投影重试队列。
   */
  private async scheduleBackgroundM4bEncode(input: {
    parentTaskId: string;
    novelId: string;
    parentTitle: string;
    taskDir: string;
    chapterIds: string[];
    /** 重做场景：即使盘上已有旧 m4b，也重新执行本代封装。 */
    force?: boolean;
    /** 启动前、rename 前、settle 前均校验的持久化代际。 */
    generationToken: string;
  }): Promise<void> {
    const { parentTaskId, novelId, parentTitle, taskDir, chapterIds, force, generationToken } = input;
    const controller = new AbortController();
    const previous = this.activeM4bControllers.get(parentTaskId);
    if (previous && previous.token !== generationToken) {
      previous.controller.abort();
    }
    this.activeM4bControllers.set(parentTaskId, { token: generationToken, controller });
    try {
      if (!(await this.isCurrentM4bGeneration(parentTaskId, generationToken))) return;
      // 先读取并校验持久 marker，再决定是编码还是写入明确失败终态。
      // marker 的 CAS 是重启恢复的唯一依据，不能只依赖内存中的 Promise。
      const markerRow = await prisma.audiobookTask.findUnique({
        where: { id: parentTaskId },
        select: { resultJson: true, status: true, m4bGenerationToken: true },
      });
      if (
        !markerRow
        || markerRow.status !== "succeeded"
        || markerRow.m4bGenerationToken !== generationToken
      ) return;
      const settleM4bFailure = async (reason: string): Promise<void> => {
        await this.persistBackgroundM4bSettle(
          parentTaskId,
          `有声书生成完成；m4b 失败（${reason}）`,
          { status: "failed", reason },
          { force, generationToken },
        );
      };
      if (!isFullBookAudioReady(taskDir)) {
        await settleM4bFailure("全书 WAV 缺失或无效");
        return;
      }
      if (chapterIds.length === 0) {
        await settleM4bFailure("任务章节列表为空");
        return;
      }
      const missingChapterIds = chapterIds.filter(
        (chapterId) => !isChapterAudioReady(taskDir, chapterId),
      );
      if (missingChapterIds.length > 0) {
        await settleM4bFailure(`章节 WAV 缺失（${missingChapterIds.slice(0, 5).join(",")}）`);
        return;
      }

      const marked = await prisma.audiobookTask.updateMany({
        where: {
          id: parentTaskId,
          status: "succeeded",
          m4bGenerationToken: generationToken,
          resultJson: markerRow.resultJson,
        },
        data: {
          currentItemLabel: M4B_ENCODING_LABEL,
          resultJson: markM4bEncodingInResultJson(markerRow.resultJson),
          heartbeatAt: new Date(),
        },
      });
      if (marked.count === 0) return;

      if (!force && isFullBookM4bReady(taskDir)) {
        await this.persistBackgroundM4bSettle(parentTaskId, M4B_DONE_LABEL, {
          status: "ready",
          path: "full-book.m4b",
          bytes: fs.statSync(resolveFullBookM4bPath(taskDir)).size,
          chapterCount: chapterIds.length,
        }, { force, generationToken });
        return;
      }
      const chapterMeta = await prisma.chapter.findMany({
        where: { novelId, id: { in: chapterIds } },
        select: { id: true, title: true, order: true },
      });
      const orderById = new Map(chapterMeta.map((c) => [c.id, c]));
      const novel = await prisma.novel.findUnique({
        where: { id: novelId },
        select: { title: true },
      });
      const gapMs = resolveBetweenChapterGapMs();
      const m4b = await encodeFullBookM4b({
        taskDir,
        bookTitle: novel?.title?.trim() || parentTitle || "有声书",
        sourceWavPath: resolveFullBookAudioPath(taskDir),
        betweenChapterGapMs: gapMs,
        chapters: chapterIds.map((id, index) => {
          const meta = orderById.get(id);
          return {
            chapterId: id,
            chapterTitle: meta?.title ?? `第 ${index + 1} 章`,
            chapterOrder: meta?.order ?? index + 1,
            wavPath: resolveChapterAudioPath(taskDir, id),
          };
        }),
        signal: controller.signal,
        generationToken,
        isGenerationCurrent: () => this.isCurrentM4bGeneration(parentTaskId, generationToken),
      });
      if (m4b.status === "ready") {
        await this.persistBackgroundM4bSettle(
          parentTaskId,
          M4B_DONE_LABEL,
          {
            status: "ready",
            path: m4b.relativePath,
            bytes: m4b.bytes ?? null,
            chapterCount: m4b.chapterCount ?? null,
          },
          { force, generationToken },
        );
        return;
      }
      const reason = m4b.reason ?? m4b.status;
      console.warn("[audiobook] background m4b encode not ready", parentTaskId, reason);
      if (m4b.status === "skipped") {
        await this.persistBackgroundM4bSettle(
          parentTaskId,
          `有声书生成完成；m4b 未生成（${reason}）`,
          { status: "skipped", reason },
          { force, generationToken },
        );
      } else {
        await settleM4bFailure(reason);
      }
    } catch (error) {
        console.warn(
          "[audiobook] background m4b encode exception",
          parentTaskId,
          error instanceof Error ? error.message : error,
        );
        // R5：终极 catch 也必须收 label，否则父 succeeded 但 label 久留「m4b 后台封装中」假象
        try {
          const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 120);
          await this.persistBackgroundM4bSettle(
            parentTaskId,
            `有声书生成完成；m4b 失败（${errMsg}）`,
            { status: "failed", reason: errMsg },
            { force, generationToken },
          );
        } catch (labelError) {
          console.warn("[audiobook] m4b failure label update failed", parentTaskId, labelError);
        }
    } finally {
      const active = this.activeM4bControllers.get(parentTaskId);
      if (active?.token === generationToken) this.activeM4bControllers.delete(parentTaskId);
    }
  }

  /** 代际轮换时中止当前进程内的旧 ffmpeg；跨重启 worker 由 token 校验拒绝写入。 */
  private abortBackgroundM4b(taskId: string): void {
    const active = this.activeM4bControllers.get(taskId);
    if (!active) return;
    this.activeM4bControllers.delete(taskId);
    active.controller.abort();
  }

  /**
   * 后台 m4b 收口：label + resultJson.m4b.status 一次写完。
   *
   * label 与 m4bStatus 必须同一次 CAS 落库——分两次写会出现「label 说完成、
   * m4bStatus 仍 null」的中间态，前端正是靠 m4bStatus 决定给不给下载入口。
   * 所有权由 status=succeeded ∧ generation token 确定；label 只是可变的进度文案，
   * 不能继续充当 CAS key。resultJson 需读-改-写，故以完整快照做乐观 CAS；
   * 同代竞态未落终态时交给小型投影重试队列，任一合法终态已存在则幂等结束。
   */
  private async settleBackgroundM4b(
    parentTaskId: string,
    label: string,
    m4b: { status: "ready" | "skipped" | "failed"; path?: string | null; reason?: string | null; bytes?: number | null; chapterCount?: number | null },
    opts: { generationToken: string },
  ): Promise<void> {
    const row = await prisma.audiobookTask.findUnique({
      where: { id: parentTaskId },
      select: { resultJson: true, m4bGenerationToken: true },
    });
    if (!row || row.m4bGenerationToken !== opts.generationToken) {
      console.warn("[audiobook] m4b settle generation stale", parentTaskId, m4b.status);
      return;
    }
    if (readTerminalM4bState(row.resultJson) !== null) {
      return;
    }
    const claimed = await prisma.audiobookTask.updateMany({
      where: {
        id: parentTaskId,
        status: "succeeded",
        resultJson: row.resultJson,
        m4bGenerationToken: opts.generationToken,
      },
      data: {
        currentItemLabel: label,
        resultJson: mergeM4bIntoResultJson(row?.resultJson, m4b),
        heartbeatAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      console.warn("[audiobook] m4b settle CAS missed", parentTaskId, m4b.status);
      const latest = await prisma.audiobookTask.findUnique({
        where: { id: parentTaskId },
        select: {
          resultJson: true,
          status: true,
          currentItemLabel: true,
          m4bGenerationToken: true,
        },
      });
      // A concurrent resultJson update can make the optimistic CAS miss while
      // this generation still owns a non-terminal projection. Retrying is
      // required even when another writer removed the m4b field entirely;
      // otherwise the completed file has no durable terminal projection.
      if (
        latest?.m4bGenerationToken === opts.generationToken
        && latest.status === "succeeded"
        && readTerminalM4bState(latest.resultJson) === null
      ) {
        throw new Error("m4b settle CAS conflict while the current generation is still non-terminal");
      }
    }
  }

  private async persistBackgroundM4bSettle(
    parentTaskId: string,
    label: string,
    m4b: { status: "ready" | "skipped" | "failed"; path?: string | null; reason?: string | null; bytes?: number | null; chapterCount?: number | null },
    opts: { force?: boolean; generationToken: string },
  ): Promise<void> {
    await this.backgroundM4bSettleRetry.persist(
      parentTaskId,
      () => this.settleBackgroundM4b(
        parentTaskId,
        label,
        m4b,
        { generationToken: opts.generationToken },
      ),
      (error, context) => {
        console.warn("[audiobook] m4b terminal projection retry scheduled", {
          taskId: parentTaskId,
          generationToken: opts.generationToken,
          status: m4b.status,
          attempt: context.attempt,
          delayMs: context.delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  /**
   * 级联取消挂在本父上的 queued/running 续生成子任务。父已停/将停，子不得继续在父目录产 wav。
   */
  private async cancelChildContinueTasks(parentTaskId: string): Promise<void> {
    let children: Array<{
      id: string;
      status: string;
      progressJson: string | null;
      m4bGenerationToken: string | null;
    }> = [];
    try {
      // 全局 task 队列串行（processQueue while-await + this.processing guard），queued+running 同时刻上限很小；
      // 2000 为足够留余量的扫描窗口，覆盖异常堆积。若真触顶说明队列失控，需告警排查，不能静默漏取消。
      children = await prisma.audiobookTask.findMany({
        where: { status: { in: ["queued", "running"] } },
        select: { id: true, status: true, progressJson: true, m4bGenerationToken: true },
        take: 2000,
      }) as typeof children;
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) return;
      throw error;
    }
    if (children.length >= 2000) {
      console.warn(
        "[audiobook] cancelChildContinueTasks 触顶 2000，可能存在子任务堆积未完成取消，请排查队列状态。parentTaskId=",
        parentTaskId,
      );
    }
    const mine = children.filter(
      (row) => readParentTaskIdFromProgress(row.progressJson) === parentTaskId,
    );
    for (const child of mine) {
      this.removeFromQueue(child.id);
      this.activeControllers.get(child.id)?.abort();
      try {
        await prisma.audiobookTask.updateMany({
          where: {
            id: child.id,
            status: { in: ["queued", "running"] },
            ...m4bGenerationWhere(child.m4bGenerationToken),
          },
          data: {
            status: "cancelled",
            finishedAt: new Date(),
            currentStage: "cancelled",
            currentItemLabel: "已取消（父任务取消）",
            cancelRequestedAt: null,
            heartbeatAt: new Date(),
          },
        });
      } catch {
        // 表缺失/单行错不阻断父取消
      }
    }
  }


  /**
   * 重启后把在途任务挂起等人工恢复（不自动重跑）。
   *
   * 当前 audiobook 走的是自动恢复（RecoveryTaskService → resumePendingTasks），本方法暂无调用者，
   * 保留作为「需人工确认再跑」运维模式的入口。已请求取消的行必须排除：把它们改回 queued 并清
   * cancelRequestedAt 等于让用户取消过的任务在人工恢复时复活。
   */
  async markPendingTasksForManualRecovery(): Promise<void> {
    try {
      const rows = await prisma.audiobookTask.findMany({
        where: {
          status: { in: ["queued", "running"] },
          pendingManualRecovery: false,
          cancelRequestedAt: null,
        },
        select: { id: true, status: true, currentStage: true },
        orderBy: { createdAt: "asc" },
      });
      if (rows.length === 0) {
        return;
      }

      // continuing 父不能被改成 queued：它没有自己的流水线，人工恢复会让它当普通任务重跑全书。
      const runningIds = rows
        .filter((item) => item.status === "running" && item.currentStage !== "continuing")
        .map((item) => item.id);
      if (runningIds.length > 0) {
        await prisma.audiobookTask.updateMany({
          where: { id: { in: runningIds }, cancelRequestedAt: null },
          data: {
            status: "queued",
            pendingManualRecovery: true,
            error: "服务重启后，有声书任务已暂停，等待手动恢复。",
            heartbeatAt: null,
            currentStage: "queued",
            currentItemKey: null,
          },
        });
      }

      const queuedIds = rows.filter((item) => item.status === "queued").map((item) => item.id);
      if (queuedIds.length > 0) {
        await prisma.audiobookTask.updateMany({
          where: { id: { in: queuedIds }, cancelRequestedAt: null },
          data: {
            pendingManualRecovery: true,
            error: "服务重启后，有声书任务已暂停，等待手动恢复。",
            heartbeatAt: null,
          },
        });
      }
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return;
      }
      throw error;
    }
  }

  async resumePendingTasks(): Promise<void> {
    try {
      const recoveryErrors: unknown[] = [];
      // Orphan cleanup only needs one process table snapshot per recovery
      // round. Reusing it avoids spawning a short-lived `ps` child for every
      // recovered row during a large restart, while kill(0) still confirms
      // each selected PID has actually exited.
      let orphanProcessSnapshot: Promise<string | null> | null = null;
      const getOrphanProcessSnapshot = (): Promise<string | null> => {
        orphanProcessSnapshot ??= captureOrphanM4bProcessSnapshot();
        return orphanProcessSnapshot;
      };
      // Active tasks do not need resultJson at all. Keep the large historical
      // payload column out of that scan; succeeded rows are scanned separately
      // because only they can carry a durable m4b=encoding marker.
      recoveryErrors.push(...await this.scanAudiobookRecoveryPages(
        { status: { in: ["queued", "running"] } },
        ["queued", "running"],
        {
          id: true,
          novelId: true,
          title: true,
          chapterIdsJson: true,
          status: true,
          outputDir: true,
          progress: true,
          progressJson: true,
          currentStage: true,
          cancelRequestedAt: true,
          m4bGenerationToken: true,
        },
        getOrphanProcessSnapshot,
      ));
      recoveryErrors.push(...await this.scanAudiobookRecoveryPages(
        // Legacy rows may contain pretty-printed JSON (`"status": "encoding"`).
        // Keep the DB prefilter broad; readBackgroundM4bState below remains the
        // exact semantic filter before any recovery is scheduled.
        { status: "succeeded", resultJson: { contains: "encoding" } },
        ["succeeded"],
        {
          id: true,
          novelId: true,
          title: true,
          chapterIdsJson: true,
          status: true,
          resultJson: true,
          outputDir: true,
          progress: true,
          progressJson: true,
          currentStage: true,
          cancelRequestedAt: true,
          m4bGenerationToken: true,
        },
        getOrphanProcessSnapshot,
      ));
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          recoveryErrors,
          `${recoveryErrors.length} audiobook task(s) failed startup recovery`,
        );
      }
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return;
      }
      throw error;
    }
  }

  private async scanAudiobookRecoveryPages(
    where: Prisma.AudiobookTaskWhereInput,
    allowedStatuses: readonly string[],
    select: Prisma.AudiobookTaskSelect,
    getOrphanProcessSnapshot: () => Promise<string | null>,
  ): Promise<unknown[]> {
    const recoveryErrors: unknown[] = [];
    let cursor: { id: string } | undefined;
    while (true) {
      const rows = await prisma.audiobookTask.findMany({
        where,
        select,
        orderBy: { id: "asc" },
        take: AUDIOBOOK_RECOVERY_PAGE_SIZE,
        ...(cursor ? { cursor, skip: 1 } : {}),
      }) as unknown as AudiobookRecoveryRow[];
      if (rows.length === 0) return recoveryErrors;
      const matchingRows = rows.filter((row) => allowedStatuses.includes(row.status));
      if (matchingRows.length > 0) {
        recoveryErrors.push(...await this.resumePendingTaskRows(matchingRows, getOrphanProcessSnapshot));
      }
      if (rows.length < AUDIOBOOK_RECOVERY_PAGE_SIZE) return recoveryErrors;
      cursor = { id: rows[rows.length - 1].id };
    }
  }

  private async resumePendingTaskRows(
    rows: AudiobookRecoveryRow[],
    getOrphanProcessSnapshot: () => Promise<string | null>,
  ): Promise<unknown[]> {
      const recoveryErrors: unknown[] = [];

      // 带 cancelRequestedAt 的行：用户已请求取消，执行器在重启中丢失，无人 ack。
      // 原实现把 cancelRequestedAt 一并清空再重排队 = 把用户取消过的任务复活重跑。
      // 正确做法是替执行器完成 ack，落 cancelled 终态。
      const cancelRequested = rows.filter((row) => Boolean(row.cancelRequestedAt));
      for (const row of cancelRequested) {
        try {
          await this.markCancelledIfActive(
            row.id,
            row.progress ?? 0,
            ["queued", "running"],
            row.m4bGenerationToken,
          );
        } catch (error) {
          recoveryErrors.push(error);
          console.warn(
            "[audiobook] resumePendingTasks 收口已请求取消的任务失败",
            row.id,
            error instanceof Error ? error.message : error,
          );
        }
      }

      // 续生成期间：父任务 status=running + currentStage="continuing"（仅子任务干活）不可重入父流水线，
      // 否则重启会把父当正常 running 重跑全书、覆盖 currentStage/annotationsJson/resultJson，并与子任务抢队列。
      // 续生成子任务（progressJson.parentTaskId 非空）正常恢复。
      const pending = rows.filter((row) => !row.cancelRequestedAt && row.status !== "succeeded");
      const m4bRecoveries = rows.filter((row) => (
        row.status === "succeeded"
        && !row.cancelRequestedAt
        && readBackgroundM4bState(row.resultJson) === "encoding"
      ));

      // m4b 是父任务 succeeded 后的独立后台工作，不得重新跑整条 TTS 管线。
      // 只凭持久 resultJson.m4b=encoding 识别，进程重启后仍可恢复。
      const cleanupBlocked = new Set<string>();
      for (const row of m4bRecoveries) {
        const taskDir = row.outputDir?.trim() || resolveAudiobookTaskDir(row.novelId, row.id);
        try {
          const cleaned = await killOrphanM4bFfmpeg(taskDir, await getOrphanProcessSnapshot());
          if (!cleaned) {
            const error = new Error(`任务 ${row.id} 的孤儿 m4b 进程尚未确认退出`);
            recoveryErrors.push(error);
            cleanupBlocked.add(row.id);
            console.warn(
              "[audiobook] resumePendingTasks m4b 孤儿进程未清理完成，暂不重启编码",
              row.id,
            );
            continue;
          }
          const chapterIds = parseChapterIds(row.chapterIdsJson);
          if (chapterIds.length > 0) {
            // 重启恢复必须先轮换代际，再启动新 worker：即使旧进程未能及时
            // 被 SIGKILL，旧结果也不能越过 token fence 写回新一轮。
            const recoveryToken = newM4bGenerationToken();
            const claimed = await prisma.audiobookTask.updateMany({
              where: {
                id: row.id,
                status: "succeeded",
                resultJson: row.resultJson,
                ...m4bGenerationWhere(row.m4bGenerationToken),
              },
              data: {
                m4bGenerationToken: recoveryToken,
                currentItemLabel: M4B_ENCODING_LABEL,
              },
            });
            if (claimed.count > 0) {
              // The ffmpeg job can legitimately run for tens of minutes. Startup
              // recovery only needs to claim and enqueue it; awaiting completion
              // here would keep /health/ready degraded for the whole encode.
              void Promise.resolve(this.scheduleBackgroundM4bEncode({
                parentTaskId: row.id,
                novelId: row.novelId,
                parentTitle: row.title,
                taskDir,
                chapterIds,
                generationToken: recoveryToken,
              })).catch(async (error) => {
                const reason = (error instanceof Error ? error.message : String(error)).slice(0, 240);
                console.warn("[audiobook] detached m4b recovery worker failed", row.id, reason);
                // The row was already claimed as encoding. A detached rejection
                // must not leave that durable marker orphaned forever: settle a
                // fenced terminal failure so the next recovery scan can move on.
                try {
                  await this.persistBackgroundM4bSettle(
                    row.id,
                    `有声书生成完成；m4b 失败（${reason}）`,
                    { status: "failed", reason },
                    { generationToken: recoveryToken },
                  );
                } catch (settleError) {
                  console.warn(
                    "[audiobook] detached m4b recovery failure settle failed",
                    row.id,
                    settleError instanceof Error ? settleError.message : settleError,
                  );
                }
              });
            }
          } else {
            // A malformed/legacy marker must not be left in `encoding` forever.
            // Persist a terminal failure after claiming the same generation so
            // readiness retries cannot rediscover this row on every restart.
            const recoveryToken = newM4bGenerationToken();
            const claimed = await prisma.audiobookTask.updateMany({
              where: {
                id: row.id,
                status: "succeeded",
                resultJson: row.resultJson,
                ...m4bGenerationWhere(row.m4bGenerationToken),
              },
              data: {
                m4bGenerationToken: recoveryToken,
                currentItemLabel: M4B_ENCODING_LABEL,
              },
            });
            if (claimed.count > 0) {
              await this.persistBackgroundM4bSettle(
                row.id,
                "有声书生成完成；m4b 失败（任务章节列表为空）",
                { status: "failed", reason: "任务章节列表为空" },
                { generationToken: recoveryToken },
              );
            }
          }
        } catch (error) {
          recoveryErrors.push(error);
          console.warn(
            "[audiobook] resumePendingTasks m4b recovery failed",
            row.id,
            error instanceof Error ? error.message : error,
          );
        }
      }
      const continuingParents = pending.filter((row) => row.currentStage === "continuing");
      const resumables = pending.filter((row) => row.currentStage !== "continuing");

      // continuing 父不重入流水线，但也不能放着不管：若它的子任务已不在 queued/running
      //（进程被杀时子任务连同队列一起消失），父就成了孤儿——watchdog 跳过 continuing、
      // 续生成因父非终态 409，永远卡 running。此处按磁盘 ready 强制收口。
      for (const parentRow of continuingParents) {
        try {
          const liveChildren = await this.countLiveContinueChildren(parentRow.id);
          if (liveChildren > 0) continue;
          // reconcile 抛错（WAV 格式不一、磁盘满、DB 抖动）时也必须走兜底，否则孤儿父继续卡
          // continuing。兜底不能与 reconcile 共用一个 catch——那样抛错时兜底反被跳过。
          try {
            await this.reconcileParent(parentRow.id);
          } catch (reconcileError) {
            console.warn(
              "[audiobook] resumePendingTasks reconcileParent 失败，转兜底",
              parentRow.id,
              reconcileError instanceof Error ? reconcileError.message : reconcileError,
            );
          }
          await this.forceContinueParentTerminal(parentRow.id);
        } catch (error) {
          recoveryErrors.push(error);
          console.warn(
            "[audiobook] resumePendingTasks 收口孤儿 continuing 父失败",
            parentRow.id,
            error instanceof Error ? error.message : error,
          );
        }
      }

      if (resumables.length === 0) {
        return recoveryErrors;
      }
      // 宿主重启后，在途 ffmpeg 已变孤儿（PPID=1）继续写 taskDir 的 m4b part；重排队前
      // best-effort kill，并等待有界退出后再重排队，避免与新 run 交错写同一 inode。
      // 清理未确认完成的行本轮不重排队，等待下一轮域级恢复重试。
      for (const row of resumables) {
        try {
          const taskDir = row.outputDir?.trim()
            || resolveAudiobookTaskDir(row.novelId, row.id);
          const cleaned = await killOrphanM4bFfmpeg(taskDir, await getOrphanProcessSnapshot());
          if (!cleaned) {
            const error = new Error(`任务 ${row.id} 的孤儿 m4b 进程尚未确认退出`);
            recoveryErrors.push(error);
            cleanupBlocked.add(row.id);
            console.warn(
              "[audiobook] resumePendingTasks 孤儿 m4b 未清理完成，暂不重排队",
              row.id,
            );
            continue;
          }
        } catch (error) {
          recoveryErrors.push(error);
          cleanupBlocked.add(row.id);
          console.warn(
            "[audiobook] resumePendingTasks killOrphanM4bFfmpeg 失败",
            row.id,
            error instanceof Error ? error.message : error,
          );
        }
      }
      for (const row of resumables) {
        if (cleanupBlocked.has(row.id)) continue;
        try {
          const claimed = await prisma.audiobookTask.updateMany({
            // The row was read before the cleanup pass. Re-check every mutable
            // recovery field so a cancel/worker transition that wins in the
            // meantime cannot be overwritten back to queued.
            where: {
              id: row.id,
              status: row.status as Prisma.AudiobookTaskWhereInput["status"],
              currentStage: row.currentStage,
              cancelRequestedAt: row.cancelRequestedAt,
              ...m4bGenerationWhere(row.m4bGenerationToken),
            },
            data: {
              status: "queued",
              pendingManualRecovery: false,
              error: null,
              heartbeatAt: null,
              currentStage: "queued",
              currentItemKey: null,
              // 重启恢复是新一代；旧进程/孤儿 worker 仅凭旧 token 不能再写。
              m4bGenerationToken: newM4bGenerationToken(),
            },
          });
          if (claimed.count > 0) this.enqueueTask(row.id);
        } catch (error) {
          recoveryErrors.push(error);
          console.warn(
            "[audiobook] resumePendingTasks 重排任务失败",
            row.id,
            error instanceof Error ? error.message : error,
          );
        }
      }
      return recoveryErrors;
  }

  /** 挂在该父上、仍在 queued/running 的续生成子任务数（用于判断 continuing 父是否成孤儿） */
  private async countLiveContinueChildren(parentTaskId: string): Promise<number> {
    // This is a boolean gate in the caller, but it must scan beyond the first
    // page: truncating at 2000 can incorrectly finalize a continuing parent
    // while a live child is on a later page.
    let cursor: { id: string } | undefined;
    while (true) {
      const rows = await prisma.audiobookTask.findMany({
        where: { status: { in: ["queued", "running"] } },
        select: { id: true, progressJson: true },
        orderBy: { id: "asc" },
        take: 2000,
        ...(cursor ? { cursor, skip: 1 } : {}),
      });
      if (rows.some(
        (row) => row.id !== parentTaskId && readParentTaskIdFromProgress(row.progressJson) === parentTaskId,
      )) {
        return 1;
      }
      if (rows.length < 2000) return 0;
      cursor = { id: rows[rows.length - 1].id };
    }
  }

  async resumeTask(taskId: string): Promise<AudiobookTaskDetail> {
    const task = await prisma.audiobookTask.findUnique({
      where: { id: taskId },
      select: { status: true, currentStage: true, cancelRequestedAt: true },
    });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    if (task.status !== "queued" && task.status !== "running") {
      throw new AppError("仅排队中或运行中的有声书任务可恢复。", 400);
    }
    // 已请求取消的任务不得被 resume 复活：清 cancelRequestedAt 会让执行器的终态 CAS
    //（where cancelRequestedAt=null）与 resume 的重排队互相打架，跑完的结果被丢弃。
    if (task.cancelRequestedAt) {
      throw new AppError("该任务已请求取消，无法恢复。请等待取消完成后重试。", 409);
    }
    // continuing 父没有自己的流水线，重排队会让它当普通任务重跑全书、覆盖 annotationsJson。
    if (task.currentStage === "continuing") {
      throw new AppError("续生成进行中的父任务不可恢复，请等待续生成子任务结束。", 409);
    }

    this.activeControllers.get(taskId)?.abort();
    this.abortBackgroundM4b(taskId);
    await prisma.audiobookTask.update({
      where: { id: taskId },
      data: {
        status: "queued",
        pendingManualRecovery: false,
        heartbeatAt: null,
        error: null,
        currentStage: "queued",
        currentItemLabel: "排队中",
        m4bGenerationToken: newM4bGenerationToken(),
      },
    });
    this.enqueueTask(taskId);
    const detail = await this.getTask(taskId);
    if (!detail) {
      throw new AppError("有声书任务不存在。", 404);
    }
    return detail;
  }

  private removeFromQueue(taskId: string): void {
    if (!this.queueSet.has(taskId)) {
      return;
    }
    this.queueSet.delete(taskId);
    const index = this.queue.indexOf(taskId);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private enqueueTask(taskId: string): void {
    if (this.queueSet.has(taskId)) {
      return;
    }
    this.queue.push(taskId);
    this.queueSet.add(taskId);
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const taskId = this.queue.shift();
        if (!taskId) {
          continue;
        }
        this.queueSet.delete(taskId);
        await this.executeTask(taskId);
      }
    } finally {
      this.processing = false;
      // 执行期间若有新入队，继续消费
      if (this.queue.length > 0) {
        void this.processQueue();
      }
    }
  }

  /**
   * 执行完整流水线：LLM 按章标注 → chunk TTS → 章/全书 WAV。
   * resume：已存在 chapter.wav / chunk-*.wav / annotations 时跳过。
   */
  private async executeTask(taskId: string): Promise<void> {
    const task = await prisma.audiobookTask.findUnique({ where: { id: taskId } });
    if (!task) {
      return;
    }
    // 兼容迁移前创建的任务：首次启动时补发持久代际，避免空 token 继续允许
    // 旧 worker 写入；新任务则沿用入口已签发的 token。
    const generationToken = task.m4bGenerationToken?.trim() || newM4bGenerationToken();
    // 续生成子任务 envelope（parentTaskId/hidden）不能被 onProgress 重写丢失。
    // onProgress 每次 progressJson 整串写时展开此 envelope，listByNovel/finalizeContinueChild 才能持续识别父子关系。
    const continueEnvelope = projectContinuePreparationEnvelope(task.progressJson);
    if ((task.status !== "queued" && task.status !== "running") || task.pendingManualRecovery) {
      return;
    }
    if (task.cancelRequestedAt) {
      await this.markCancelledIfActive(task.id, task.progress, ["queued", "running"], generationToken);
      return;
    }

    const controller = new AbortController();
    this.activeControllers.set(taskId, controller);
    const stopHeartbeat = this.startTaskHeartbeat(taskId, generationToken);
    let continuePreparationSettlementInProgress = false;

    try {
      const claimed = await prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: "queued",
          cancelRequestedAt: null,
          pendingManualRecovery: false,
          // 迁移前旧行可能是 NULL；Prisma 的 null 谓词必须保留，不能改成空串。
          m4bGenerationToken: task.m4bGenerationToken,
        },
        data: {
          status: "running",
          startedAt: task.startedAt ?? new Date(),
          heartbeatAt: new Date(),
          currentStage: "preparing",
          currentItemLabel: "准备有声书任务",
          progress: 2,
          error: null,
          m4bGenerationToken: generationToken,
        },
      });
      if (claimed.count === 0) {
        if (await this.isCancelRequested(taskId)) {
          await this.markCancelledIfActive(taskId, task.progress, ["queued", "running"], generationToken);
          await this.finalizeContinueChild(taskId, true, generationToken);
        }
        return;
      }

      if (controller.signal.aborted || (await this.isCancelRequested(taskId))) {
        await this.markCancelledIfActive(taskId, 2, ["running"], generationToken);
        await this.finalizeContinueChild(taskId, true, generationToken);
        return;
      }

      const chapterIds = parseChapterIds(task.chapterIdsJson);
      if (chapterIds.length === 0) {
        await this.markFailedIfRunning(taskId, "任务缺少章节列表，无法继续。", generationToken);
        await this.finalizeContinueChild(taskId, true, generationToken);
        return;
      }

      // A continuation shares its parent's output directory. Its child row is
      // therefore also the durable invalidation intent: every run (including a
      // startup replay) must fence against the exact parent generation and
      // strictly remove stale full-book/cache artifacts before reading inputs.
      const continuePreparation = readContinuePreparationIntent(task.progressJson);
      if (continuePreparation) {
        const taskDir = task.outputDir?.trim() || resolveAudiobookTaskDir(task.novelId, task.id);
        try {
          if (!continuePreparation.parentGenerationToken) {
            throw new Error("续生成子任务缺少父任务代际，无法安全失效旧音频。");
          }
          const prepared = await withAudiobookTaskDirArtifactLock(taskDir, async () => {
            const [currentChild, currentParent] = await Promise.all([
              prisma.audiobookTask.findUnique({
                where: { id: taskId },
                select: {
                  status: true,
                  progressJson: true,
                  m4bGenerationToken: true,
                },
              }),
              prisma.audiobookTask.findUnique({
                where: { id: continuePreparation.parentTaskId },
                select: {
                  status: true,
                  currentStage: true,
                  cancelRequestedAt: true,
                  m4bGenerationToken: true,
                },
              }),
            ]);
            const currentIntent = readContinuePreparationIntent(currentChild?.progressJson);
            if (
              !currentChild
              || currentChild.status !== "running"
              || currentChild.m4bGenerationToken !== generationToken
              || !currentIntent
              || currentIntent.parentTaskId !== continuePreparation.parentTaskId
              || currentIntent.parentGenerationToken !== continuePreparation.parentGenerationToken
              || currentIntent.mode !== continuePreparation.mode
              || !currentParent
              || currentParent.status !== "running"
              || currentParent.currentStage !== "continuing"
              || Boolean(currentParent.cancelRequestedAt)
              || currentParent.m4bGenerationToken !== continuePreparation.parentGenerationToken
            ) {
              return false;
            }
            prepareContinueArtifacts({
              taskDir,
              chapterIds,
              mode: currentIntent.mode,
            });
            return true;
          });
          if (!prepared) {
            // The parent or child has moved to another generation. Settling
            // only this hidden child avoids a delayed replay touching the
            // current parent's state or artifacts.
            await this.markCancelledIfActive(taskId, task.progress, ["running"], generationToken);
            return;
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          // Parent first: if this DB write fails, leaving the child active keeps
          // startup recovery from reconciling the parent against stale disk.
          continuePreparationSettlementInProgress = true;
          const parentFailed = await this.failContinueParentPreparation({
            parentTaskId: continuePreparation.parentTaskId,
            parentGenerationToken: continuePreparation.parentGenerationToken,
            failedChapterIds: chapterIds,
            reason,
          });
          continuePreparationSettlementInProgress = false;
          if (parentFailed) {
            await this.markFailedIfRunning(taskId, reason, generationToken);
          } else {
            // Parent moved/cancelled/new generation won. This child is stale and
            // must settle without changing the current parent's state.
            await this.markCancelledIfActive(taskId, task.progress, ["running"], generationToken);
          }
          return;
        }
      }

      // A reprocess intent is persisted before its destructive wipe. Re-check
      // and replay the wipe after the queued→running claim so a crash between
      // either DB write and the filesystem operation cannot resume with stale
      // chapter audio. The operation is idempotent; repeating it is safe.
      const reprocessIntent = readReprocessIntent(task.progressJson);
      if (reprocessIntent) {
        const taskDir = task.outputDir?.trim() || resolveAudiobookTaskDir(task.novelId, task.id);
        const prepared = await withAudiobookTaskDirArtifactLock(taskDir, async () => {
          const current = await prisma.audiobookTask.findUnique({
            where: { id: taskId },
            select: {
              status: true,
              progressJson: true,
              m4bGenerationToken: true,
            },
          });
          const currentIntent = readReprocessIntent(current?.progressJson);
          if (
            !current
            || current.status !== "running"
            || current.m4bGenerationToken !== generationToken
            || !currentIntent
            || currentIntent.chapterId !== reprocessIntent.chapterId
            || currentIntent.mode !== reprocessIntent.mode
          ) {
            return false;
          }
          // Always replay: the process may have died after deleting only a
          // subset of files. Every cleanup operation is idempotent, so a full
          // replay is safer than maintaining another two-phase completion bit.
          wipeChapterAudioArtifacts(taskDir, currentIntent.chapterId);
          if (currentIntent.mode === "reannotate") {
            wipeChapterAnnotationArtifact(taskDir, currentIntent.chapterId);
          }
          return true;
        });
        if (!prepared) return;
      }

      // 执行期用任务快照 chapterIds + 当前角色音色表（不重做 scope 解析）
      const novel = await prisma.novel.findUnique({
        where: { id: task.novelId },
        select: {
          title: true,
          characters: {
            select: {
              id: true,
              name: true,
              ttsMode: true,
              ttsVoice: true,
              ttsStyle: true,
              ttsDesignPrompt: true,
              ttsRefAudioPath: true,
              ttsVoiceAssetId: true,
              ttsSpeakerAliases: true,
              personality: true,
              voiceTexture: true,
            },
          },
        },
      });
      if (!novel) {
        await this.markFailedIfRunning(taskId, "小说不存在。", generationToken);
        await this.finalizeContinueChild(taskId, true, generationToken);
        return;
      }
      const characterVoices = novel.characters
        .map((character) => {
          const modeRaw = character.ttsMode?.trim();
          const ttsMode: "preset" | "design" | "clone" =
            modeRaw === "design" || modeRaw === "clone" ? modeRaw : "preset";
          let ttsRefAudioPath = character.ttsRefAudioPath?.trim() || null;
          if (ttsMode === "clone") {
            try {
              ttsRefAudioPath = resolveEffectiveCloneRefPath({
                ttsVoiceAssetId: character.ttsVoiceAssetId,
                ttsRefAudioPath: character.ttsRefAudioPath,
                requireApproved: true,
              });
            } catch {
              // 门禁循环会用 checkVoiceRefAudioPath 报具体错误；这里保留 legacy path 或空
              ttsRefAudioPath = tryResolveEffectiveCloneRefPath({
                ttsVoiceAssetId: null,
                ttsRefAudioPath: character.ttsRefAudioPath,
              });
            }
          }
          return {
            characterId: character.id,
            characterName: character.name,
            ttsMode,
            ttsVoice: character.ttsVoice?.trim() || null,
            ttsStyle: character.ttsStyle ?? null,
            ttsDesignPrompt: character.ttsDesignPrompt?.trim() || null,
            ttsRefAudioPath,
            ttsVoiceAssetId: character.ttsVoiceAssetId?.trim() || null,
            speakerAliases: parseSpeakerAliases(character.ttsSpeakerAliases),
            personality: character.personality ?? null,
            voiceTexture: character.voiceTexture ?? null,
          };
        });

      // 执行前硬门禁：配置了却不可读/无效的绑定直接 fail，禁止静默滤成「全旁白」
      // 与 precheck 对齐：preset 必须在 MiMo 预置表内
      const executeBindingErrors: string[] = [];
      const narratorVoice = task.narratorVoice?.trim() || "";
      if (!narratorVoice) {
        executeBindingErrors.push("旁白未配置 narratorVoice。");
      } else if (!isMimoTtsPresetVoice(narratorVoice)) {
        executeBindingErrors.push(
          `旁白音色「${narratorVoice}」不在 MiMo 预置表中（旁白仅支持 preset）。`,
        );
      }
      for (const character of characterVoices) {
        if (character.ttsMode === "design") {
          if (!character.ttsDesignPrompt) {
            executeBindingErrors.push(
              `角色「${character.characterName}」design 模式缺少 ttsDesignPrompt。`,
            );
          }
          continue;
        }
        if (character.ttsMode === "clone") {
          const assetId = (character as { ttsVoiceAssetId?: string | null }).ttsVoiceAssetId?.trim() || "";
          if (assetId) {
            try {
              const resolved = resolveEffectiveCloneRefPath({
                ttsVoiceAssetId: assetId,
                ttsRefAudioPath: character.ttsRefAudioPath,
                requireApproved: true,
              });
              if (!resolved) {
                executeBindingErrors.push(
                  `角色「${character.characterName}」库资产 ${assetId} 无法解析参考音频。`,
                );
                continue;
              }
              character.ttsRefAudioPath = resolved;
            } catch (error) {
              executeBindingErrors.push(
                `角色「${character.characterName}」${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }
          }
          const refPath = character.ttsRefAudioPath?.trim() || "";
          if (!refPath) {
            executeBindingErrors.push(
              `角色「${character.characterName}」clone 模式缺少 ttsRefAudioPath。`,
            );
            continue;
          }
          const checked = checkVoiceRefAudioPath(refPath);
          if (!checked.ok) {
            executeBindingErrors.push(
              `角色「${character.characterName}」${checked.reason}`,
            );
          }
          continue;
        }
        const voice = character.ttsVoice?.trim() || "";
        if (!voice) {
          executeBindingErrors.push(
            `角色「${character.characterName}」preset 模式未配置 ttsVoice。`,
          );
        } else if (!isMimoTtsPresetVoice(voice)) {
          executeBindingErrors.push(
            `角色「${character.characterName}」音色「${voice}」不在 MiMo 预置表中。`,
          );
        }
      }
      if (executeBindingErrors.length > 0) {
        await this.markFailedIfRunning(
          taskId,
          `执行前音色门禁失败：${executeBindingErrors.slice(0, 5).join("；")}${
            executeBindingErrors.length > 5 ? ` 等 ${executeBindingErrors.length} 项` : ""
          }`,
          generationToken,
        );
        await this.finalizeContinueChild(taskId, true, generationToken);
        return;
      }

      const usableCharacterVoices = characterVoices.filter((character) => {
        if (character.ttsMode === "design") {
          return Boolean(character.ttsDesignPrompt);
        }
        if (character.ttsMode === "clone") {
          return Boolean(character.ttsRefAudioPath);
        }
        const voice = character.ttsVoice?.trim() || "";
        return Boolean(voice) && isMimoTtsPresetVoice(voice);
      });

      const deliveryStyleMode = readDeliveryStyleModeFromTask(task);
      const isContinueChild = Boolean(readParentTaskIdFromProgress(task.progressJson));
      const result = await audiobookPipelineService.run({
        taskId,
        novelId: task.novelId,
        novelTitle: novel.title,
        chapterIds,
        narrator: {
          voice: task.narratorVoice,
          style: task.narratorStyle,
        },
        characterVoices: usableCharacterVoices,
        provider: (task.provider as LLMProvider | null) ?? null,
        model: task.model,
        temperature: task.temperature,
        deliveryStyleMode,
        signal: controller.signal,
        // 代际被轮换也视为取消：旧 pipeline 不再继续写共享章/全书产物。
        isCancelRequested: async () => (
          (await this.isCancelRequested(taskId))
          || !(await this.isCurrentM4bGeneration(taskId, generationToken, true))
        ),
        generationToken,
        // 主流水线在 status=running 时封装；后台重做 worker 则只接受 succeeded。
        isGenerationCurrent: (token) => this.isCurrentM4bGeneration(taskId, token, true),
        // 续生成子任务：用父 outputDir（落章 wav 进父目录，父 reconcile 可见）；否则 null → 默认新建任务目录。
        outputDir: task.outputDir?.trim() || null,
        // 续生成子任务跳过全书合并/m4b，父 full-book 由 reconcileParent 重拼。
        isContinueChild,
        onProgress: async (progress) => {
          if (await this.isCancelRequested(taskId)) {
            return;
          }
          const annotateWeight = 0.25;
          const synthWeight = 0.7;
          let ratio = 0.05;
          if (progress.phase === "annotating") {
            ratio = 0.05 + annotateWeight * ((progress.chapterIndex + 1) / Math.max(1, progress.chapterCount));
          } else if (progress.phase === "synthesizing" || progress.phase === "merging") {
            const chunkRatio = progress.totalChunksEstimate > 0
              ? progress.completedChunks / progress.totalChunksEstimate
              : progress.completedChapters / Math.max(1, progress.chapterCount);
            ratio = 0.05 + annotateWeight + synthWeight * Math.min(1, chunkRatio);
          } else if (progress.phase === "finalizing") {
            ratio = 0.98;
          }
          const nextProgress = Math.max(2, Math.min(99, Math.round(ratio * 100)));
          // annotationsJson 仅在标注完成/终态写入，避免每 chunk 写放大
          const shouldPersistAnnotations = Boolean(
            progress.annotations
            && (progress.phase === "annotating" || progress.phase === "finalizing"),
          );
          await prisma.audiobookTask.updateMany({
            where: {
              id: taskId,
              status: "running",
              cancelRequestedAt: null,
              m4bGenerationToken: generationToken,
            },
            data: {
              progress: nextProgress,
              heartbeatAt: new Date(),
              currentStage: progress.phase,
              currentItemKey: progress.chapterId,
              currentItemLabel: progress.message.slice(0, 200),
              completedChapterCount: progress.completedChapters,
              ...(shouldPersistAnnotations
                ? { annotationsJson: JSON.stringify(progress.annotations) }
                : {}),
              progressJson: JSON.stringify({
                ...continueEnvelope,
                deliveryStyleMode,
                phase: progress.phase,
                chapterIndex: progress.chapterIndex,
                chapterCount: progress.chapterCount,
                completedChunks: progress.completedChunks,
                totalChunksEstimate: progress.totalChunksEstimate,
                chapterAudioCount: progress.chapterAudioPaths.length,
                fullAudioReady: Boolean(progress.fullAudioPath),
                qualityWarnings: progress.qualityWarnings ?? [],
                chapterProgress: progress.chapterProgress ?? [],
              }),
            },
          });
        },
      });

      if (controller.signal.aborted || (await this.isCancelRequested(taskId))) {
        // pipeline 已返回后的取消竞态：子章可能已落父目录，必须 finalize 父，
        // 否则父卡 running/continuing（与 5d71171 要消灭的 orphan class 同类）
        await this.markCancelledIfActive(taskId, 95, ["running"], generationToken);
        await this.finalizeContinueChild(taskId, true, generationToken);
        return;
      }

      const annotationFallbackCount = countNarratorFallbackChapters(result.annotations);
      const qualityFlags: AudiobookQualityFlag[] = collectTaskQualityFlags(result.annotations);
      const annotationSuffix = annotationFallbackCount > 0
        ? `；标注回退 ${annotationFallbackCount} 章`
        : qualityFlags.includes("cast_degraded")
          ? "；cast 降级"
          : "";
      const m4bSuffix = result.m4b.status === "ready"
        ? "，含 m4b"
        : result.m4b.status === "skipped"
          ? `；m4b 未生成（${result.m4b.reason ?? "skipped"}）`
          : result.m4b.status === "failed"
            ? `；m4b 失败（${result.m4b.reason ?? "failed"}）`
            : "";
      const m4bNote = result.m4b.status === "skipped"
        ? `m4b 未生成（${result.m4b.reason ?? "skipped"}）`
        : result.m4b.status === "failed"
          ? `m4b 失败（${result.m4b.reason ?? "failed"}）`
          : undefined;
      const currentItemLabel = buildQualityCompletionLabel({
        qualityFlags,
        narratorFallbackCount: annotationFallbackCount,
        m4bReady: result.m4b.status === "ready",
        m4bNote,
      });

      // 成功后删 chunk，保留 chapter.wav / full-book.*；重合成会 wipe 整章再生成
      const chapterIdsForPrune = result.chapterAudioPaths.map((item) => item.chapterId);
      let chunksPruned = false;
      let prunedChunkFiles = 0;
      try {
        prunedChunkFiles = pruneChunkWavArtifacts(result.outputDir, chapterIdsForPrune);
        chunksPruned = true;
      } catch (pruneError) {
        chunksPruned = false;
        prunedChunkFiles = 0;
        console.warn(
          "[audiobook] pruneChunkWavArtifacts failed",
          taskId,
          pruneError instanceof Error ? pruneError.message : pruneError,
        );
      }

      // Continue children invalidated shared full-book artifacts under the
      // generation fence before pipeline reads. The child pipeline never
      // recreates them; reconcileParent alone rebuilds from the full chapter set.

      await prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: "running",
          cancelRequestedAt: null,
          m4bGenerationToken: generationToken,
        },
        data: {
          status: "succeeded",
          progress: 100,
          finishedAt: new Date(),
          currentStage: "finalizing",
          currentItemLabel,
          heartbeatAt: new Date(),
          completedChapterCount: result.completedChapterCount,
          outputDir: result.outputDir,
          // 续生成子任务跳过全书写入；存相对逻辑名，避免 DATA_ROOT 迁移后绝对路径失效
          fullAudioPath: isContinueChild ? null : "full-book.wav",
          annotationsJson: JSON.stringify(result.annotations),
          resultJson: JSON.stringify({
            chapterIds: chapterIdsForPrune,
            completedChunks: result.completedChunks,
            qualityWarnings: result.qualityWarnings,
            qualityFlags,
            narratorFallbackChapterCount: annotationFallbackCount,
            castDegraded: qualityFlags.includes("cast_degraded"),
            chunksPruned,
            prunedChunkFiles,
            m4b: {
              status: result.m4b.status,
              path: result.m4b.relativePath,
              reason: result.m4b.reason ?? null,
              bytes: result.m4b.bytes ?? null,
              chapterCount: result.m4b.chapterCount ?? null,
            },
          }),
          summary: `有声书完成：${result.completedChapterCount} 章，${result.completedChunks} 个音频块${annotationSuffix}${m4bSuffix}。`,
          error: null,
        },
      });

      // 续生成子任务成功 → 重算父 readyChapterIds / chapterProgress（磁盘唯一真相）
      await this.finalizeContinueChild(taskId, false, generationToken);
    } catch (error) {
      if (continuePreparationSettlementInProgress) {
        // Do not terminalize the child without the parent failure marker. A
        // still-active child makes startup recovery retry the durable cleanup
        // instead of accepting old disk artifacts as a successful generation.
        console.warn(
          "[audiobook] continue preparation failure settlement deferred",
          taskId,
          error instanceof Error ? error.message : error,
        );
        return;
      }
      if (
        error instanceof PipelineCancelledError
        || controller.signal.aborted
        || (await this.isCancelRequested(taskId))
      ) {
        await this.markCancelledIfActive(taskId, task.progress, ["running", "queued"], generationToken);
        await this.finalizeContinueChild(taskId, true, generationToken);
        return;
      }
      await this.markFailedIfRunning(
        taskId,
        error instanceof Error ? error.message : "有声书任务执行失败。",
        generationToken,
      );
      await this.finalizeContinueChild(taskId, true, generationToken);
    } finally {
      stopHeartbeat();
      this.activeControllers.delete(taskId);
    }
  }

  /**
   * 续生成子任务终态后：若本行 progressJson.parentTaskId 非空，
   * 重算父 readyChapterIds/chapterProgress + 失败章回写父 progressJson.failedContinueChapters。
   * 失败章 = 子 chapterIdsJson 中磁盘未就绪的差集。
   */
  private async finalizeContinueChild(
    taskId: string,
    failed: boolean,
    generationToken?: string | null,
  ): Promise<void> {
    let row: {
      progressJson: string | null;
      chapterIdsJson: string | null;
      novelId: string;
      m4bGenerationToken: string | null;
    } | null = null;
    try {
      row = await prisma.audiobookTask.findUnique({
        where: { id: taskId },
        select: {
          progressJson: true,
          chapterIdsJson: true,
          novelId: true,
          m4bGenerationToken: true,
        },
      });
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) return;
      throw error;
    }
    if (!row) return;
    if (generationToken !== undefined && row.m4bGenerationToken !== generationToken) return;
    const parentTaskId = readParentTaskIdFromProgress(row.progressJson);
    if (!parentTaskId) return;

    if (failed) {
      const childChapterIds = parseChapterIds(row.chapterIdsJson);
      const parent = await prisma.audiobookTask.findUnique({
        where: { id: parentTaskId },
        select: { id: true, chapterIdsJson: true, outputDir: true, novelId: true },
      });
      let readyIds = new Set<string>();
      if (parent) {
        const dir = parent.outputDir?.trim() || resolveAudiobookTaskDir(parent.novelId, parent.id);
        try {
          readyIds = new Set(listReadyChapterAudioIds(dir, parseChapterIds(parent.chapterIdsJson)));
        } catch {
          readyIds = new Set();
        }
      }
      const failedChapters = childChapterIds.filter((id) => !readyIds.has(id));
      if (failedChapters.length > 0) {
        await appendFailedContinueChapters(parentTaskId, failedChapters);
      }
    }

    try {
      await this.reconcileParent(parentTaskId);
    } catch (error) {
      console.warn(
        "[audiobook] reconcileParent failed for continue child",
        taskId,
        parentTaskId,
        error instanceof Error ? error.message : error,
      );
      // R4 兜底：reconcile 抛错时父仍卡 running/continuing——按磁盘 ready 强制翻终态
      try {
        await this.forceContinueParentTerminal(parentTaskId);
      } catch (fallbackError) {
        console.warn(
          "[audiobook] forceContinueParentTerminal fallback failed",
          parentTaskId,
          fallbackError instanceof Error ? fallbackError.message : fallbackError,
        );
      }
    }
  }

  /**
   * R4 兜底：reconcileParent 失败时强制把父从 running/continuing 翻终态。
   *
   * 不重复 reconcileParent 全流程——只按磁盘 ready 判最终状态：
   * - 全 ready → succeeded（best-effort 重拼，失败则 fullAudioPath=null）
   * - 否则 → failed + 写 failedContinueChapters
   * CAS where `status in (running, queued)` 保证 cancelled 等先到的终态不被覆盖。
   */
  private async forceContinueParentTerminal(parentTaskId: string): Promise<void> {
    const parent = await prisma.audiobookTask.findUnique({
      where: { id: parentTaskId },
      select: {
        id: true,
        novelId: true,
        outputDir: true,
        chapterIdsJson: true,
        progressJson: true,
        m4bGenerationToken: true,
      },
    });
    if (!parent) return;
    const chapterIds = parseChapterIds(parent.chapterIdsJson);
    const taskDir = parent.outputDir?.trim() || resolveAudiobookTaskDir(parent.novelId, parent.id);
    let readyChapterIds: string[] = [];
    try {
      readyChapterIds = listReadyChapterAudioIds(taskDir, chapterIds);
    } catch {
      readyChapterIds = [];
    }
    const allReady = chapterIds.length > 0 && readyChapterIds.length === chapterIds.length;

    if (allReady) {
      // 全章已就绪：best-effort 重拼全书，翻 succeeded
      let fullAudioReady = false;
      try {
        if (!isFullBookAudioReady(taskDir)) {
          const chapterPaths = chapterIds.map((id) => resolveChapterAudioPath(taskDir, id));
          const gaps = chapterPaths.length > 1
            ? Array.from({ length: chapterPaths.length - 1 }, () => resolveBetweenChapterGapMs())
            : [];
          concatWavFiles(chapterPaths, resolveFullBookAudioPath(taskDir), gaps);
        }
        fullAudioReady = isFullBookAudioReady(taskDir);
      } catch {
        fullAudioReady = false;
      }
      await prisma.audiobookTask.updateMany({
        where: {
          id: parentTaskId,
          status: { in: ["running", "queued"] },
          m4bGenerationToken: parent.m4bGenerationToken,
        },
        data: {
          status: "succeeded",
          progress: 100,
          completedChapterCount: readyChapterIds.length,
          fullAudioPath: fullAudioReady ? "full-book.wav" : null,
          currentStage: "finalizing",
          currentItemLabel: "有声书生成完成（reconcile 兜底）",
          error: null,
          finishedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
    } else {
      // 部分/全部未就绪：翻 failed + 记失败章
      const readySet = new Set(readyChapterIds);
      const failedChapters = chapterIds.filter((id) => !readySet.has(id));
      if (failedChapters.length > 0) {
        try {
          await appendFailedContinueChapters(parentTaskId, failedChapters);
        } catch {
          // 兜底层：追加失败章也失败时不抛——翻终态优先
        }
      }
      const failureLabel = `reconcile 异常兜底，已就绪 ${readyChapterIds.length}/${chapterIds.length} 章`;
      await prisma.audiobookTask.updateMany({
        where: {
          id: parentTaskId,
          status: { in: ["running", "queued"] },
          m4bGenerationToken: parent.m4bGenerationToken,
        },
        data: {
          status: "failed",
          progress: Math.max(2, Math.min(99, Math.round(
            (readyChapterIds.length / Math.max(1, chapterIds.length)) * 100,
          ))),
          completedChapterCount: readyChapterIds.length,
          fullAudioPath: null,
          currentStage: "failed",
          currentItemLabel: failureLabel,
          error: failureLabel,
          finishedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
    }
  }

  private startTaskHeartbeat(taskId: string, generationToken?: string | null): () => void {
    const timer = setInterval(() => {
      void prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: "running",
          ...m4bGenerationWhere(generationToken),
        },
        data: { heartbeatAt: new Date() },
      }).catch(() => undefined);
    }, AUDIOBOOK_HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  private async isCancelRequested(taskId: string): Promise<boolean> {
    const row = await prisma.audiobookTask.findUnique({
      where: { id: taskId },
      select: { cancelRequestedAt: true, status: true },
    });
    if (!row) {
      return true;
    }
    if (row.status === "cancelled") {
      return true;
    }
    return Boolean(row.cancelRequestedAt);
  }

  /** 读取持久化代际，供后台 m4b worker 在启动/rename 前校验。 */
  private async isCurrentM4bGeneration(
    taskId: string,
    generationToken: string,
    allowRunning = false,
  ): Promise<boolean> {
    const row = await prisma.audiobookTask.findUnique({
      where: { id: taskId },
      select: { status: true, cancelRequestedAt: true, m4bGenerationToken: true },
    });
    const statusAllowed = row?.status === "succeeded" || (allowRunning && row?.status === "running");
    return Boolean(statusAllowed && !row?.cancelRequestedAt && row.m4bGenerationToken === generationToken);
  }

  /** CAS 终态 cancelled：仅当 status 仍在允许集合内 */
  private async markCancelledIfActive(
    taskId: string,
    progress: number,
    allowedStatuses: Array<"queued" | "running">,
    generationToken?: string | null,
  ): Promise<void> {
    await prisma.audiobookTask.updateMany({
      where: {
        id: taskId,
        status: { in: allowedStatuses },
        ...m4bGenerationWhere(generationToken),
      },
      data: {
        status: "cancelled",
        progress,
        finishedAt: new Date(),
        currentStage: "cancelled",
        currentItemLabel: "已取消",
        error: "有声书任务已取消。",
        cancelRequestedAt: null,
        heartbeatAt: new Date(),
      },
    });
  }

  /** @returns 实际翻 failed 的行数（0 = CAS 未命中，任务已被别的路径终态化） */
  /**
   * P1-5：失败时尽力自检产物，写进 resultJson.artifacts，供前端/运维区分
   * 「整本全废」与「完成了 N/M，只是没攒成全本」——失败不再抹掉已有成果信息。
   * 纯现场快照：readyChapterCount / totalChapterCount / fullWavBytes / m4bPresent。
   * 任何 IO 异常都吞掉，绝不影响真正把任务翻 failed 的 CAS。
   */
  private buildFailureArtifacts(input: {
    outputDir: string | null;
    novelId: string;
    taskId: string;
    chapterIds: string[];
  }): {
    readyChapterCount: number;
    totalChapterCount: number;
    fullWavBytes: number | null;
    m4bPresent: boolean;
  } {
    try {
      const taskDir = input.outputDir?.trim()
      || resolveAudiobookTaskDir(input.novelId, input.taskId);
      const ready = listReadyChapterAudioIds(taskDir, input.chapterIds).length;
      let fullWavBytes: number | null = null;
      if (isFullBookAudioReady(taskDir)) {
        try {
          fullWavBytes = fs.statSync(resolveFullBookAudioPath(taskDir)).size;
        } catch {
          fullWavBytes = null;
        }
      }
      let m4bPresent = false;
      try {
        m4bPresent = fs.existsSync(resolveFullBookM4bPath(taskDir));
      } catch {
        m4bPresent = false;
      }
      return {
        readyChapterCount: ready,
        totalChapterCount: input.chapterIds.length,
        fullWavBytes,
        m4bPresent,
      };
    } catch {
      return {
        readyChapterCount: 0,
        totalChapterCount: input.chapterIds.length,
        fullWavBytes: null,
        m4bPresent: false,
      };
    }
  }

  /**
   * 把任务翻 failed（CAS running→failed），同时尽力合并产物自检到 resultJson。
   * 自检失败/异常绝不阻塞翻终态——纯尽力。
   */
  private async markFailedIfRunning(
    taskId: string,
    message: string,
    generationToken?: string | null,
  ): Promise<number> {
    // 先取行解析 outputDir/chapterIds 供产物自检（best-effort，失败则空 artifact）
    let audit: {
      readyChapterCount: number;
      totalChapterCount: number;
      fullWavBytes: number | null;
      m4bPresent: boolean;
    } | null = null;
    let row: {
      novelId: string;
      outputDir: string | null;
      chapterIdsJson: string | null;
      resultJson: string | null;
    } | null = null;
    try {
      row = await prisma.audiobookTask.findUnique({
        where: { id: taskId },
        select: { novelId: true, outputDir: true, chapterIdsJson: true, resultJson: true },
      });
      if (row) {
        audit = this.buildFailureArtifacts({
          chapterIds: parseChapterIds(row.chapterIdsJson),
          novelId: row.novelId,
          outputDir: row.outputDir,
          taskId,
        });
      }
    } catch {
      audit = null;
    }

    const claimed = await prisma.audiobookTask.updateMany({
      where: {
        id: taskId,
        status: "running",
        cancelRequestedAt: null,
        ...m4bGenerationWhere(generationToken),
      },
      data: {
        status: "failed",
        finishedAt: new Date(),
        currentStage: "failed",
        currentItemLabel: "失败",
        error: message,
        heartbeatAt: new Date(),
        // P1-5 产物自检——仅 merge，不覆盖已有 success/m4b 等
        resultJson: audit
          ? this.mergeFailureArtifactsIntoResultJson(row?.resultJson ?? null, audit)
          : undefined,
      },
    });
    return claimed.count;
  }

  /**
   * P1-5：把产物自检 merge 进既有 resultJson（读-改-写）。
   */
  private mergeFailureArtifactsIntoResultJson(
    resultJson: string | null | undefined,
    artifacts: {
      readyChapterCount: number;
      totalChapterCount: number;
      fullWavBytes: number | null;
      m4bPresent: boolean;
    },
  ): string {
    let base: Record<string, unknown> = {};
    if (resultJson?.trim()) {
      try {
        const parsed = JSON.parse(resultJson) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          base = parsed as Record<string, unknown>;
        }
      } catch {
        base = {};
      }
    }
    return JSON.stringify({ ...base, artifacts });
  }

  /**
   * 启动 watchdog（幂等）。app.ts 启动阶段调一次即可；重复调用是安全的。
   * 内部 setInterval 用 unref() 不阻塞进程退出。
   */
  startWatchdog(): void {
    if (this.watchdogTimer) return;
    const tick = () => {
      this.runWatchdogTick().catch((error) => {
        console.warn("[audiobook.watchdog] tick failed", error);
      });
    };
    this.watchdogTimer = setInterval(tick, AUDIOBOOK_WATCHDOG_INTERVAL_MS);
    if (typeof this.watchdogTimer.unref === "function") {
      this.watchdogTimer.unref();
    }
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.watchdogStallState.clear();
    this.backgroundM4bSettleRetry.stop();
  }

  /**
   * Watchdog 单周期：
   * 1. 找出全部 running 任务（跳过 currentStage="continuing" 的父任务——它们的推进由子任务承担，本身不动）
   * 2. 与 watchdogStallState 上一轮信号对比，用 computeWatchdogDecision 判定
   * 3. fail=true 则 CAS markFailedIfRunning，把假 running 翻终态
   * 4. 用当前 running 集重建 map，防止长期泄漏
   */
  private async runWatchdogTick(): Promise<void> {
    let rows: Array<{
      id: string;
      progress: number | null;
      currentStage: string | null;
      currentItemKey: string | null;
      completedChapterCount: number | null;
      progressJson: string | null;
      outputDir: string | null;
      novelId: string;
      m4bGenerationToken: string | null;
    }>;
    try {
      rows = await prisma.audiobookTask.findMany({
        where: { status: "running", cancelRequestedAt: null },
        select: {
          id: true,
          progress: true,
          currentStage: true,
          currentItemKey: true,
          completedChapterCount: true,
          progressJson: true,
          outputDir: true,
          novelId: true,
          m4bGenerationToken: true,
        },
      });
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) return;
      throw error;
    }

    const alive = new Set<string>();
    for (const row of rows) {
      // 续生成父：currentStage="continuing"，父身不动——推进由 child 承担，跳过判定
      if ((row.currentStage ?? "") === "continuing") {
        this.watchdogStallState.delete(row.id);
        continue;
      }
      alive.add(row.id);
      const curr = projectWatchdogSignal(row);
      const prev = this.watchdogStallState.get(row.id) ?? null;
      // R2-2: finalizing/m4b 编码阶段放宽容忍（m4b 封装期五元组冻结属正常）
      let m4bEncodingOnDisk = false;
      try {
        const taskDir = row.outputDir?.trim()
          || resolveAudiobookTaskDir(row.novelId, row.id);
        // 唯一 run part 名（full-book.m4b.<runId>.part）下仍要宽容：taskDir 内存在任一
        // `full-book.m4b*.part` 即判 m4b 在途。
        m4bEncodingOnDisk = hasInFlightM4bPart(taskDir);
      } catch {
        m4bEncodingOnDisk = false;
      }
      const finalizeTolerant = isWatchdogFinalizingTolerant({
        currentStage: row.currentStage,
        progress: row.progress,
        m4bEncodingOnDisk,
      });
      const stallPeriods = finalizeTolerant
        ? AUDIOBOOK_WATCHDOG_FINALIZE_STALL_PERIODS
        : AUDIOBOOK_WATCHDOG_STALL_PERIODS;
      const decision = computeWatchdogDecision({
        prev,
        curr,
        stallPeriods,
      });
      this.watchdogStallState.set(row.id, {
        signal: decision.signal,
        stallCount: decision.stallCount,
      });
      if (decision.fail) {
        const stalledSeconds = Math.round(
          (AUDIOBOOK_WATCHDOG_INTERVAL_MS * decision.stallCount) / 1000,
        );
        console.warn(
          "[audiobook.watchdog] stall detected → markFailedIfRunning",
          {
            taskId: row.id,
            stage: curr.stage,
            itemKey: curr.itemKey,
            progress: curr.progress,
            completedChapters: curr.completedChapters,
            completedChunks: curr.completedChunks,
            stalledSeconds,
          },
        );
        try {
          const failedCount = await this.markFailedIfRunning(
            row.id,
            `watchdog: 任务 ${stalledSeconds}s 未推进，判定假 running 已终止。`,
            row.m4bGenerationToken,
          );
          if (failedCount > 0) {
            // 必须 abort：翻 failed 只改 DB 行，pipeline 本身还活着。
            // 「无推进」≠「已死」——TTS 慢过阈值就会误判，随后它会恢复并继续写磁盘。
            // 此时 onProgress 的 CAS（status="running"）落空后只是静默 return，既不抛也不停，
            // 子会一路跑到成功路径再调一次 reconcileParent，而父已终态、CAS 命中 0 行，
            // 新写好的章永远反映不进父 progressJson（盘上有音频，前端却标黄）。
            this.activeControllers.get(row.id)?.abort();
            // 续生成子任务被 watchdog 翻 fail 时，executeTask 的 finalizeContinueChild
            // 钩子不会触发（那 9 个调用点全在 executeTask 内）。若不在此显式收口，
            // 父会永久卡 running+continuing——watchdog 跳过它、resumePendingTasks 跳过它、
            // continueParentTask 因父非终态 409 拒绝重试，三条自愈路径同时关闭。
            if (readParentTaskIdFromProgress(row.progressJson)) {
              await this.finalizeContinueChild(row.id, true, row.m4bGenerationToken);
            }
          }
        } catch (error) {
          // 这个 try 现在覆盖翻 fail + 续生成收口两步，文案不能只指前者
          console.warn("[audiobook.watchdog] 翻 fail / 续生成收口失败", {
            taskId: row.id,
            error,
          });
        }
        this.watchdogStallState.delete(row.id);
      }
    }

    // GC：任何不再 running 的 id 从 stall map 清除
    for (const id of Array.from(this.watchdogStallState.keys())) {
      if (!alive.has(id)) this.watchdogStallState.delete(id);
    }
  }
}

export const audiobookTaskService = new AudiobookTaskService();
