import type {
  AudiobookChapterAnnotation,
  AudiobookChapterReprocessMode,
  AudiobookTaskAnnotationsView,
  AudiobookTaskDetail,
  AudiobookTaskSummary,
  ContinueAudiobookTaskInput,
  CreateAudiobookTaskInput,
  DeliveryStyleMode,
} from "@ai-novel/shared/types/audiobook";
import { isMimoTtsPresetVoice } from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { toTaskTokenUsageSummary } from "../task/taskTokenUsageSummary";
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
  isFullBookAudioReady,
  listReadyChapterAudioIds,
  pruneChunkWavArtifacts,
  resolveAudiobookTaskDir,
  resolveChapterAudioPath,
  resolveFullBookAudioPath,
  resolveFullBookM4bPath,
  safeUnlink,
  wipeChapterAnnotationArtifact,
  wipeChapterAudioArtifacts,
} from "./audiobookPaths";
import { resolveBetweenChapterGapMs } from "./audiobookGap";
import { concatWavFiles } from "./audiobookWav";
import { resolveDeliveryStyleMode } from "./deliveryStyle";
import { checkVoiceRefAudioPath } from "./voiceRefPath";
import { resolveEffectiveCloneRefPath, tryResolveEffectiveCloneRefPath } from "./voiceLibraryService";

const AUDIOBOOK_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.AUDIOBOOK_TASK_HEARTBEAT_INTERVAL_MS ?? 10_000) || 10_000,
);

const DEFAULT_MAX_RETRIES = 1;

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

/** 把失败章合并进父 progressJson 的 failedContinueChapters（去重，整串写一次）。 */
async function appendFailedContinueChapters(
  parentTaskId: string,
  failedChapterIds: string[],
): Promise<void> {
  const parent = await prisma.audiobookTask.findUnique({
    where: { id: parentTaskId },
    select: { progressJson: true },
  });
  if (!parent) return;
  const progress = parseProgressJson(parent.progressJson);
  const existing = readFailedContinueChapters(parent.progressJson);
  const merged = Array.from(new Set([...existing, ...failedChapterIds]));
  const nextProgress: Record<string, unknown> = {
    ...progress,
    deliveryStyleMode: progress.deliveryStyleMode ?? null,
    failedContinueChapters: merged,
  };
  await prisma.audiobookTask.update({
    where: { id: parentTaskId },
    data: { progressJson: JSON.stringify(nextProgress) },
  });
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

function collectAnnotationWarnings(annotations: AudiobookChapterAnnotation[]): string[] {
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
  }
  return warnings;
}

/** 仅统计「整章旁白回退」类 error，不含截断/剥表演等软警告 */
function countNarratorFallbackChapters(annotations: AudiobookChapterAnnotation[]): number {
  return annotations.filter((item) => Boolean(item.error?.trim())).length;
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

function parseM4bStatusFromResultJson(resultJson: string | null | undefined): AudiobookTaskSummary["m4bStatus"] {
  if (!resultJson?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(resultJson) as { m4b?: { status?: string } };
    const status = parsed?.m4b?.status;
    if (status === "ready" || status === "skipped" || status === "failed") {
      return status;
    }
    return null;
  } catch {
    return null;
  }
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
    m4bStatus: parseM4bStatusFromResultJson(row.resultJson),
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

  private processing = false;

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
      const rows = await prisma.audiobookTask.findMany({
        where: { novelId },
        include: { novel: { select: { id: true, title: true } } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: Math.max(1, Math.min(100, take)),
      });
      // 隐闭续生成子任务不进列表：进度合入父，前端只见父行
      const visible = rows.filter(
        (row) => !readParentTaskIdFromProgress((row as AudiobookTaskRow).progressJson),
      );
      return visible.map((row) => toSummary(row as AudiobookTaskRow));
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return [];
      }
      throw error;
    }
  }

  async cancelTask(taskId: string): Promise<AudiobookTaskDetail> {
    const task = await prisma.audiobookTask.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
      throw new AppError("仅排队中或运行中的有声书任务可取消。", 400);
    }

    // 级联取消挂在本父上的隐闭续生成子任务（queued/running），避免父停子续在父目录产 wav
    if (!readParentTaskIdFromProgress(task.progressJson)) {
      await this.cancelChildContinueTasks(taskId);
    }

    // 无论 queued/running：先从内存队列剔除，并写 cancelRequestedAt + abort
    this.removeFromQueue(taskId);
    await prisma.audiobookTask.update({
      where: { id: taskId },
      data: {
        cancelRequestedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
    this.activeControllers.get(taskId)?.abort();

    if (task.status === "queued") {
      // CAS：仅当仍为 queued 时终态 cancelled，避免与已进入 execute 的 running 打架
      await this.markCancelledIfActive(taskId, task.progress, ["queued"]);
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
      },
    });
    this.enqueueTask(taskId);
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

    const taskDir = resolveAudiobookTaskDir(task.novelId, task.id);
    wipeChapterAudioArtifacts(taskDir, chapterId);

    let nextAnnotationsJson = task.annotationsJson;
    if (input.mode === "reannotate") {
      wipeChapterAnnotationArtifact(taskDir, chapterId);
      const remaining = parseAnnotationsJson(task.annotationsJson)
        .filter((item) => item.chapterId !== chapterId);
      nextAnnotationsJson = remaining.length > 0 ? JSON.stringify(remaining) : null;
    }

    const modeLabel = input.mode === "reannotate" ? "重标并重合成" : "重合成";
    await prisma.audiobookTask.update({
      where: { id: task.id },
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
        currentItemKey: chapterId,
        currentItemLabel: `排队：${modeLabel}章节`,
        fullAudioPath: null,
        annotationsJson: nextAnnotationsJson,
        summary: null,
        resultJson: null,
      },
    });
    this.enqueueTask(task.id);
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
    const title = `${parent.title}（续生成 ${requestedIds.length} 章）`;
    const parentDeliveryMode = readDeliveryStyleModeFromTask(parent as AudiobookTaskRow);
    // 续生成起点 progress：父当前已就绪章占比（开始后随子完成 reconcile 推进）
    let parentReadyBaseline = 0;
    try {
      parentReadyBaseline = listReadyChapterAudioIds(parentOutputDir, parentChapterIds).length;
    } catch {
      parentReadyBaseline = 0;
    }
    const parentProgressBaseline = parentChapterIds.length > 0
      ? Math.max(2, Math.min(95, Math.round((parentReadyBaseline / parentChapterIds.length) * 100)))
      : 2;

    const child = await prisma.audiobookTask.create({
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
        progressJson: JSON.stringify({
          deliveryStyleMode: parentDeliveryMode,
          hidden: true,
          parentTaskId: parent.id,
          mode: input.mode ?? null,
        }),
      },
      include: { novel: { select: { id: true, title: true } } },
    });

    // 父置回 running：前端 4s 轮询见父 status=running + currentItemLabel=续生成
    await prisma.audiobookTask.updateMany({
      where: { id: parent.id, status: { in: ["succeeded", "failed"] } },
      data: {
        status: "running",
        currentStage: "continuing",
        currentItemLabel: `续生成 ${precheck.chapterCount} 章`,
        progress: parentProgressBaseline,
        fullAudioPath: null,
        resultJson: null,
      },
    });

    this.enqueueTask(child.id);
    return toDetail(child as AudiobookTaskRow);
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
    // m4b 不在此重做（重编码 20min 级、ffmpeg 子进程），父如需 m4b 走自己的路径；全书 wav 即可播。
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
    // 续生成期间父 progress 反映 ready/total（避免旧终态 100 与 running 矛盾）；全 ready 翻 100
    const parentProgress = allReady
      ? 100
      : Math.max(2, Math.min(99, Math.round((readyChapterIds.length / Math.max(1, chapterIds.length)) * 100)));

    if (allReady) {
      // 全部就绪：父翻 succeeded，currentStage 收尾
      // error:null —— 前次续生成失败留下的 error 文本必须清，否则父 succeeded 仍带旧红字
      await prisma.audiobookTask.update({
        where: { id: parent.id },
        data: {
          progressJson: JSON.stringify(nextProgress),
          progress: 100,
          completedChapterCount: readyChapterIds.length,
          fullAudioPath: fullAudioReady ? "full-book.wav" : parent.fullAudioPath,
          status: "succeeded",
          currentStage: "finalizing",
          currentItemLabel: "有声书生成完成",
          error: null,
          finishedAt: new Date(),
        },
      });
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
    await prisma.audiobookTask.update({
      where: { id: parent.id },
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
      },
    });
  }

  /**
   * 级联取消挂在本父上的 queued/running 续生成子任务。父已停/将停，子不得继续在父目录产 wav。
   */
  private async cancelChildContinueTasks(parentTaskId: string): Promise<void> {
    let children: Array<{ id: string; status: string; progressJson: string | null }> = [];
    try {
      // 全局 task 队列串行（processQueue while-await + this.processing guard），queued+running 同时刻上限很小；
      // 2000 为足够留余量的扫描窗口，覆盖异常堆积。若真触顶说明队列失控，需告警排查，不能静默漏取消。
      children = await prisma.audiobookTask.findMany({
        where: { status: { in: ["queued", "running"] } },
        select: { id: true, status: true, progressJson: true },
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
          where: { id: child.id, status: { in: ["queued", "running"] } },
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


  async markPendingTasksForManualRecovery(): Promise<void> {
    try {
      const rows = await prisma.audiobookTask.findMany({
        where: {
          status: { in: ["queued", "running"] },
          pendingManualRecovery: false,
        },
        select: { id: true, status: true },
        orderBy: { createdAt: "asc" },
      });
      if (rows.length === 0) {
        return;
      }

      const runningIds = rows.filter((item) => item.status === "running").map((item) => item.id);
      if (runningIds.length > 0) {
        await prisma.audiobookTask.updateMany({
          where: { id: { in: runningIds } },
          data: {
            status: "queued",
            pendingManualRecovery: true,
            error: "服务重启后，有声书任务已暂停，等待手动恢复。",
            heartbeatAt: null,
            currentStage: "queued",
            currentItemKey: null,
            cancelRequestedAt: null,
          },
        });
      }

      const queuedIds = rows.filter((item) => item.status === "queued").map((item) => item.id);
      if (queuedIds.length > 0) {
        await prisma.audiobookTask.updateMany({
          where: { id: { in: queuedIds } },
          data: {
            pendingManualRecovery: true,
            error: "服务重启后，有声书任务已暂停，等待手动恢复。",
            heartbeatAt: null,
            cancelRequestedAt: null,
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
      const rows = await prisma.audiobookTask.findMany({
        where: { status: { in: ["queued", "running"] } },
        select: { id: true, progressJson: true, currentStage: true },
        orderBy: { createdAt: "asc" },
      });
      if (rows.length === 0) {
        return;
      }
      // 续生成期间：父任务 status=running + currentStage="continuing"（仅子任务干活）不可重入父流水线，
      // 否则重启会把父当正常 running 重跑全书、覆盖 currentStage/annotationsJson/resultJson，并与子任务抢队列。
      // 续生成子任务（progressJson.parentTaskId 非空）正常恢复。
      const resumables = rows.filter((row) => {
        if (row.currentStage === "continuing") return false;
        return true;
      });
      if (resumables.length === 0) {
        return;
      }
      const ids = resumables.map((row) => row.id);
      await prisma.audiobookTask.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "queued",
          pendingManualRecovery: false,
          error: null,
          heartbeatAt: null,
          currentStage: "queued",
          currentItemKey: null,
          cancelRequestedAt: null,
        },
      });
      for (const id of ids) {
        this.enqueueTask(id);
      }
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) {
        return;
      }
      throw error;
    }
  }

  async resumeTask(taskId: string): Promise<AudiobookTaskDetail> {
    const task = await prisma.audiobookTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!task) {
      throw new AppError("有声书任务不存在。", 404);
    }
    if (task.status !== "queued" && task.status !== "running") {
      throw new AppError("仅排队中或运行中的有声书任务可恢复。", 400);
    }

    await prisma.audiobookTask.update({
      where: { id: taskId },
      data: {
        status: "queued",
        pendingManualRecovery: false,
        heartbeatAt: null,
        cancelRequestedAt: null,
        error: null,
        currentStage: "queued",
        currentItemLabel: "排队中",
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
    // 续生成子任务 envelope（parentTaskId/hidden）不能被 onProgress 重写丢失。
    // onProgress 每次 progressJson 整串写时展开此 envelope，listByNovel/finalizeContinueChild 才能持续识别父子关系。
    const continueEnvelope = ((): Record<string, unknown> => {
      const pid = readParentTaskIdFromProgress(task.progressJson);
      const progress = parseProgressJson(task.progressJson);
      if (!pid) return {};
      return {
        ...(progress.hidden === true ? { hidden: true } : {}),
        parentTaskId: pid,
        ...(typeof progress.mode === "string" ? { mode: progress.mode } : {}),
      };
    })();
    if ((task.status !== "queued" && task.status !== "running") || task.pendingManualRecovery) {
      return;
    }
    if (task.cancelRequestedAt) {
      await this.markCancelledIfActive(task.id, task.progress, ["queued", "running"]);
      return;
    }

    const controller = new AbortController();
    this.activeControllers.set(taskId, controller);
    const stopHeartbeat = this.startTaskHeartbeat(taskId);

    try {
      const claimed = await prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: "queued",
          cancelRequestedAt: null,
          pendingManualRecovery: false,
        },
        data: {
          status: "running",
          startedAt: task.startedAt ?? new Date(),
          heartbeatAt: new Date(),
          currentStage: "preparing",
          currentItemLabel: "准备有声书任务",
          progress: 2,
          error: null,
        },
      });
      if (claimed.count === 0) {
        if (await this.isCancelRequested(taskId)) {
          await this.markCancelledIfActive(taskId, task.progress, ["queued", "running"]);
          await this.finalizeContinueChild(taskId, true);
        }
        return;
      }

      if (controller.signal.aborted || (await this.isCancelRequested(taskId))) {
        await this.markCancelledIfActive(taskId, 2, ["running"]);
        await this.finalizeContinueChild(taskId, true);
        return;
      }

      const chapterIds = parseChapterIds(task.chapterIdsJson);
      if (chapterIds.length === 0) {
        await this.markFailedIfRunning(taskId, "任务缺少章节列表，无法继续。");
        await this.finalizeContinueChild(taskId, true);
        return;
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
        await this.markFailedIfRunning(taskId, "小说不存在。");
        await this.finalizeContinueChild(taskId, true);
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
        );
        await this.finalizeContinueChild(taskId, true);
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
        isCancelRequested: () => this.isCancelRequested(taskId),
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
        await this.markCancelledIfActive(taskId, 95, ["running"]);
        return;
      }

      const annotationFallbackCount = countNarratorFallbackChapters(result.annotations);
      const annotationSuffix = annotationFallbackCount > 0
        ? `；标注回退 ${annotationFallbackCount} 章`
        : "";
      const m4bSuffix = result.m4b.status === "ready"
        ? "，含 m4b"
        : result.m4b.status === "skipped"
          ? `；m4b 未生成（${result.m4b.reason ?? "skipped"}）`
          : result.m4b.status === "failed"
            ? `；m4b 失败（${result.m4b.reason ?? "failed"}）`
            : "";
      const currentItemLabel = annotationFallbackCount > 0
        ? `完成（${annotationFallbackCount} 章旁白回退${result.m4b.status === "ready" ? "，含 m4b" : ""}）`
        : result.m4b.status === "ready"
          ? "有声书生成完成（含 m4b）"
          : "有声书生成完成";

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

      // 续生成子任务：章集变化（父范围的新增/重合成章落盘）→ 父 full-book.wav/m4b
      // 已过期且不可再用；按「章变则全书必须重拼」设计意图删掉，避免父 reconcile 把
      // stale full-book 当作有效全书写回 fullAudioPath。全章 ready 后 reconcileParent 重拼。
      if (isContinueChild) {
        safeUnlink(resolveFullBookAudioPath(result.outputDir));
        safeUnlink(`${resolveFullBookAudioPath(result.outputDir)}.part`);
        safeUnlink(resolveFullBookM4bPath(result.outputDir));
        safeUnlink(`${resolveFullBookM4bPath(result.outputDir)}.part`);
      }

      await prisma.audiobookTask.updateMany({
        where: {
          id: taskId,
          status: "running",
          cancelRequestedAt: null,
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
      await this.finalizeContinueChild(taskId, false);
    } catch (error) {
      if (
        error instanceof PipelineCancelledError
        || controller.signal.aborted
        || (await this.isCancelRequested(taskId))
      ) {
        await this.markCancelledIfActive(taskId, task.progress, ["running", "queued"]);
        await this.finalizeContinueChild(taskId, true);
        return;
      }
      await this.markFailedIfRunning(
        taskId,
        error instanceof Error ? error.message : "有声书任务执行失败。",
      );
      await this.finalizeContinueChild(taskId, true);
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
  private async finalizeContinueChild(taskId: string, failed: boolean): Promise<void> {
    let row: { progressJson: string | null; chapterIdsJson: string | null; novelId: string } | null = null;
    try {
      row = await prisma.audiobookTask.findUnique({
        where: { id: taskId },
        select: { progressJson: true, chapterIdsJson: true, novelId: true },
      });
    } catch (error) {
      if (isMissingAudiobookTaskTableError(error)) return;
      throw error;
    }
    if (!row) return;
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
    }
  }

  private startTaskHeartbeat(taskId: string): () => void {
    const timer = setInterval(() => {
      void prisma.audiobookTask.updateMany({
        where: { id: taskId, status: "running" },
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

  /** CAS 终态 cancelled：仅当 status 仍在允许集合内 */
  private async markCancelledIfActive(
    taskId: string,
    progress: number,
    allowedStatuses: Array<"queued" | "running">,
  ): Promise<void> {
    await prisma.audiobookTask.updateMany({
      where: {
        id: taskId,
        status: { in: allowedStatuses },
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

  private async markFailedIfRunning(taskId: string, message: string): Promise<void> {
    await prisma.audiobookTask.updateMany({
      where: {
        id: taskId,
        status: "running",
        cancelRequestedAt: null,
      },
      data: {
        status: "failed",
        finishedAt: new Date(),
        currentStage: "failed",
        currentItemLabel: "失败",
        error: message,
        heartbeatAt: new Date(),
      },
    });
  }
}

export const audiobookTaskService = new AudiobookTaskService();
