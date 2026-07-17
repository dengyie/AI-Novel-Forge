import type { AuditReport, QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import { prisma } from "../../db/prisma";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import {
  chapterReviewPrompt,
} from "../../prompting/prompts/novel/review.prompts";
import { ragServices } from "../rag";
import { auditService } from "../audit/AuditService";
import { payoffLedgerSyncService } from "../payoff/PayoffLedgerSyncService";
import { plannerService } from "../planner/PlannerService";
import { stateService } from "../state/StateService";
import {
  isPass,
  LLMGenerateOptions,
  logPipelineError,
  normalizeScore,
  RepairOptions,
  ReviewOptions,
  ruleScore,
} from "./novelCoreShared";
import { GenerationContextAssembler } from "./runtime/GenerationContextAssembler";
import {
  hasBlockingPronounProseFromIssueCodes,
  projectStyleClear,
} from "@ai-novel/shared/types/styleClearGate";
import { chapterQualityLoopService } from "./quality/ChapterQualityLoopService";
import { chapterStatePairAfterManualQualityReview } from "./chapterLifecycleState";
import { directorAutomationLedgerEventService } from "./director/runtime/DirectorAutomationLedgerEventService";
import { ChapterRuntimeCoordinator } from "./runtime/ChapterRuntimeCoordinator";
import {
  ChapterContextAssemblyError,
  type AuditContextOperation,
  assembleChapterAuditContextPackage,
} from "./runtime/repair/chapterAuditContext";
import { persistChapterQualityScores } from "./quality/chapterQualityScorePersist";
import {
  computeDeterministicResidualRiskScore,
} from "../styleEngine/StyleDetectionService";
import { detectProseQuality } from "./runtime/proseQuality/ProseQualityDetector";

/**
 * 审校/流水线写 QualityReport，并拍平到 Chapter 可运营分数字段。
 * 实现集中在 quality/chapterQualityScorePersist，避免 finalize 与 review 循环依赖。
 */
export async function createQualityReport(
  novelId: string,
  chapterId: string,
  score: QualityScore,
  issues: ReviewIssue[],
) {
  await persistChapterQualityScores({
    novelId,
    chapterId,
    score,
    issues,
    writeReport: true,
  });
}

export class NovelCoreReviewService {
  private readonly generationContextAssembler = new GenerationContextAssembler();
  private readonly chapterRuntimeCoordinator = new ChapterRuntimeCoordinator({
    reviewChapterAfterRepair: (novelId, chapterId, options) => this.reviewChapter(novelId, chapterId, options),
    resolveAuditIssues: (novelId, issueIds) => this.resolveAuditIssues(novelId, issueIds),
  });

  async reviewChapter(novelId: string, chapterId: string, options: ReviewOptions = {}) {
    const chapter = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      include: { novel: true },
    });
    if (!chapter) {
      throw new Error("章节不存在");
    }

    const review = await this.reviewChapterWithAudit(
      chapter.novel.title,
      chapter.title,
      options.content ?? chapter.content ?? "",
      options,
      novelId,
      chapterId,
    );

    // evaluateOnly：修文候选可用性评估，禁止副作用写库（避免 discard 污染 baseline）。
    if (options.evaluateOnly) {
      return review;
    }

    // 双门：文学 isPass ∧ styleClear；styleClear 由 L0 pronoun + 确定性 residual 投影（fail-closed）。
    const contentForStyle = options.content ?? chapter.content ?? "";
    const literaryPass = isPass(review.score);
    const styleClear = projectStyleClearFromManualReview({
      content: contentForStyle,
      issues: review.issues,
      chapterOrder: chapter.order,
    });
    const chapterStatePatch = chapterStatePairAfterManualQualityReview({
      literaryPass,
      styleClear,
    });
    await prisma.chapter.update({
      where: { id: chapterId },
      data: chapterStatePatch,
    });
    await createQualityReport(novelId, chapterId, review.score, review.issues);
    await chapterQualityLoopService.recordAssessment({
      novelId,
      chapterId,
      chapterOrder: chapter.order,
      score: review.score,
      issues: review.issues,
      source: options.content ? "repair_recheck" : "manual_review",
    }).catch((error) => {
      logPipelineError("Failed to record chapter quality loop assessment.", {
        novelId,
        chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const replanRecommendation = plannerService.buildReplanRecommendation({
      auditReports: review.auditReports ?? [],
      ledgerSummary: review.contextPackage?.ledgerSummary ?? null,
      contextPackage: review.contextPackage ?? null,
    });
    if ((review.auditReports?.length ?? 0) > 0 && replanRecommendation.recommended) {
      await plannerService.replan(novelId, {
        chapterId,
        triggerType: "audit_failure",
        reason: replanRecommendation.triggerReason || replanRecommendation.reason,
        sourceIssueIds: replanRecommendation.blockingIssueIds,
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
      }).catch(() => null);
    }

    return review;
  }

  async createRepairStream(novelId: string, chapterId: string, options: RepairOptions = {}) {
    return this.chapterRuntimeCoordinator.createRepairStream(novelId, chapterId, options);
  }

  async getNovelState(novelId: string) {
    return stateService.getNovelState(novelId);
  }

  async getLatestStateSnapshot(novelId: string) {
    return stateService.getLatestSnapshot(novelId);
  }

  async getChapterStateSnapshot(novelId: string, chapterId: string) {
    return stateService.getChapterSnapshot(novelId, chapterId);
  }

  async rebuildNovelState(novelId: string, options: LLMGenerateOptions = {}) {
    return stateService.rebuildState(novelId, options);
  }

  async generateBookPlan(novelId: string, options: LLMGenerateOptions = {}) {
    return plannerService.generateBookPlan(novelId, options);
  }

  async generateArcPlan(novelId: string, arcId: string, options: LLMGenerateOptions = {}) {
    return plannerService.generateArcPlan(novelId, arcId, options);
  }

  async generateChapterPlan(novelId: string, chapterId: string, options: LLMGenerateOptions = {}) {
    return plannerService.generateChapterPlan(novelId, chapterId, options);
  }

  async getChapterPlan(novelId: string, chapterId: string) {
    return plannerService.getChapterPlan(novelId, chapterId);
  }

  async replanNovel(
    novelId: string,
    input: {
      chapterId?: string;
      triggerType?: string;
      sourceIssueIds?: string[];
      windowSize?: number;
      reason: string;
    } & LLMGenerateOptions,
  ) {
    const result = await plannerService.replan(novelId, input);
    if (result.run) {
      await directorAutomationLedgerEventService.recordReplanRunCreated({
        novelId,
        replanRunId: result.run.id,
        affectedChapterIds: result.affectedChapterIds,
        affectedChapterOrders: result.affectedChapterOrders,
        generatedPlanIds: result.generatedPlans.map((plan) => plan.id),
        blockingLedgerKeys: result.blockingLedgerKeys ?? [],
        triggerReason: result.triggerReason || result.reason,
      }).catch(() => null);
    }
    return result;
  }

  async auditChapter(
    novelId: string,
    chapterId: string,
    scope: "full" | "continuity" | "character" | "plot" | "mode_fit",
    options: ReviewOptions = {},
  ) {
    const contextPackage = await this.assembleAuditContextPackage(novelId, chapterId, options, "audit");
    return auditService.auditChapter(novelId, chapterId, scope, {
      ...options,
      contextPackage,
    });
  }

  async listChapterAuditReports(novelId: string, chapterId: string) {
    return auditService.listChapterAuditReports(novelId, chapterId);
  }

  async resolveAuditIssues(novelId: string, issueIds: string[]) {
    return auditService.resolveIssues(novelId, issueIds);
  }

  async getQualityReport(novelId: string) {
    const reports = await prisma.qualityReport.findMany({
      where: { novelId },
      orderBy: { createdAt: "desc" },
    });
    if (reports.length === 0) {
      return { novelId, summary: normalizeScore({}), chapterReports: [] };
    }

    const latestByChapter = new Map<string, (typeof reports)[number]>();
    for (const report of reports) {
      if (report.chapterId && !latestByChapter.has(report.chapterId)) {
        latestByChapter.set(report.chapterId, report);
      }
    }
    const chapterReports = Array.from(latestByChapter.values());
    const source = chapterReports.length > 0 ? chapterReports : reports;
    const total = source.length;

    const summary = normalizeScore({
      coherence: source.reduce((sum, item) => sum + item.coherence, 0) / total,
      repetition: source.reduce((sum, item) => sum + item.repetition, 0) / total,
      pacing: source.reduce((sum, item) => sum + item.pacing, 0) / total,
      voice: source.reduce((sum, item) => sum + item.voice, 0) / total,
      engagement: source.reduce((sum, item) => sum + item.engagement, 0) / total,
      overall: source.reduce((sum, item) => sum + item.overall, 0) / total,
    });

    return { novelId, summary, chapterReports: source, totalReports: reports.length };
  }

  async getPayoffLedger(novelId: string, chapterOrder?: number) {
    return payoffLedgerSyncService.getPayoffLedger(novelId, { chapterOrder });
  }

  private async reviewChapterContent(
    novelTitle: string,
    chapterTitle: string,
    content: string,
    options: ReviewOptions = {},
    novelId?: string,
  ): Promise<{ score: QualityScore; issues: ReviewIssue[] }> {
    if (!content.trim()) {
      return {
        score: normalizeScore({}),
        issues: [{
          severity: "critical",
          category: "coherence",
          evidence: "章节内容为空",
          fixSuggestion: "先生成或补充正文，再进行审校",
        }],
      };
    }

    try {
      let ragContext = "";
      if (novelId) {
        try {
          ragContext = await ragServices.hybridRetrievalService.buildContextBlock(
            `章节审校 ${novelTitle}\n${chapterTitle}\n${content.slice(0, 1500)}`,
            {
              novelId,
              ownerTypes: ["novel", "chapter", "chapter_summary", "consistency_fact", "character", "bible"],
              finalTopK: 6,
            },
          );
        } catch {
          ragContext = "";
        }
      }

      const result = await runStructuredPrompt({
        asset: chapterReviewPrompt,
        promptInput: {
          novelTitle,
          chapterTitle,
          content,
          ragContext: ragContext || "",
        },
        options: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature ?? 0.1,
        },
      });
      const parsed = result.output;

      return {
        score: normalizeScore(parsed.score ?? {}),
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      };
    } catch {
      return { score: ruleScore(content), issues: [] };
    }
  }

  private async reviewChapterWithAudit(
    novelTitle: string,
    chapterTitle: string,
    content: string,
    options: ReviewOptions = {},
    novelId?: string,
    chapterId?: string,
  ): Promise<{
    score: QualityScore;
    issues: ReviewIssue[];
    auditReports?: AuditReport[];
    contextPackage?: GenerationContextPackage;
  }> {
    if (!content.trim()) {
      return {
        score: normalizeScore({}),
        issues: [{
          severity: "critical",
          category: "coherence",
          evidence: "章节内容为空",
          fixSuggestion: "先生成或补全正文，再进行审校",
        }],
        auditReports: [],
      };
    }

    if (novelId && chapterId) {
      const contextPackage = await this.assembleAuditContextPackage(novelId, chapterId, options, "review");
      const auditResult = await auditService.auditChapter(novelId, chapterId, "full", {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
        content,
        contextPackage,
      });
      return {
        ...auditResult,
        contextPackage,
      };
    }

    return this.reviewChapterContent(novelTitle, chapterTitle, content, options, novelId);
  }

  private async assembleAuditContextPackage(
    novelId: string,
    chapterId: string,
    options: ReviewOptions,
    operation: AuditContextOperation,
  ): Promise<GenerationContextPackage> {
    return assembleChapterAuditContextPackage({
      assembler: this.generationContextAssembler,
      novelId,
      chapterId,
      options,
      operation,
    });
  }
}

/**
 * 人工/API 审校路径的 styleClear 投影（同步、确定性，不调 LLM）。
 * - L0 hard pronoun（stack/density）→ false
 * - residual = max(pronoun floor, non-pronoun high/critical prose floor)
 * - 中盘仅 residual 高仍可 true（债不挡 completed；blocking pronoun 仍 false）
 */
export function projectStyleClearFromManualReview(input: {
  content: string;
  issues: Array<{ code?: string | null } | ReviewIssue>;
  chapterOrder: number;
}): boolean {
  const issueCodes = input.issues
    .map((issue) => {
      const anyIssue = issue as { code?: string | null };
      return typeof anyIssue.code === "string" && anyIssue.code.length > 0 ? anyIssue.code : null;
    })
    .filter((code): code is string => code != null);
  const proseCodes = detectProseQuality(input.content).findings.map((f) => f.code);
  const hasBlockingPronounProse = hasBlockingPronounProseFromIssueCodes([
    ...issueCodes,
    ...proseCodes,
  ]);
  // 确定性 residual：pronoun + 其它高危 prose 痕迹；对齐 repair 路径，禁止开篇 AI 自指假 true。
  const residualRiskScore = computeDeterministicResidualRiskScore(input.content);
  return projectStyleClear({
    residualRiskScore,
    hasBlockingPronounProse,
    chapterOrder: input.chapterOrder,
  });
}
