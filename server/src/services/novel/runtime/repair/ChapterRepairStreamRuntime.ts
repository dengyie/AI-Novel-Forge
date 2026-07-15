import { createHash } from "node:crypto";
import type { BaseMessageChunk } from "@langchain/core/messages";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import {
  appendRepairAdoptHistoryLine,
  countTrailingRepairNoImprove,
  decideRepairContentAdoption,
  formatRepairAdoptHistoryLine,
} from "@ai-novel/shared/types/repairAdoptDecision";
import type { StreamDoneHelpers } from "../../../../llm/streaming";
import { prisma } from "../../../../db/prisma";
import { streamTextPrompt } from "../../../../prompting/core/promptRunner";
import { withChapterRepairContext } from "../../../../prompting/prompts/novel/chapterLayeredContext";
import { auditService } from "../../../audit/AuditService";
import { contentRevisionBumpData } from "../../chapterContentCas";
import {
  chapterStatePairAfterDraftSave,
  chapterStatePairAfterPipelineApproval,
} from "../../chapterLifecycleState";
import { ChapterPatchRepairFailedError } from "../../chapterPatchRepairService";
import {
  isPass,
  logPipelineError,
  ruleScore,
  type RepairOptions,
  type ReviewOptions,
} from "../../novelCoreShared";
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

    const prepared = await prepareChapterRepairExecution({
      novelId,
      chapterId,
      novelTitle: novel.title,
      chapterTitle: chapter.title,
      content: chapter.content ?? "",
      issues,
      repairContext: repairContextPackage.chapterRepairContext,
      bibleContent: bible?.rawContent ?? "",
      options: {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
        repairMode: options.repairMode,
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
        content: true,
        repairHistory: true,
        qualityScore: true,
        continuityScore: true,
        characterScore: true,
        pacingScore: true,
        mustAvoid: true,
      },
    });
    if (!baselineChapter) {
      throw new Error("章节不存在，无法完成修复采纳评估。");
    }

    const baselineContent = baselineChapter.content ?? "";
    const baselineHash = contentFingerprint(baselineContent);
    const candidateHash = contentFingerprint(repairedContent);
    const consecutiveNoImprove = countTrailingRepairNoImprove(baselineChapter.repairHistory);

    const proseDetectOpts = { mustAvoid: baselineChapter.mustAvoid ?? null };
    const baselineBlockingCodes = blockingProseCodes(baselineContent, proseDetectOpts);
    const candidateBlockingCodes = blockingProseCodes(repairedContent, proseDetectOpts);

    const baselineScore = await this.resolveBaselineScore({
      novelId: input.novelId,
      chapterId: input.chapterId,
      baselineContent,
      chapter: baselineChapter,
      options: input.options,
    });
    const candidateReview = await this.deps.reviewChapterAfterRepair(input.novelId, input.chapterId, {
      provider: input.options.provider,
      model: input.options.model,
      temperature: input.options.temperature,
      content: repairedContent,
      evaluateOnly: true,
    });
    const candidateScore = candidateReview.score;

    const adoptDecision = decideRepairContentAdoption({
      baselineScore,
      candidateScore,
      baselineBlockingCodes,
      candidateBlockingCodes,
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

    // 采纳后正式 recheck（写 QualityReport / qualityLoop / 状态）
    const review = await this.deps.reviewChapterAfterRepair(input.novelId, input.chapterId, {
      provider: input.options.provider,
      model: input.options.model,
      temperature: input.options.temperature,
      content: repairedContent,
    });

    if (isPass(review.score)) {
      await prisma.chapter.update({
        where: { id: input.chapterId },
        data: chapterStatePairAfterPipelineApproval(),
      });
      if (input.options.auditIssueIds?.length) {
        const resolveAuditIssues = this.deps.resolveAuditIssues
          ?? ((novelId: string, issueIds: string[]) => auditService.resolveIssues(novelId, issueIds));
        await resolveAuditIssues(input.novelId, input.options.auditIssueIds).catch(() => null);
      }
    }

    input.helpers.writeFrame({
      type: "run_status",
      runId,
      status: "succeeded",
      phase: "completed",
      message: isPass(review.score)
        ? "修复候选已采纳，本章已达到可继续推进状态。"
        : "修复候选已采纳并保存，但仍有问题待继续处理。",
    });
  }

  private async resolveBaselineScore(input: {
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
  }): Promise<QualityScore> {
    try {
      const latestReport = await prisma.qualityReport.findFirst({
        where: { chapterId: input.chapterId, novelId: input.novelId },
        orderBy: { createdAt: "desc" },
        select: {
          coherence: true,
          repetition: true,
          pacing: true,
          voice: true,
          engagement: true,
          overall: true,
        },
      });
      if (latestReport) {
        return {
          coherence: latestReport.coherence,
          repetition: latestReport.repetition,
          pacing: latestReport.pacing,
          voice: latestReport.voice,
          engagement: latestReport.engagement,
          overall: latestReport.overall,
        };
      }
    } catch (error) {
      logPipelineError("Failed to load latest QualityReport for repair baseline score.", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const fromColumns = scoreFromChapterColumns(input.chapter);
    if (fromColumns) {
      return fromColumns;
    }

    if (!input.baselineContent.trim()) {
      return ruleScore("");
    }

    try {
      const baselineReview = await this.deps.reviewChapterAfterRepair(
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
      return baselineReview.score;
    } catch (error) {
      logPipelineError("Baseline evaluateOnly failed; falling back to ruleScore.", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
      return ruleScore(input.baselineContent);
    }
  }
}

async function* createSingleChunkStream(content: string): AsyncIterable<BaseMessageChunk> {
  yield { content } as BaseMessageChunk;
}
