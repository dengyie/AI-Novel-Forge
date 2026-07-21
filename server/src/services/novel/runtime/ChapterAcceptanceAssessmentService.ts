import type { AuditReport, AuditType, QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import type {
  ChapterExecutionMissingObligation,
  GenerationContextPackage,
} from "@ai-novel/shared/types/chapterRuntime";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../../db/prisma";
import { runStructuredPrompt } from "../../../prompting/core/promptRunner";
import { resolvePromptContextBlocksForAsset } from "../../../prompting/context/promptContextResolution";
import { buildChapterReviewContextBlocks } from "../../../prompting/prompts/novel/chapterLayeredContext";
import { resolveTargetWordRange } from "../../../prompting/prompts/novel/chapterLayeredContextShared";
import {
  chapterAcceptanceAssessmentPrompt,
  type ChapterAcceptanceAssessmentOutput,
} from "../../../prompting/prompts/novel/chapterAcceptance.prompts";
import { evaluateLengthBudget } from "@ai-novel/shared/types/chapterLengthControl";
import {
  hasReaderExperienceContractValue,
  normalizeReaderExperienceContract,
} from "@ai-novel/shared/types/novel/readerExperience";
import { openConflictService } from "../../state/OpenConflictService";
import { normalizeScore, ruleScore } from "../novelP0Utils";
import {
  isHardCharacterAppearanceMissing,
  isMustOnPageMissingText,
  isSoftOffscreenCharacterAppearanceMissing,
} from "../../../prompting/prompts/novel/characterAppearanceObligation";

export interface ChapterAcceptanceAssessmentInput {
  novelId: string;
  chapterId: string;
  novelTitle: string;
  chapterTitle: string;
  chapterOrder: number;
  targetWordCount?: number | null;
  content: string;
  contextPackage: GenerationContextPackage;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}

export interface NormalizeAssessmentOptions {
  /** 义务合同中的必须出场角色标签（含 must_on_page 标注）。 */
  requiredCharacterAppearances?: string[] | null;
  /**
   * R soft observability: when plan layer claimed a reader-experience contract
   * but it is empty after normalize, tag only (never hard-block).
   */
  expectReaderExperience?: boolean;
  readerExperience?: unknown;
}

export interface ChapterAcceptanceAssessmentResult {
  assessment: ChapterAcceptanceAssessmentOutput;
  score: QualityScore;
  issues: ReviewIssue[];
  auditReports: AuditReport[];
}

type AcceptanceIssue = ChapterAcceptanceAssessmentOutput["blockingIssues"][number];
type AcceptanceRepairDirective = ChapterAcceptanceAssessmentOutput["repairDirectives"][number];

const UNDER_LENGTH_MARKERS = [
  "length_insufficient",
  "length_under",
  "under_soft",
  "too short",
  "insufficient length",
  "word count",
  "正文估算",
  "目标长度",
  "字数",
  "低于",
  "不足",
  "过短",
  "未达",
];

const OVER_LENGTH_MARKERS = [
  "length_over",
  "over_soft",
  "over_hard",
  "too long",
  "exceeds",
  "超出",
  "超过",
  "过长",
  "冗长",
];

function categoryToAuditType(category: AcceptanceIssue["category"]): AuditType {
  if (category === "continuity") return "continuity";
  if (category === "character") return "character";
  if (category === "plot") return "plot";
  return "mode_fit";
}

function categoryToReviewIssueCategory(category: AcceptanceIssue["category"]): ReviewIssue["category"] {
  if (category === "character") return "logic";
  if (category === "plot") return "pacing";
  if (category === "voice") return "voice";
  if (category === "mode_fit") return "coherence";
  return "coherence";
}

function missingObligationToReviewIssue(
  obligation: ChapterExecutionMissingObligation,
  options: NormalizeAssessmentOptions = {},
): ReviewIssue {
  const category: ReviewIssue["category"] = obligation.kind === "character_appearance"
    || obligation.kind === "goal_change"
    ? "logic"
    : obligation.kind === "forbidden_crossing"
      ? "coherence"
      : "pacing";
  const softOffscreen = isSoftOffscreenCharacterAppearanceMissing(obligation);
  const hardAppearance = isHardCharacterAppearanceMissing({
    ...obligation,
    requiredCharacterAppearances: options.requiredCharacterAppearances,
  });
  const severity: ReviewIssue["severity"] = obligation.kind === "forbidden_crossing"
    ? "high"
    : softOffscreen
      ? "low"
      : hardAppearance || isMustOnPageMissingText(`${obligation.summary ?? ""}\n${obligation.evidence ?? ""}`)
        ? "high"
        : "medium";
  return {
    severity,
    category,
    evidence: obligation.evidence?.trim() || obligation.summary,
    fixSuggestion: obligation.summary,
  };
}

function countChapterCharacters(content: string): number {
  return content.replace(/\s+/g, "").trim().length;
}

function includesAnyMarker(text: string, markers: string[]): boolean {
  const normalized = text.toLowerCase();
  return markers.some((marker) => normalized.includes(marker));
}

function isUnderLengthIssue(issue: AcceptanceIssue): boolean {
  const text = [issue.code, issue.evidence, issue.fixSuggestion].join("\n");
  return includesAnyMarker(text, UNDER_LENGTH_MARKERS) && !includesAnyMarker(text, OVER_LENGTH_MARKERS);
}

function isOverLengthIssue(issue: AcceptanceIssue): boolean {
  const text = [issue.code, issue.evidence, issue.fixSuggestion].join("\n");
  return includesAnyMarker(text, OVER_LENGTH_MARKERS);
}

function isLengthDirective(directive: AcceptanceRepairDirective): boolean {
  return includesAnyMarker(directive.instruction, [...UNDER_LENGTH_MARKERS, ...OVER_LENGTH_MARKERS]);
}

/**
 * 硬缺席义务：进 draft_obligation_unmet / blockingObligations。
 * soft-only（payoff_touch、可延后出场等）只进 missing 列表与 partial coverage，
 * 不得抬升 failureClassification（P2-6 假阳性收口）。
 */
export function isHardMissingObligation(
  obligation: ChapterExecutionMissingObligation,
  options: NormalizeAssessmentOptions = {},
): boolean {
  if (obligation.kind === "must_hit_now" || obligation.kind === "forbidden_crossing") {
    return true;
  }
  // must_on_page：文案标记或命中义务合同 requiredCharacterAppearances；故意 offscreen 不硬阻断。
  if (obligation.kind === "character_appearance") {
    return isHardCharacterAppearanceMissing({
      ...obligation,
      requiredCharacterAppearances: options.requiredCharacterAppearances,
    });
  }
  return false;
}

/** 从 missing 中拆出硬/软义务，供 runtime package failureClassification 同源使用。 */
export function partitionHardSoftMissingObligations(
  missingObligations: ChapterExecutionMissingObligation[] | null | undefined,
  options: NormalizeAssessmentOptions = {},
): {
  hard: ChapterExecutionMissingObligation[];
  soft: ChapterExecutionMissingObligation[];
} {
  const hard: ChapterExecutionMissingObligation[] = [];
  const soft: ChapterExecutionMissingObligation[] = [];
  for (const obligation of missingObligations ?? []) {
    if (isHardMissingObligation(obligation, options)) {
      hard.push(obligation);
    } else {
      soft.push(obligation);
    }
  }
  return { hard, soft };
}

function resolveRequiredCharacterAppearances(
  contextPackage?: GenerationContextPackage | null,
  override?: string[] | null,
): string[] {
  if (Array.isArray(override) && override.length > 0) {
    return override;
  }
  const write = contextPackage?.chapterWriteContext?.obligationContract?.requiredCharacterAppearances;
  if (Array.isArray(write) && write.length > 0) {
    return write;
  }
  const review = contextPackage?.chapterReviewContext?.obligationContract?.requiredCharacterAppearances;
  if (Array.isArray(review) && review.length > 0) {
    return review;
  }
  return [];
}

function shouldDropLengthIssue(input: {
  issue: AcceptanceIssue;
  actualWordCount: number;
  minWordCount: number | null;
  maxWordCount: number | null;
}): boolean {
  if (input.minWordCount != null && input.actualWordCount >= input.minWordCount && isUnderLengthIssue(input.issue)) {
    return true;
  }
  if (input.maxWordCount != null && input.actualWordCount <= input.maxWordCount && isOverLengthIssue(input.issue)) {
    return true;
  }
  return false;
}

function isLengthRiskTag(tag: string): boolean {
  return includesAnyMarker(tag, [...UNDER_LENGTH_MARKERS, ...OVER_LENGTH_MARKERS]);
}

function reconcileLengthAssessment(
  output: ChapterAcceptanceAssessmentOutput,
  content: string,
  targetWordCount?: number | null,
): ChapterAcceptanceAssessmentOutput {
  const range = resolveTargetWordRange(targetWordCount);
  const dualBound = evaluateLengthBudget({ content, targetWordCount });
  if (range.minWordCount == null && range.maxWordCount == null && !dualBound) {
    return output;
  }
  const actualWordCount = dualBound?.actualWordCount ?? countChapterCharacters(content);
  const isUnderHard = dualBound?.band === "under_hard";
  // 假阳性清理：仍以 soft 带为界（与历史 resolveTargetWordRange 一致）。
  // hardMax 超界不通过「丢弃 over issue」放行，而是靠 riskTags 可观测。
  // under_hard（字数 < target×0.6）例外：不得丢弃 under-length issue，必须抬升为硬阻断。
  const blockingIssues = output.blockingIssues.filter((issue) => {
    if (isUnderHard && isUnderLengthIssue(issue)) {
      return true;
    }
    return !shouldDropLengthIssue({
      issue,
      actualWordCount,
      minWordCount: range.minWordCount,
      maxWordCount: range.maxWordCount,
    });
  });
  const underHardBlockingIssue = isUnderHard
    && !blockingIssues.some((issue) => isUnderLengthIssue(issue))
    && dualBound
    ? [{
        severity: "high" as const,
        category: "mode_fit" as const,
        code: "length_under_hard",
        evidence: `正文字数 ${actualWordCount} 远低于目标 ${dualBound.budget.targetWordCount}（硬下限 ${dualBound.hardMinWordCount}，目标 ×60%），未达最小可接受长度。`,
        fixSuggestion: "重写或扩写本章，使其达到目标字数硬下限以上；不可静默通过。",
      }]
    : [];
  const blockingIssuesWithHard = underHardBlockingIssue.length > 0
    ? [...blockingIssues, ...underHardBlockingIssue]
    : blockingIssues;
  const droppedLengthNoise = blockingIssues.length !== output.blockingIssues.length;
  const injectedUnderHard = underHardBlockingIssue.length > 0;
  let riskTags = (droppedLengthNoise || injectedUnderHard)
    ? output.riskTags.filter((tag) => !isLengthRiskTag(tag))
    : [...output.riskTags];
  // P2-2：注入双界观测标签（under_soft / over_soft / over_hard），不抬升 hard-block。
  // under_hard：字数硬下限不达标，验收层抬升 repair / quality checkpoint，禁止静默 approved。
  if (dualBound) {
    for (const tag of dualBound.riskTags) {
      if (!riskTags.includes(tag)) {
        riskTags.push(tag);
      }
    }
  }
  if (!droppedLengthNoise && !injectedUnderHard && dualBound?.riskTags.length === 0) {
    return output;
  }
  const repairDirectives = (droppedLengthNoise || injectedUnderHard)
    ? output.repairDirectives.filter((directive) => !isLengthDirective(directive))
    : output.repairDirectives;
  const underHardDirective = injectedUnderHard
    ? [{
        mode: "rewrite" as const,
        target: "plot" as const,
        instruction: `本章字数 ${actualWordCount} 远低于目标 ${dualBound!.budget.targetWordCount}（硬下限 ${dualBound!.hardMinWordCount}）。必须扩写至目标字数软下限以上，不得跳过。`,
      }]
    : [];
  return {
    ...output,
    blockingIssues: blockingIssuesWithHard,
    repairDirectives: underHardDirective.length > 0
      ? [...repairDirectives, ...underHardDirective]
      : repairDirectives,
    riskTags,
  };
}

export function normalizeAssessment(
  output: ChapterAcceptanceAssessmentOutput,
  content: string,
  targetWordCount?: number | null,
  options: NormalizeAssessmentOptions = {},
): ChapterAcceptanceAssessmentOutput {
  const reconciled = reconcileLengthAssessment(output, content, targetWordCount);
  const score = normalizeScore(reconciled.score ?? ruleScore(content));
  const requiredCharacterAppearances = options.requiredCharacterAppearances ?? [];
  // 故意 offscreen 的 character_appearance 保留在 missing 列表供审计，但不抬升 hard repair。
  // 已在 required 名单的角色不得被 soft 标注冲掉硬义务。
  const missingObligations = (reconciled.missingObligations ?? []).map((obligation) => {
    if (!isSoftOffscreenCharacterAppearanceMissing(obligation)) {
      return obligation;
    }
    if (isHardCharacterAppearanceMissing({
      ...obligation,
      requiredCharacterAppearances,
    })) {
      return obligation;
    }
    return {
      ...obligation,
      summary: obligation.summary?.includes("offscreen") || obligation.summary?.includes("可延后")
        ? obligation.summary
        : `${obligation.summary}（可延后出场/offscreen，不记硬缺席）`,
    };
  });
  const hasHighRisk = reconciled.blockingIssues.some((issue) => issue.severity === "high" || issue.severity === "critical");
  const hasHardMissingObligation = missingObligations.some((obligation) => (
    isHardMissingObligation(obligation, { requiredCharacterAppearances })
  ));
  const hasSoftOnlyMissingObligations = missingObligations.length > 0 && !hasHardMissingObligation;
  const hasRepairWork = reconciled.blockingIssues.length > 0
    || reconciled.repairDirectives.length > 0
    || missingObligations.length > 0;
  let status: ChapterAcceptanceAssessmentOutput["status"] = reconciled.status === "accepted" && hasHighRisk
    ? "repairable"
    : reconciled.status;
  if (status === "accepted" && missingObligations.length > 0) {
    status = hasHardMissingObligation ? "repairable" : "continue_with_risk";
  }
  if (status === "needs_manual_review" && !hasHighRisk) {
    status = hasRepairWork ? "repairable" : "continue_with_risk";
  }
  if (
    status === "repairable"
    && hasSoftOnlyMissingObligations
    && !hasHighRisk
    && reconciled.repairability === "patchable_obligation_gap"
  ) {
    status = "continue_with_risk";
  }
  if (status === "repairable" && !hasRepairWork) {
    status = "continue_with_risk";
  }
  if (reconciled.repairability === "plan_misalignment") {
    status = "needs_manual_review";
  }
  const continuePolicy = status === "needs_manual_review"
    ? "pause"
    : status === "repairable"
      ? "repair_once"
      : status === "continue_with_risk" && reconciled.continuePolicy === "pause"
        ? "continue"
        : reconciled.continuePolicy;
  const riskTags = Array.from(new Set(reconciled.riskTags.map((item) => item.trim()).filter(Boolean)));
  // R soft: plan-layer reader experience missing is observable only; never raises hard repair.
  if (options.expectReaderExperience) {
    const reader = normalizeReaderExperienceContract(options.readerExperience);
    if (!hasReaderExperienceContractValue(reader) && !riskTags.includes("reader_experience_missing")) {
      riskTags.push("reader_experience_missing");
    }
  }
  return {
    ...reconciled,
    status,
    score,
    continuePolicy,
    riskTags,
    blockingIssues: reconciled.blockingIssues.slice(0, 5),
    repairDirectives: reconciled.repairDirectives.slice(0, 4),
    missingObligations: missingObligations.slice(0, 8),
  };
}

function buildFallbackAssessment(content: string): ChapterAcceptanceAssessmentOutput {
  const score = ruleScore(content);
  return {
    status: "continue_with_risk",
    score,
    summary: "正文已生成，接收闸门未完成结构化判断，系统将保留正文并标记后续复查风险。",
    blockingIssues: [{
      severity: "medium",
      category: "mode_fit",
      code: "acceptance_gate_unavailable",
      evidence: "章节接收闸门未返回可用结构化结果。",
      fixSuggestion: "保留正文，后续可重新执行章节审校或局部修文。",
    }],
    repairDirectives: [],
    missingObligations: [],
    repairability: "none",
    decisionReason: "接收闸门不可用，系统保留正文并继续推进后续复查。",
    riskTags: ["acceptance_gate_unavailable"],
    assetSyncRecommendation: {
      priority: "normal",
      reason: "正文已保存，但建议后续补跑章节审校或资产同步。",
      requiresFullPayoffReconcile: false,
    },
    continuePolicy: "continue",
  };
}

export class ChapterAcceptanceAssessmentService {
  async assess(input: ChapterAcceptanceAssessmentInput): Promise<ChapterAcceptanceAssessmentResult> {
    const assessment = await this.invokeAssessment(input).catch(() => buildFallbackAssessment(input.content));
    const requiredCharacterAppearances = resolveRequiredCharacterAppearances(input.contextPackage);
    const scenePlan = input.contextPackage.chapterWriteContext?.scenePlan
      ?? input.contextPackage.chapterReviewContext?.scenePlan
      ?? null;
    const readerExperience = scenePlan?.readerExperience;
    // Soft tag only when scene plan exists (plan layer ran) but reader contract is empty.
    const expectReaderExperience = Boolean(scenePlan);
    const normalizeOptions: NormalizeAssessmentOptions = {
      requiredCharacterAppearances,
      expectReaderExperience,
      readerExperience,
    };
    const normalized = normalizeAssessment(
      assessment,
      input.content,
      input.targetWordCount,
      normalizeOptions,
    );
    const score = normalizeScore(normalized.score);
    const issues = normalized.blockingIssues.map((issue) => ({
      severity: issue.severity,
      category: categoryToReviewIssueCategory(issue.category),
      evidence: issue.evidence,
      fixSuggestion: issue.fixSuggestion,
    })).concat(normalized.missingObligations.map((obligation) => (
      missingObligationToReviewIssue(obligation, normalizeOptions)
    )));
    const auditReports = await this.persistAcceptanceReports(input, normalized, score);
    await openConflictService.syncFromAuditReports({
      novelId: input.novelId,
      chapterId: input.chapterId,
      chapterOrder: input.chapterOrder,
      sourceSnapshotId: null,
      auditReports,
    }).catch(() => null);
    return {
      assessment: normalized,
      score,
      issues,
      auditReports,
    };
  }

  private async invokeAssessment(input: ChapterAcceptanceAssessmentInput): Promise<ChapterAcceptanceAssessmentOutput> {
    const fallbackBlocks = input.contextPackage.chapterReviewContext
      ? buildChapterReviewContextBlocks(input.contextPackage.chapterReviewContext)
      : [];
    const resolvedContext = await resolvePromptContextBlocksForAsset({
      asset: chapterAcceptanceAssessmentPrompt,
      executionContext: {
        entrypoint: "chapter_pipeline",
        novelId: input.novelId,
        chapterId: input.chapterId,
        metadata: {
          chapterReviewContext: input.contextPackage.chapterReviewContext,
        },
      },
      fallbackBlocks,
    });
    const result = await runStructuredPrompt({
      asset: chapterAcceptanceAssessmentPrompt,
      promptInput: {
        novelTitle: input.novelTitle,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        targetWordCount: input.targetWordCount ?? null,
        content: input.content,
      },
      contextBlocks: resolvedContext.blocks,
      options: {
        provider: input.provider,
        model: input.model,
        temperature: Math.min(input.temperature ?? 0.2, 0.35),
        novelId: input.novelId,
        chapterId: input.chapterId,
        stage: "chapter_acceptance",
        triggerReason: "chapter_acceptance_assessment",
      },
    });
    return result.output;
  }

  private async persistAcceptanceReports(
    input: ChapterAcceptanceAssessmentInput,
    assessment: ChapterAcceptanceAssessmentOutput,
    score: QualityScore,
  ): Promise<AuditReport[]> {
    const grouped = new Map<AuditType, AcceptanceIssue[]>();
    for (const issue of assessment.blockingIssues) {
      const auditType = categoryToAuditType(issue.category);
      grouped.set(auditType, [...(grouped.get(auditType) ?? []), issue]);
    }
    if (grouped.size === 0) {
      grouped.set("mode_fit", []);
    }
    const auditTypes = Array.from(grouped.keys());
    await prisma.$transaction(async (tx) => {
      await tx.auditReport.deleteMany({
        where: {
          novelId: input.novelId,
          chapterId: input.chapterId,
          auditType: { in: auditTypes },
        },
      });
      for (const auditType of auditTypes) {
        const issues = grouped.get(auditType) ?? [];
        await tx.auditReport.create({
          data: {
            novelId: input.novelId,
            chapterId: input.chapterId,
            auditType,
            overallScore: score.overall,
            summary: assessment.summary,
            legacyScoreJson: JSON.stringify({
              ...score,
              acceptanceStatus: assessment.status,
              continuePolicy: assessment.continuePolicy,
              riskTags: assessment.riskTags,
              assetSyncRecommendation: assessment.assetSyncRecommendation,
              repairDirectives: assessment.repairDirectives,
            }),
            issues: {
              create: issues.map((issue, index) => ({
                auditType,
                severity: issue.severity,
                code: issue.code || `acceptance_${index + 1}`,
                description: issue.evidence,
                evidence: issue.evidence,
                fixSuggestion: issue.fixSuggestion,
              })),
            },
          },
        });
      }
    });
    return prisma.auditReport.findMany({
      where: {
        novelId: input.novelId,
        chapterId: input.chapterId,
        auditType: { in: auditTypes },
      },
      include: {
        issues: {
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    }) as unknown as Promise<AuditReport[]>;
  }
}
