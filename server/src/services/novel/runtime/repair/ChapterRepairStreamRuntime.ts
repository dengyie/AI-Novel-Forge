import { createHash } from "node:crypto";
import type { BaseMessageChunk } from "@langchain/core/messages";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import { isAutoPatchAvoidedByRiskFlags } from "@ai-novel/shared/types/qualityFeedback";
import {
  appendRepairAdoptHistoryLine,
  countTrailingRepairNoImprove,
  decideRepairContentAdoption,
  fingerprintReviewIssuesAsL1BlockingCodes,
  formatRepairAdoptHistoryLine,
} from "@ai-novel/shared/types/repairAdoptDecision";
import { extractSotBannedTermsFromNovel } from "@ai-novel/shared/types/sotBannedTerms";
import type { StreamDoneHelpers } from "../../../../llm/streaming";
import { prisma } from "../../../../db/prisma";
import { streamTextPrompt } from "../../../../prompting/core/promptRunner";
import { withChapterRepairContext } from "../../../../prompting/prompts/novel/chapterLayeredContext";
import { auditService } from "../../../audit/AuditService";
import { contentRevisionBumpData } from "../../chapterContentCas";
import {
  chapterStatePairAfterDraftSave,
  chapterStatePairAfterLiteraryQualityGate,
} from "../../chapterLifecycleState";
import { ChapterPatchRepairFailedError } from "../../chapterPatchRepairService";
import {
  isPass,
  logPipelineError,
  logPipelineInfo,
  ruleScore,
  type RepairOptions,
  type ReviewOptions,
} from "../../novelCoreShared";
import { chapterQualityLoopService } from "../../quality/ChapterQualityLoopService";
import type { ChapterArtifactSyncService } from "../ChapterArtifactSyncService";
import type { GenerationContextAssembler } from "../GenerationContextAssembler";
import {
  detectProseQuality,
  normalizeProseQualityTermList,
} from "../proseQuality/ProseQualityDetector";
import {
  ChapterContextAssemblyError,
  assembleChapterAuditContextPackage,
} from "./chapterAuditContext";
import {
  createHeavyRepairPromptExecution,
  prepareChapterRepairExecution,
} from "./chapterRepairRuntime";

interface RepairReviewResult {
  score: QualityScore;
  issues: ReviewIssue[];
}

export interface ChapterRepairStreamRuntimeDeps {
  assembler?: Pick<GenerationContextAssembler, "assemble">;
  artifactSyncService: Pick<ChapterArtifactSyncService, "syncChapterArtifacts">;
  reviewChapterAfterRepair: (
    novelId: string,
    chapterId: string,
    options: ReviewOptions,
  ) => Promise<RepairReviewResult>;
  resolveAuditIssues?: (novelId: string, issueIds: string[]) => Promise<unknown>;
}

function contentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function blockingProseCodes(
  content: string,
  options: { mustAvoid?: string | null; bannedTerms?: string[] | null } = {},
): string[] {
  const report = detectProseQuality(content, {
    mustAvoidTerms: normalizeProseQualityTermList(options.mustAvoid ?? null),
    bannedTerms: normalizeProseQualityTermList(options.bannedTerms ?? null),
  });
  return report.findings
    .filter((finding) => finding.severity === "high" || finding.severity === "critical")
    .map((finding) => finding.code);
}

function scoreFromChapterColumns(chapter: {
  qualityScore?: number | null;
  continuityScore?: number | null;
  characterScore?: number | null;
  pacingScore?: number | null;
} | null | undefined): QualityScore | null {
  if (
    chapter?.qualityScore == null
    || chapter.continuityScore == null
    || chapter.characterScore == null
    || chapter.pacingScore == null
  ) {
    return null;
  }
  // 列上仅 overall/coherence/voice/pacing；repetition/engagement 用 overall 保守回填。
  const overall = chapter.qualityScore;
  return {
    coherence: chapter.continuityScore,
    repetition: overall,
    pacing: chapter.pacingScore,
    voice: chapter.characterScore,
    engagement: overall,
    overall,
  };
}

export class ChapterRepairStreamRuntime {
  constructor(private readonly deps: ChapterRepairStreamRuntimeDeps) {}

  async createRepairStream(
    novelId: string,
    chapterId: string,
    options: RepairOptions = {},
  ): Promise<{
    stream: AsyncIterable<BaseMessageChunk>;
    onDone: (fullContent: string, helpers: StreamDoneHelpers) => Promise<void>;
  }> {
    const [novel, chapter, bible] = await Promise.all([
      prisma.novel.findUnique({ where: { id: novelId } }),
      prisma.chapter.findFirst({ where: { id: chapterId, novelId } }),
      prisma.novelBible.findUnique({ where: { novelId } }),
    ]);
    if (!novel || !chapter) {
      throw new Error("小说或章节不存在");
    }

    const issues = await this.resolveRepairIssues(novelId, chapterId, options);
    const assembledContextPackage = await assembleChapterAuditContextPackage({
      assembler: this.deps.assembler,
      novelId,
      chapterId,
      options,
      operation: "repair",
    });
    const repairContextPackage = withChapterRepairContext(assembledContextPackage, issues);
    if (!repairContextPackage.chapterRepairContext) {
      const error = new Error("chapterRepairContext missing after successful context assembly");
      logPipelineError("Failed to derive repair context from assembled chapter context package.", {
        novelId,
        chapterId,
        operation: "repair",
        provider: options.provider ?? null,
        model: options.model ?? null,
        error: error.message,
      });
      throw new ChapterContextAssemblyError(novelId, chapterId, "repair", error);
    }

    // A2 QFP：avoidRetry 时强制 heavy rewrite，禁止同路径自动 light patch（从不 skip_quality）。
    const patchAvoid = isAutoPatchAvoidedByRiskFlags(chapter.riskFlags);
    if (patchAvoid.avoided) {
      logPipelineInfo("QFP avoidRetry: forcing full rewrite instead of auto patch.", {
        novelId,
        chapterId,
        operation: "repair",
        provider: options.provider ?? null,
        model: options.model ?? null,
        reason: patchAvoid.reason,
      });
    }

    const prepared = await prepareChapterRepairExecution({
      novelId,
      chapterId,
      novelTitle: novel.title,
      chapterTitle: chapter.title,
      content: chapter.content ?? "",
      issues,
      repairContext: repairContextPackage.chapterRepairContext,
      bibleContent: bible?.rawContent ?? "",
      forceFullRewrite: patchAvoid.avoided,
      options: {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
        // avoidRetry 时即便调用方传 light_repair 也走 heavy 路径（prepare 内再抬级）
        repairMode: patchAvoid.avoided ? "heavy_repair" : options.repairMode,
      },
    });

    if (prepared.kind === "patched") {
      return {
        stream: createSingleChunkStream(prepared.content),
        onDone: async (fullContent: string, helpers: StreamDoneHelpers) => {
          await this.finalizeRepairResult({
            novelId,
            chapterId,
            options,
            content: prepared.content.trim() || fullContent,
            helpers,
          });
        },
      };
    }

    const streamed = await streamTextPrompt(createHeavyRepairPromptExecution(prepared));
    return {
      stream: streamed.stream as AsyncIterable<BaseMessageChunk>,
      onDone: async (fullContent: string, helpers: StreamDoneHelpers) => {
        const completed = await streamed.complete;
        await this.finalizeRepairResult({
          novelId,
          chapterId,
          options,
          content: completed.output.trim() || fullContent,
          helpers,
        });
      },
    };
  }

  private async resolveRepairIssues(
    novelId: string,
    chapterId: string,
    options: RepairOptions,
  ): Promise<ReviewIssue[]> {
    if (Array.isArray(options.reviewIssues)) {
      return options.reviewIssues;
    }

    const auditIssues = options.auditIssueIds?.length
      ? await prisma.auditIssue.findMany({
        where: { id: { in: options.auditIssueIds } },
        orderBy: { createdAt: "asc" },
      })
      : [];
    if (auditIssues.length > 0) {
      return auditIssues.map((item) => ({
        severity: item.severity as ReviewIssue["severity"],
        category: item.auditType === "continuity"
          ? "coherence"
          : item.auditType === "character"
            ? "logic"
            : "pacing",
        evidence: item.evidence,
        fixSuggestion: item.fixSuggestion,
      }));
    }

    const fallbackReview = await this.deps.reviewChapterAfterRepair(novelId, chapterId, options);
    return fallbackReview.issues;
  }

  /**
   * 修文落库：candidate → L0+score 评估 → adopt|discard|plateau_stop。
   * discard / plateau 不覆盖 chapter.content；仅写 repairHistory 决策行。
   */
  private async finalizeRepairResult(input: {
    novelId: string;
    chapterId: string;
    options: RepairOptions;
    content: string;
    helpers: StreamDoneHelpers;
  }): Promise<void> {
    const runId = `chapter-repair:${input.chapterId}`;
    input.helpers.writeFrame({
      type: "run_status",
      runId,
      status: "running",
      phase: "finalizing",
      message: "修复稿已生成，正在评估是否采纳（evaluate → adopt|discard）。",
    });

    const repairedContent = input.content.trim();
    if (!repairedContent) {
      throw new ChapterPatchRepairFailedError("修复结果为空，未保存章节正文。");
    }

    const baselineChapter = await prisma.chapter.findFirst({
      where: { id: input.chapterId, novelId: input.novelId },
      select: {
        id: true,
        order: true,
        content: true,
        repairHistory: true,
        riskFlags: true,
        qualityScore: true,
        continuityScore: true,
        characterScore: true,
        pacingScore: true,
        mustAvoid: true,
        novel: {
          select: {
            storyWorldSliceJson: true,
            storyWorldSliceOverridesJson: true,
          },
        },
      },
    });
    if (!baselineChapter) {
      throw new Error("章节不存在，无法完成修复采纳评估。");
    }

    const baselineContent = baselineChapter.content ?? "";
    const baselineHash = contentFingerprint(baselineContent);
    const candidateHash = contentFingerprint(repairedContent);
    const consecutiveNoImprove = countTrailingRepairNoImprove(baselineChapter.repairHistory);

    const bannedTerms = extractSotBannedTermsFromNovel(baselineChapter.novel);
    const proseDetectOpts = {
      mustAvoid: baselineChapter.mustAvoid ?? null,
      bannedTerms,
    };
    const baselineBlockingCodes = blockingProseCodes(baselineContent, proseDetectOpts);
    const candidateBlockingCodes = blockingProseCodes(repairedContent, proseDetectOpts);

    // baseline 与 candidate 同协议：优先 evaluateOnly 现算，避免陈旧 QualityReport 误导 adopt
    const baselineReview = await this.resolveBaselineReview({
      novelId: input.novelId,
      chapterId: input.chapterId,
      baselineContent,
      chapter: baselineChapter,
      options: input.options,
    });
    const baselineScore = baselineReview.score;
    const baselineBlockingL1Codes = fingerprintReviewIssuesAsL1BlockingCodes(baselineReview.issues);

    const candidateReview = await this.deps.reviewChapterAfterRepair(input.novelId, input.chapterId, {
      provider: input.options.provider,
      model: input.options.model,
      temperature: input.options.temperature,
      content: repairedContent,
      evaluateOnly: true,
    });
    const candidateScore = candidateReview.score;
    const candidateBlockingL1Codes = fingerprintReviewIssuesAsL1BlockingCodes(candidateReview.issues);

    const adoptDecision = decideRepairContentAdoption({
      baselineScore,
      candidateScore,
      baselineBlockingCodes,
      candidateBlockingCodes,
      baselineBlockingL1Codes,
      candidateBlockingL1Codes,
      consecutiveNoImprove,
    });

    const historyLine = formatRepairAdoptHistoryLine({
      decision: adoptDecision.decision,
      reason: adoptDecision.reason,
      baselineOverall: baselineScore.overall,
      candidateOverall: candidateScore.overall,
      baselineHash,
      candidateHash,
    });
    const nextRepairHistory = appendRepairAdoptHistoryLine(
      baselineChapter.repairHistory,
      historyLine,
    );

    if (adoptDecision.decision !== "adopt") {
      await prisma.chapter.update({
        where: { id: input.chapterId },
        data: { repairHistory: nextRepairHistory },
      });

      // A2 QFP：projection-only 写 feedback（不重写 qualityLoop 主体 / chapterStatus / 不 skip_quality）
      await chapterQualityLoopService.recordRepairFeedbackDecision({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: baselineChapter.order,
        score: baselineScore,
        issues: baselineReview.issues,
        repairDecision: adoptDecision.decision === "plateau_stop" ? "plateau_stop" : "discard",
      }).catch((error) => {
        logPipelineError("Failed to record QFP repairDecision after discard/plateau.", {
          novelId: input.novelId,
          chapterId: input.chapterId,
          operation: "repair",
          provider: input.options.provider ?? null,
          model: input.options.model ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      input.helpers.writeFrame({
        type: "run_status",
        runId,
        status: "succeeded",
        phase: "completed",
        message: adoptDecision.decision === "plateau_stop"
          ? `修复候选未采纳（plateau）：${adoptDecision.reason} 正文保持 baseline。`
          : `修复候选未采纳（discard）：${adoptDecision.reason} 正文保持 baseline。`,
      });
      return;
    }

    // adopt：写 content + revision + artifacts + recheck（带副作用）+ 可选 approval
    await prisma.chapter.update({
      where: { id: input.chapterId },
      data: {
        content: repairedContent,
        repairHistory: nextRepairHistory,
        ...chapterStatePairAfterDraftSave("repaired"),
        ...contentRevisionBumpData(),
      },
    });
    try {
      await this.deps.artifactSyncService.syncChapterArtifacts(
        input.novelId,
        input.chapterId,
        repairedContent,
        {
          scheduleBackgroundSync: true,
          awaitArtifactDelta: true,
          skipLegacySummaryAndFacts: true,
          provider: input.options.provider,
          model: input.options.model,
        },
      );
    } catch (error) {
      await this.markPostAdoptNeedsRepair({
        novelId: input.novelId,
        chapterId: input.chapterId,
        runId,
        helpers: input.helpers,
        logMessage: "Artifact sync failed after repair adopt; content kept, marking needs_repair.",
        userMessage: "修复候选已采纳，但 artifacts 同步失败，已标 needs_repair。",
        error,
      });
      return;
    }

    // 采纳后正式 recheck（写 QualityReport / qualityLoop / 状态）
    let review: RepairReviewResult;
    try {
      review = await this.deps.reviewChapterAfterRepair(input.novelId, input.chapterId, {
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature,
        content: repairedContent,
      });
    } catch (error) {
      await this.markPostAdoptNeedsRepair({
        novelId: input.novelId,
        chapterId: input.chapterId,
        runId,
        helpers: input.helpers,
        logMessage: "Post-adopt recheck failed; content kept, marking needs_repair.",
        userMessage: "修复候选已采纳，但正式 recheck 失败，已标 needs_repair。",
        error,
      });
      return;
    }

    // A6：仅文学 isPass 可质量过审/completed；!pass 写成 needs_repair，不得假 completed
    const literaryPass = isPass(review.score);
    await prisma.chapter.update({
      where: { id: input.chapterId },
      data: chapterStatePairAfterLiteraryQualityGate(literaryPass),
    });
    if (literaryPass && input.options.auditIssueIds?.length) {
      const resolveAuditIssues = this.deps.resolveAuditIssues
        ?? ((novelId: string, issueIds: string[]) => auditService.resolveIssues(novelId, issueIds));
      await resolveAuditIssues(input.novelId, input.options.auditIssueIds).catch(() => null);
    }

    input.helpers.writeFrame({
      type: "run_status",
      runId,
      status: "succeeded",
      phase: "completed",
      message: literaryPass
        ? "修复候选已采纳，本章已达到可继续推进状态。"
        : "修复候选已采纳并保存，但仍有问题待继续处理。",
    });
  }

  /** adopt 后副作用失败：正文已写，强制 needs_repair，禁止假 completed。 */
  private async markPostAdoptNeedsRepair(input: {
    novelId: string;
    chapterId: string;
    runId: string;
    helpers: StreamDoneHelpers;
    logMessage: string;
    userMessage: string;
    error: unknown;
  }): Promise<void> {
    logPipelineError(input.logMessage, {
      novelId: input.novelId,
      chapterId: input.chapterId,
      error: input.error instanceof Error ? input.error.message : String(input.error),
    });
    await prisma.chapter.update({
      where: { id: input.chapterId },
      data: chapterStatePairAfterLiteraryQualityGate(false),
    });
    input.helpers.writeFrame({
      type: "run_status",
      runId: input.runId,
      status: "succeeded",
      phase: "completed",
      message: input.userMessage,
    });
  }

  /**
   * baseline 评估与 candidate 同协议（evaluateOnly）。
   * 仅在 evaluateOnly 失败时回退列代理 / ruleScore，**不再优先信旧 QualityReport**。
   */
  private async resolveBaselineReview(input: {
    novelId: string;
    chapterId: string;
    baselineContent: string;
    chapter: {
      qualityScore?: number | null;
      continuityScore?: number | null;
      characterScore?: number | null;
      pacingScore?: number | null;
    };
    options: RepairOptions;
  }): Promise<RepairReviewResult> {
    if (!input.baselineContent.trim()) {
      return { score: ruleScore(""), issues: [] };
    }

    try {
      return await this.deps.reviewChapterAfterRepair(
        input.novelId,
        input.chapterId,
        {
          provider: input.options.provider,
          model: input.options.model,
          temperature: input.options.temperature,
          content: input.baselineContent,
          evaluateOnly: true,
        },
      );
    } catch (error) {
      logPipelineError("Baseline evaluateOnly failed; falling back to columns/ruleScore.", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const fromColumns = scoreFromChapterColumns(input.chapter);
    if (fromColumns) {
      return { score: fromColumns, issues: [] };
    }
    return { score: ruleScore(input.baselineContent), issues: [] };
  }
}

async function* createSingleChunkStream(content: string): AsyncIterable<BaseMessageChunk> {
  yield { content } as BaseMessageChunk;
}
