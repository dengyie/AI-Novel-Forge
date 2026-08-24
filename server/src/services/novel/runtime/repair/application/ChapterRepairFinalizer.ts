import { createHash } from "node:crypto";
import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import {
  appendRepairAdoptHistoryLine,
  countTrailingRepairNoImprove,
  decideRepairContentAdoption,
  fingerprintReviewIssuesAsL1BlockingCodes,
  formatRepairAdoptHistoryLine,
} from "@ai-novel/shared/types/repairAdoptDecision";
import { extractSotBannedTermsFromNovel } from "@ai-novel/shared/types/sotBannedTerms";
import {
  evaluateLengthBudget,
  type LengthBudgetEvaluation,
} from "@ai-novel/shared/types/chapterLengthControl";
import {
  hasBlockingPronounProseFromIssueCodes,
  projectStyleClear,
} from "@ai-novel/shared/types/styleClearGate";
import type { StreamDoneHelpers } from "../../../../../llm/streaming";
import { prisma } from "../../../../../db/prisma";
import { auditService } from "../../../../audit/AuditService";
import { computeDeterministicResidualRiskScore } from "../../../../styleEngine/StyleDetectionService";
import {
  CHAPTER_CONTENT_CONFLICT_CODE,
  isChapterContentConflictError,
} from "../../../chapterContentCas";
import {
  chapterStatePairAfterDraftSave,
  chapterStatePairAfterQualityGates,
} from "../../../chapterLifecycleState";
import { ChapterPatchRepairFailedError } from "../../../chapterPatchRepairService";
import { isPass, logPipelineError, type RepairOptions } from "../../../novelCoreShared";
import { chapterQualityLoopService } from "../../../quality/ChapterQualityLoopService";
import { persistChapterQualityScores } from "../../../quality/chapterQualityScorePersist";
import type { ChapterArtifactSyncService } from "../../ChapterArtifactSyncService";
import type { ChapterContentCommitService } from "../../content/ChapterContentCommitService";
import {
  detectProseQuality,
  normalizeProseQualityTermList,
} from "../../proseQuality/ProseQualityDetector";
import { assertRepairAbortSignal } from "../concurrency/ChapterRepairCancellation";
import {
  ChapterRepairBaselineEvaluator,
  type RepairReviewResult,
  type ReviewChapterAfterRepair,
} from "../evaluation/ChapterRepairBaselineEvaluator";

export interface ChapterRepairFinalizerDeps {
  contentCommitService: Pick<ChapterContentCommitService, "commit">;
  artifactSyncService: Pick<ChapterArtifactSyncService, "syncChapterArtifacts">;
  reviewChapterAfterRepair: ReviewChapterAfterRepair;
  resolveAuditIssues?: (novelId: string, issueIds: string[]) => Promise<unknown>;
}

export interface FinalizeChapterRepairInput {
  novelId: string;
  chapterId: string;
  baselineContentRevision: number;
  options: RepairOptions;
  content: string;
  helpers: StreamDoneHelpers;
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

export function buildRepairRunStatusFrame(input: {
  chapterId: string;
  status: "succeeded" | "failed" | "running";
  phase: "streaming" | "finalizing" | "completed";
  message: string;
}) {
  return {
    type: "run_status" as const,
    runId: `chapter-repair:${input.chapterId}`,
    status: input.status,
    phase: input.phase,
    message: input.message,
  };
}

/**
 * 组装 discard/plateau 终帧文案。字数硬门触发时给出含字数事实的明确提示
 * （候选字数/目标/硬下限），便于运维与测试断言识别「未采纳是因为篇幅不足」。
 */
function formatRepairDiscardMessage(
  adoptDecision: { decision: string; reason: string },
  lengthGate: LengthBudgetEvaluation | null,
): string {
  if (lengthGate && lengthGate.band === "under_hard") {
    const target = lengthGate.budget.targetWordCount;
    return `修复候选未采纳：候选正文字数 ${lengthGate.actualWordCount} 远低于目标 ${target}（硬下限 ${lengthGate.hardMinWordCount}），未采纳，正文保持 baseline。`;
  }
  return adoptDecision.decision === "plateau_stop"
    ? `修复候选未采纳（plateau）：${adoptDecision.reason} 正文保持 baseline。`
    : `修复候选未采纳（discard）：${adoptDecision.reason} 正文保持 baseline。`;
}

function isContentRevisionConflict(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "details" in error
    && (error as { details?: { code?: unknown } }).details?.code === CHAPTER_CONTENT_CONFLICT_CODE,
  );
}

function projectStyleClearFromRepairReview(input: {
  content: string;
  issues: ReviewIssue[];
  chapterOrder: number;
}): boolean {
  const issueCodes = input.issues
    .map((issue) => (issue as ReviewIssue & { code?: string | null }).code ?? null)
    .filter((code): code is string => typeof code === "string" && code.length > 0);
  const proseCodes = blockingProseCodes(input.content);
  const hasBlockingPronounProse = hasBlockingPronounProseFromIssueCodes([
    ...issueCodes,
    ...proseCodes,
  ]);
  return projectStyleClear({
    residualRiskScore: computeDeterministicResidualRiskScore(input.content),
    hasBlockingPronounProse,
    chapterOrder: input.chapterOrder,
  });
}

export class ChapterRepairFinalizer {
  private readonly baselineEvaluator: ChapterRepairBaselineEvaluator;

  constructor(private readonly deps: ChapterRepairFinalizerDeps) {
    this.baselineEvaluator = new ChapterRepairBaselineEvaluator(deps.reviewChapterAfterRepair);
  }

  async finalize(input: FinalizeChapterRepairInput): Promise<void> {
    input.helpers.writeFrame(buildRepairRunStatusFrame({
      chapterId: input.chapterId,
      status: "running",
      phase: "finalizing",
      message: "修复稿已生成，正在评估是否采纳（evaluate → adopt|discard）。",
    }));

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
        contentRevision: true,
        repairHistory: true,
        riskFlags: true,
        qualityScore: true,
        continuityScore: true,
        characterScore: true,
        pacingScore: true,
        mustAvoid: true,
        targetWordCount: true,
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
    const proseDetectOpts = {
      mustAvoid: baselineChapter.mustAvoid ?? null,
      bannedTerms: extractSotBannedTermsFromNovel(baselineChapter.novel),
    };
    const baselineBlockingCodes = blockingProseCodes(baselineContent, proseDetectOpts);
    const candidateBlockingCodes = blockingProseCodes(repairedContent, proseDetectOpts);

    const baselineReview = await this.baselineEvaluator.evaluate({
      novelId: input.novelId,
      chapterId: input.chapterId,
      baselineContent,
      chapter: baselineChapter,
      options: input.options,
    });
    assertRepairAbortSignal("finalize-baseline-review", input.options.signal);
    const baselineL1Degraded = baselineReview.degraded === true;
    const baselineBlockingL1Codes = baselineL1Degraded
      ? []
      : fingerprintReviewIssuesAsL1BlockingCodes(baselineReview.issues);
    const candidateReview = await this.deps.reviewChapterAfterRepair(input.novelId, input.chapterId, {
      provider: input.options.provider,
      model: input.options.model,
      temperature: input.options.temperature,
      content: repairedContent,
      evaluateOnly: true,
      signal: input.options.signal,
    });
    assertRepairAbortSignal("finalize-candidate-review", input.options.signal);
    const candidateScoreDegraded = candidateReview.degraded === true;
    const candidateBlockingL1Codes = candidateScoreDegraded
      ? []
      : fingerprintReviewIssuesAsL1BlockingCodes(candidateReview.issues);

    // 字数硬门（纯计算，无 LLM）：与 generate 路径 reconcileLengthAssessment 同语义。
    // 候选字数 < target×0.6（under_hard）是不可由 LLM 分数推翻的客观事实，
    // 必须在 adopt 决策之前强制 discard——短候选不落库，正文保持 baseline。
    // 无 targetWordCount（旧数据/无合同）时 evaluateLengthBudget 返回 null，不设门。
    const lengthGate = evaluateLengthBudget({
      content: repairedContent,
      targetWordCount: baselineChapter.targetWordCount ?? null,
    });
    // lengthPass：自动修复出口的软下限长度硬门。修复有补长度能力，短于 softMin
    // （band === under_soft / under_hard）一律不算过审，落 needs_repair 继续补写，
    // 避免「内容对但短 15%」的章长期挂 pending_review 不收口。
    // 无长度合同（lengthGate === null，旧数据无 targetWordCount）时不设长度门。
    const lengthPass = lengthGate == null
      || (lengthGate.band !== "under_soft" && lengthGate.band !== "under_hard");

    let adoptDecision = decideRepairContentAdoption({
      baselineScore: baselineReview.score,
      candidateScore: candidateReview.score,
      baselineBlockingCodes,
      candidateBlockingCodes,
      baselineBlockingL1Codes,
      candidateBlockingL1Codes,
      consecutiveNoImprove,
      skipL1Check: baselineL1Degraded || candidateScoreDegraded,
      skipScoreCheck: candidateScoreDegraded,
    });
    if (lengthGate && lengthGate.band === "under_hard") {
      // 覆盖为 discard：字数硬门优先于分数决策。下一轮 repair 会因 QFP avoidRetry
      // 被 isAutoPatchAvoidedByRiskFlags 强制升级为 heavy_repair，避免 light_repair
      // 局部补丁反复产出短候选。
      adoptDecision = {
        decision: "discard",
        reason: `length_under_hard:${lengthGate.actualWordCount}/${lengthGate.budget.targetWordCount}/hardMin=${lengthGate.hardMinWordCount}`,
        scoreDelta: {
          overall: 0,
          coherence: 0,
          repetition: 0,
          engagement: 0,
        },
        introducedBlockingCodes: [],
        introducedBlockingL1Codes: [],
        baselineLiteraryPass: false,
        candidateLiteraryPass: false,
      };
    }
    const historyLine = formatRepairAdoptHistoryLine({
      decision: adoptDecision.decision,
      reason: adoptDecision.reason,
      baselineOverall: baselineReview.score.overall,
      candidateOverall: candidateReview.score.overall,
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
      await chapterQualityLoopService.recordRepairFeedbackDecision({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: baselineChapter.order,
        score: baselineReview.score,
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
      input.helpers.writeFrame(buildRepairRunStatusFrame({
        chapterId: input.chapterId,
        status: "succeeded",
        phase: "completed",
        message: formatRepairDiscardMessage(adoptDecision, lengthGate),
      }));
      return;
    }

    let committed;
    try {
      assertRepairAbortSignal("finalize-adopt-write", input.options.signal);
      committed = await this.deps.contentCommitService.commit({
        novelId: input.novelId,
        chapterId: input.chapterId,
        content: repairedContent,
        expectedContentRevision: input.baselineContentRevision,
        statePatch: {
          repairHistory: nextRepairHistory,
          ...chapterStatePairAfterDraftSave("repaired"),
        },
        source: "repair_adopt",
      });
    } catch (error) {
      if (!isContentRevisionConflict(error)) {
        throw error;
      }
      input.helpers.writeFrame(buildRepairRunStatusFrame({
        chapterId: input.chapterId,
        status: "failed",
        phase: "completed",
        message: "修复期间章节正文已发生变更（可能来自人工编辑），本次候选未覆盖最新正文。",
      }));
      return;
    }

    try {
      await this.deps.artifactSyncService.syncChapterArtifacts(
        input.novelId,
        input.chapterId,
        committed.content,
        {
          scheduleBackgroundSync: true,
          awaitArtifactDelta: false,
          skipLegacySummaryAndFacts: true,
          provider: input.options.provider,
          model: input.options.model,
        },
      );
    } catch (error) {
      logPipelineError("Artifact sync schedule failed after repair adopt; content kept, continuing recheck.", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let review: RepairReviewResult;
    try {
      review = await this.deps.reviewChapterAfterRepair(input.novelId, input.chapterId, {
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature,
        content: committed.content,
        evaluateOnly: true,
        signal: input.options.signal,
      });
    } catch (error) {
      await this.markPostAdoptNeedsRepair({
        novelId: input.novelId,
        chapterId: input.chapterId,
        helpers: input.helpers,
        expectedContentRevision: committed.contentRevision,
        userMessage: "修复候选已采纳，但正式 recheck 失败，已标 needs_repair。",
        error,
      });
      return;
    }

    const literaryPass = isPass(review.score);
    const styleClear = projectStyleClearFromRepairReview({
      content: committed.content,
      issues: review.issues,
      chapterOrder: baselineChapter.order,
    });
    try {
      await persistChapterQualityScores({
        novelId: input.novelId,
        chapterId: input.chapterId,
        expectedContentRevision: committed.contentRevision,
        score: review.score,
        issues: review.issues,
        chapterPatch: chapterStatePairAfterQualityGates({ literaryPass, styleClear, lengthPass }),
        writeReport: true,
      });
      await chapterQualityLoopService.recordAssessment({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: baselineChapter.order,
        expectedContentRevision: committed.contentRevision,
        score: review.score,
        issues: review.issues,
        source: "repair_recheck",
      });
    } catch (error) {
      const casMiss = isChapterContentConflictError(error)
        || (error instanceof Error && error.message === CHAPTER_CONTENT_CONFLICT_CODE);
      if (!casMiss) throw error;
      input.helpers.writeFrame(buildRepairRunStatusFrame({
        chapterId: input.chapterId,
        status: "failed",
        phase: "completed",
        message: "修复复检期间章节正文已再次变更，本次旧 revision 的状态与评分未覆盖最新正文。",
      }));
      return;
    }
    if (literaryPass && styleClear && input.options.auditIssueIds?.length) {
      const resolveAuditIssues = this.deps.resolveAuditIssues
        ?? ((novelId: string, issueIds: string[]) => auditService.resolveIssues(novelId, issueIds));
      await resolveAuditIssues(input.novelId, input.options.auditIssueIds).catch(() => null);
    }
    input.helpers.writeFrame(buildRepairRunStatusFrame({
      chapterId: input.chapterId,
      status: literaryPass && styleClear ? "succeeded" : "failed",
      phase: "completed",
      message: literaryPass && styleClear
        ? "修复候选已采纳，本章已达到可继续推进状态。"
        : "修复候选已采纳并保存，但仍有问题待继续处理。",
    }));
  }

  private async markPostAdoptNeedsRepair(input: {
    novelId: string;
    chapterId: string;
    helpers: StreamDoneHelpers;
    expectedContentRevision: number;
    userMessage: string;
    error: unknown;
  }): Promise<void> {
    logPipelineError("Post-adopt recheck failed; content kept, marking needs_repair.", {
      novelId: input.novelId,
      chapterId: input.chapterId,
      error: input.error instanceof Error ? input.error.message : String(input.error),
    });
    const projected = await prisma.chapter.updateMany({
      where: {
        id: input.chapterId,
        novelId: input.novelId,
        contentRevision: input.expectedContentRevision,
      },
      data: chapterStatePairAfterQualityGates({ literaryPass: false, styleClear: false }),
    });
    if (projected.count === 0) {
      input.helpers.writeFrame(buildRepairRunStatusFrame({
        chapterId: input.chapterId,
        status: "failed",
        phase: "completed",
        message: "修复复检失败后正文已再次变更，未把最新 revision 标记为 needs_repair。",
      }));
      return;
    }
    input.helpers.writeFrame(buildRepairRunStatusFrame({
      chapterId: input.chapterId,
      status: "failed",
      phase: "completed",
      message: input.userMessage,
    }));
  }
}
