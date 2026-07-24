/**
 * Volume Readiness：assess + plan。
 * 读 quality-debt / 章正文 pad 扫 / 可选 evaluateOnly 补信号；不改正文。
 */

import {
  projectL0ClearFromQualityLoop,
  projectStyleClearFromQualityLoop,
} from "@ai-novel/shared/types/chapterQualityLoop";
import { projectLiteraryPassFromQualityLoopSignals } from "@ai-novel/shared/types/literaryQualityPass";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import {
  PROSE_PAD_HARD_THRESHOLD,
  PROSE_PAD_SOFT_THRESHOLD,
} from "../../../config/proseQuality";
import {
  volumeReadinessConfig,
} from "../../../config/volumeReadiness";
import { prisma } from "../../../db/prisma";
import { AppError } from "../../../middleware/errorHandler";
import { getSharedNovelServices } from "../application/sharedNovelServices";
import {
  parseQualityLoopFromRiskFlags,
} from "../quality/qualityDebtBoard";
import { countPadPhraseHits } from "../runtime/proseQuality/ProseQualityDetector";
import {
  classifyChapterReadiness,
  filterPlansByAction,
  summarizeReadinessPlans,
  type VolumeReadinessActionFilter,
  type VolumeReadinessChapterPlan,
  type VolumeReadinessChapterSignals,
  type VolumeReadinessPolicyThresholds,
  type VolumeReadinessSummary,
} from "./volumeReadinessPolicy";
import {
  countHardDebtFromQualityLoop,
  hasTrueReviewMarker,
  synthesizeSignalsFromEvaluateOnly,
} from "./volumeReadinessSignals";
import { resolveVolumeOrderRange } from "./volumeOrderRange";
import {
  createVolumeReadinessRun,
  ensureVolumeReadinessRunsHydrated,
  findActiveLiveRunForNovel,
  findOpenLiveRunForNovel,
  getVolumeReadinessRun,
  listVolumeReadinessRuns,
  updateVolumeReadinessRun,
  type VolumeReadinessRunBudget,
  type VolumeReadinessRunRecord,
} from "./volumeReadinessRunStore";

const MIN_CONTENT_CHARS = 200;

export interface VolumeReadinessAssessInput {
  volumeOrder?: number | null;
  fromOrder?: number | null;
  toOrder?: number | null;
  /** 信号过期或缺失时是否 evaluateOnly 补算（会调 LLM；默认 false 只读） */
  refresh?: boolean;
}

export interface VolumeReadinessReport {
  novelId: string;
  volumeOrder: number | null;
  fromOrder: number;
  toOrder: number;
  /** 窗来源：workspace 卷表 / 20 章 fallback / 调用方显式 from-to */
  rangeSource: "volume_workspace" | "fallback_20" | "explicit";
  assessedAt: string;
  chapters: VolumeReadinessChapterPlan[];
  summary: VolumeReadinessSummary;
  thresholds: VolumeReadinessPolicyThresholds;
}

export interface VolumeReadinessRunRequest {
  volumeOrder?: number | null;
  fromOrder?: number | null;
  toOrder?: number | null;
  dryRun?: boolean;
  actionFilter?: VolumeReadinessActionFilter[];
  budget?: Partial<VolumeReadinessRunBudget>;
  refresh?: boolean;
  resumeFromRunId?: string | null;
}

function signalStale(evaluatedAt: string | null | undefined, staleHours: number): boolean {
  if (!evaluatedAt) {
    return true;
  }
  const ts = Date.parse(evaluatedAt);
  if (!Number.isFinite(ts)) {
    return true;
  }
  const ageMs = Date.now() - ts;
  return ageMs > staleHours * 60 * 60 * 1000;
}

async function resolveOrderRange(input: {
  novelId: string;
  volumeOrder?: number | null;
  fromOrder?: number | null;
  toOrder?: number | null;
}): Promise<{
  fromOrder: number;
  toOrder: number;
  volumeOrder: number | null;
  rangeSource: "volume_workspace" | "fallback_20" | "explicit";
}> {
  const maxOrderRow = await prisma.chapter.aggregate({
    where: { novelId: input.novelId },
    _max: { order: true },
  });
  const maxOrder = maxOrderRow._max.order ?? 0;
  if (maxOrder <= 0) {
    throw new AppError("当前小说还没有章节。", 400);
  }

  const hasExplicitFrom = typeof input.fromOrder === "number" && Number.isFinite(input.fromOrder);
  const hasExplicitTo = typeof input.toOrder === "number" && Number.isFinite(input.toOrder);

  let fromOrder = hasExplicitFrom
    ? Math.max(1, Math.floor(input.fromOrder as number))
    : 1;
  let toOrder = hasExplicitTo
    ? Math.max(1, Math.floor(input.toOrder as number))
    : maxOrder;
  let volumeOrder = typeof input.volumeOrder === "number" && Number.isFinite(input.volumeOrder)
    ? Math.floor(input.volumeOrder)
    : null;
  let rangeSource: "volume_workspace" | "fallback_20" | "explicit" = "explicit";

  if (volumeOrder != null && !hasExplicitFrom && !hasExplicitTo) {
    const resolved = await resolveVolumeOrderRange({
      novelId: input.novelId,
      volumeOrder,
      maxChapterOrder: maxOrder,
    });
    fromOrder = resolved.fromOrder;
    toOrder = resolved.toOrder;
    rangeSource = resolved.source;
  } else if (hasExplicitFrom || hasExplicitTo) {
    rangeSource = "explicit";
  } else {
    // 全书
    rangeSource = "explicit";
  }

  fromOrder = Math.min(fromOrder, maxOrder);
  toOrder = Math.min(Math.max(toOrder, fromOrder), maxOrder);
  return { fromOrder, toOrder, volumeOrder, rangeSource };
}

function projectSignalsFromChapter(input: {
  id: string;
  order: number;
  title: string | null;
  content: string | null;
  chapterStatus: string | null;
  generationState: string | null;
  riskFlags: string | null;
  contentRevision: number | null;
}): VolumeReadinessChapterSignals {
  const content = input.content ?? "";
  const contentEmpty = content.trim().length < MIN_CONTENT_CHARS;
  const qualityLoop = parseQualityLoopFromRiskFlags(input.riskFlags);
  // 始终优先 live pad 扫（含 0）；不回退旧 qualityLoop 计数，避免词表缩减后低估/高估。
  const padHitCount = contentEmpty ? 0 : countPadPhraseHits(content).totalHits;

  return {
    chapterId: input.id,
    chapterOrder: input.order,
    title: input.title,
    chapterStatus: input.chapterStatus,
    generationState: input.generationState,
    literaryPass: qualityLoop
      ? projectLiteraryPassFromQualityLoopSignals(
        Array.isArray(qualityLoop.signals) ? qualityLoop.signals as Array<{
          artifactType?: string | null;
          status?: string | null;
        }> : [],
      )
      : null,
    l0Clear: qualityLoop ? projectL0ClearFromQualityLoop(qualityLoop) : null,
    styleClear: qualityLoop ? projectStyleClearFromQualityLoop(qualityLoop) : null,
    hardDebtCount: countHardDebtFromQualityLoop(qualityLoop),
    padHitCount,
    hasTrueReview: hasTrueReviewMarker(qualityLoop),
    contentRevision: input.contentRevision,
    lastReviewedAt: qualityLoop && typeof qualityLoop.evaluatedAt === "string"
      ? qualityLoop.evaluatedAt
      : null,
    contentEmpty,
  };
}

function isEvaluateOnlyReview(
  value: unknown,
): value is { score: QualityScore; issues: ReviewIssue[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return Boolean(rec.score && typeof rec.score === "object");
}

export class VolumeReadinessService {
  async assess(novelId: string, input: VolumeReadinessAssessInput = {}): Promise<VolumeReadinessReport> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: { id: true },
    });
    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    const range = await resolveOrderRange({
      novelId,
      volumeOrder: input.volumeOrder,
      fromOrder: input.fromOrder,
      toOrder: input.toOrder,
    });

    const chapters = await prisma.chapter.findMany({
      where: {
        novelId,
        order: { gte: range.fromOrder, lte: range.toOrder },
      },
      select: {
        id: true,
        order: true,
        title: true,
        content: true,
        chapterStatus: true,
        generationState: true,
        riskFlags: true,
        contentRevision: true,
      },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    });

    const thresholds: VolumeReadinessPolicyThresholds = {
      padSoftThreshold: PROSE_PAD_SOFT_THRESHOLD,
      padHardThreshold: PROSE_PAD_HARD_THRESHOLD,
    };

    const plans: VolumeReadinessChapterPlan[] = [];
    const staleHours = volumeReadinessConfig.signalStaleHours;
    const novelService = input.refresh ? getSharedNovelServices() : null;

    for (const chapter of chapters) {
      let signals = projectSignalsFromChapter(chapter);

      const needsRefresh = Boolean(input.refresh)
        && !signals.contentEmpty
        && (
          !signals.hasTrueReview
          || signalStale(signals.lastReviewedAt, staleHours)
          || signals.literaryPass == null
        );

      if (needsRefresh && novelService) {
        try {
          const reviewResult = await novelService.reviewChapter(novelId, chapter.id, {
            evaluateOnly: true,
          });
          // evaluateOnly 不写库：用返回值合成 signals，禁止 re-read riskFlags 空转。
          if (isEvaluateOnlyReview(reviewResult)) {
            signals = synthesizeSignalsFromEvaluateOnly({
              base: signals,
              content: chapter.content ?? "",
              review: {
                score: reviewResult.score,
                issues: Array.isArray(reviewResult.issues) ? reviewResult.issues : [],
              },
            });
          }
        } catch (error) {
          console.warn("[volume.readiness] evaluateOnly refresh failed", {
            novelId,
            chapterId: chapter.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      plans.push(classifyChapterReadiness(signals, thresholds));
    }

    return {
      novelId,
      volumeOrder: range.volumeOrder,
      fromOrder: range.fromOrder,
      toOrder: range.toOrder,
      rangeSource: range.rangeSource,
      assessedAt: new Date().toISOString(),
      chapters: plans,
      summary: summarizeReadinessPlans(plans),
      thresholds,
    };
  }

  async createRun(
    novelId: string,
    request: VolumeReadinessRunRequest = {},
  ): Promise<VolumeReadinessRunRecord> {
    await ensureVolumeReadinessRunsHydrated();

    if (request.resumeFromRunId) {
      const existing = getVolumeReadinessRun(request.resumeFromRunId);
      if (!existing || existing.novelId !== novelId) {
        throw new AppError("resume 的 readiness run 不存在。", 404);
      }
      if (existing.status === "completed" || existing.status === "cancelled") {
        return existing;
      }
      // dead running / planned / failed→允许 re-enter（failed 由调用方新开更常见）
      if (existing.status === "running") {
        // 若 flight 已释放（进程挂了），允许 re-execute；若仍在本进程 flight 中则返回 live
        const active = findActiveLiveRunForNovel(novelId);
        if (active && active.runId === existing.runId) {
          return existing;
        }
        // 降为 planned 供 executor 从 results 断点续跑
        return updateVolumeReadinessRun(existing.runId, {
          status: "planned",
          startedAt: null,
          error: null,
        }) ?? existing;
      }
      if (existing.status === "failed") {
        return updateVolumeReadinessRun(existing.runId, {
          status: "planned",
          finishedAt: null,
          error: null,
        }) ?? existing;
      }
      return existing;
    }

    // live 单 flight：已有 planned/running 时拒绝新建（dryRun 放行）
    if (request.dryRun !== true) {
      const open = findOpenLiveRunForNovel(novelId);
      if (open) {
        throw new AppError(
          `该书已有未完成的 readiness run（${open.runId}, status=${open.status}）。请 cancel 或 resumeFromRunId。`,
          409,
        );
      }
    }

    const report = await this.assess(novelId, {
      volumeOrder: request.volumeOrder,
      fromOrder: request.fromOrder,
      toOrder: request.toOrder,
      refresh: request.refresh === true,
    });

    const actionFilter = (request.actionFilter && request.actionFilter.length > 0)
      ? request.actionFilter
      // 默认不含 needs_heavy（激进须显式）与 needs_polish（policy 当前不产出；executor 仍支持显式）
      : (["needs_re_review", "needs_patch"] as VolumeReadinessActionFilter[]);

    const actionable = filterPlansByAction(report.chapters, actionFilter);
    const budgetDefaults = volumeReadinessConfig.budget;
    const budget: VolumeReadinessRunBudget = {
      maxChapters: request.budget?.maxChapters ?? budgetDefaults.maxChapters,
      maxHeavyRewrites: request.budget?.maxHeavyRewrites ?? budgetDefaults.maxHeavyRewrites,
      maxLlmCalls: request.budget?.maxLlmCalls ?? budgetDefaults.maxLlmCalls,
      maxWallMinutes: request.budget?.maxWallMinutes ?? budgetDefaults.maxWallMinutes,
    };

    return createVolumeReadinessRun({
      novelId,
      volumeOrder: report.volumeOrder,
      fromOrder: report.fromOrder,
      toOrder: report.toOrder,
      rangeSource: report.rangeSource,
      dryRun: request.dryRun === true,
      actionFilter,
      budget,
      plan: actionable,
      planSummary: report.summary,
    });
  }

  async getRun(novelId: string, runId: string): Promise<VolumeReadinessRunRecord> {
    await ensureVolumeReadinessRunsHydrated();
    const run = getVolumeReadinessRun(runId);
    if (!run || run.novelId !== novelId) {
      throw new AppError("readiness run 不存在。", 404);
    }
    return run;
  }

  async listRuns(novelId: string, limit = 20): Promise<VolumeReadinessRunRecord[]> {
    await ensureVolumeReadinessRunsHydrated();
    return listVolumeReadinessRuns(novelId, limit);
  }
}

export const volumeReadinessService = new VolumeReadinessService();
