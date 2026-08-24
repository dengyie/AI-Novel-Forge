import type { ChapterRepairContext, ChapterRuntimePackage } from "@ai-novel/shared/types/chapterRuntime";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import {
  evaluateLengthBudget,
  resolveHardMinWordCount,
  resolveLengthBudgetContract,
} from "@ai-novel/shared/types/chapterLengthControl";
import { runTextPrompt } from "../../../../prompting/core/promptRunner";
import { buildChapterRepairContextBlocks } from "../../../../prompting/prompts/novel/chapterLayeredContext";
import { chapterRepairPrompt } from "../../../../prompting/prompts/novel/review.prompts";
import {
  ChapterPatchRepairFailedError,
  ChapterPatchRepairService,
  type PatchRepairMode,
} from "../../chapterPatchRepairService";
import {
  buildRepairIssuesPayload,
  resolveRepairIssueCodes,
} from "./repairFeedbackPayload";
import {
  QUALITY_FEEDBACK_UNKNOWN_RETRY_MAX,
  type QualityFeedbackPacket,
} from "@ai-novel/shared/types/qualityFeedback";

export { buildRepairIssuesPayload } from "./repairFeedbackPayload";

export interface ChapterRepairExecutionOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  repairMode?: PatchRepairMode;
  /** F6：调用方（SSE 路由）注入的客户端断连中断信号，透传到 heavy prompt options.signal。 */
  signal?: AbortSignal;
}

export interface PrepareChapterRepairExecutionInput {
  novelId: string;
  chapterId: string;
  novelTitle: string;
  chapterTitle: string;
  content: string;
  issues: ReviewIssue[];
  runtimePackage?: ChapterRuntimePackage | null;
  /** 审计层开放硬伤 code（来自 assembled ContextPackage.openAuditIssues，非 LLM 重跑）。
   * streaming repair 无完整 runtimePackage，但可据此让 heavy 候选见到精确硬伤 code。 */
  auditOpenIssueCodes?: string[] | null;
  /** 当前章节最近一次质量环反馈；只供 repair prompt，不进入新的质量评估。 */
  qualityFeedback?: QualityFeedbackPacket[] | null;
  repairContext?: ChapterRepairContext | null;
  bibleContent?: string | null;
  /**
   * 章节目标字数（来自 chapter.targetWordCount）。heavy_repair 据此解析篇幅合同
   * 注入 prompt，让 AI 主动写够（hardMin=target×0.6 不可破）。null/缺失则不设篇幅门。
   */
  targetWordCount?: number | null;
  forceFullRewrite?: boolean;
  options: ChapterRepairExecutionOptions;
}

export interface ChapterHeavyRepairPromptRequest {
  promptInput: {
    novelTitle: string;
    bibleContent: string;
    chapterTitle: string;
    chapterContent: string;
    issuesJson: string;
    ragContext: string;
    modeHint: string;
    /** heavy_repair / light_repair — 让 prompt.render 走差异化改写边界（heavy 允许重写句段）。 */
    repairMode?: string;
    /**
     * 篇幅合同（target/softMin/softMax/hardMin）。仅 heavy_repair 注入到 prompt.render，
     * 让 AI 写够篇幅、不破 hardMin。light_repair 不传（结构上无力扩写整章）。
     */
    lengthBudget?: {
      targetWordCount: number;
      softMinWordCount: number;
      softMaxWordCount: number;
      hardMinWordCount: number;
    } | null;
  };
  contextBlocks?: ReturnType<typeof buildChapterRepairContextBlocks>;
  options: {
    provider?: LLMProvider;
    model?: string;
    temperature: number;
    novelId: string;
    chapterId: string;
    stage: "chapter_repair";
    triggerReason: PatchRepairMode;
    /** F6：透传到 streamTextPrompt 的 PromptExecutionOptions.signal，客户端断连即 abort。 */
    signal?: AbortSignal;
  };
  fallbackContent: string;
}

export type PreparedChapterRepairExecution =
  | {
      kind: "patched";
      content: string;
      issues: ReviewIssue[];
      finalRepairMode: PatchRepairMode;
      modeHint: string;
      escalatedFromPatch: false;
      patchFailure: null;
    }
  | {
      kind: "heavy_repair";
      issues: ReviewIssue[];
      finalRepairMode: "heavy_repair";
      modeHint: string;
      escalatedFromPatch: boolean;
      patchFailure: ChapterPatchRepairFailedError | null;
      prompt: ChapterHeavyRepairPromptRequest;
    };

export interface ExecutedChapterRepair {
  content: string;
  finalRepairMode: PatchRepairMode;
  escalatedFromPatch: boolean;
  patchFailure: ChapterPatchRepairFailedError | null;
}

/**
 * 解析 repair 用的篇幅合同（target/softMin/softMax/hardMin）。
 * 无 targetWordCount（旧数据/无合同）返回 null → 不注入篇幅门。
 * 仅 heavy_repair 使用（见 prepareChapterRepairExecution）。
 */
function resolveRepairLengthBudget(targetWordCount: number | null | undefined): {
  targetWordCount: number;
  softMinWordCount: number;
  softMaxWordCount: number;
  hardMinWordCount: number;
} | null {
  const budget = resolveLengthBudgetContract(targetWordCount);
  if (!budget) {
    return null;
  }
  return {
    targetWordCount: budget.targetWordCount,
    softMinWordCount: budget.softMinWordCount,
    softMaxWordCount: budget.softMaxWordCount,
    hardMinWordCount: resolveHardMinWordCount(budget.targetWordCount),
  };
}

function normalizeRepairIssues(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.length > 0
    ? issues
    : [{
        severity: "medium",
        category: "coherence",
        evidence: "Pipeline quality threshold not met.",
        fixSuggestion: "Tighten continuity, sharpen conflict progression, and improve readability.",
      }];
}

function resolveRepairContext(input: {
  repairContext?: ChapterRepairContext | null;
  runtimePackage?: ChapterRuntimePackage | null;
}): ChapterRepairContext | null {
  return input.repairContext ?? input.runtimePackage?.context.chapterRepairContext ?? null;
}

function resolveBibleContent(input: {
  bibleContent?: string | null;
  runtimePackage?: ChapterRuntimePackage | null;
}): string {
  const explicitBible = input.bibleContent?.trim();
  if (explicitBible) {
    return explicitBible;
  }
  return buildRepairBibleFallback(input.runtimePackage);
}

function buildRepairRagContext(input: {
  repairContext?: ChapterRepairContext | null;
  runtimePackage?: ChapterRuntimePackage | null;
}): string {
  const repairContext = resolveRepairContext(input);
  const writeContext = repairContext?.writeContext ?? input.runtimePackage?.context.chapterWriteContext ?? null;
  if (!writeContext) {
    return "none";
  }
  const fragments = [
    writeContext.previousChapterTail
      ? `上一章尾段：${writeContext.previousChapterTail}`
      : "",
    writeContext.recentChapterSummaries?.length
      ? `最近章节摘要：\n${writeContext.recentChapterSummaries.slice(0, 3).map((item) => `- ${item}`).join("\n")}`
      : "",
    writeContext.openConflictSummaries?.length
      ? `待回收冲突：\n${writeContext.openConflictSummaries.slice(0, 5).map((item) => `- ${item}`).join("\n")}`
      : "",
    writeContext.characterHardFacts?.length
      ? `角色硬事实：\n${writeContext.characterHardFacts.slice(0, 6).map((item) => [
          item.name,
          item.currentState ? `状态=${item.currentState}` : "",
          item.currentGoal ? `目标=${item.currentGoal}` : "",
          item.currentLocation ? `位置=${item.currentLocation}` : "",
          item.prohibitions?.length ? `禁止=${item.prohibitions.join(" / ")}` : "",
        ].filter(Boolean).join(" | ")).join("\n")}`
      : "",
    writeContext.characterResourceContext
      ? [
          "资源事实：",
          ...writeContext.characterResourceContext.availableItems.slice(0, 4).map((item) => `- 可用：${item.name} / ${item.summary}`),
          ...writeContext.characterResourceContext.blockedItems.slice(0, 4).map((item) => `- 不可直接使用：${item.name} / ${item.status} / ${item.summary}`),
          ...writeContext.characterResourceContext.highRiskCommittedItems.slice(0, 3).map((item) => `- 高风险已入账：${item.name} / ${item.summary}`),
          ...writeContext.characterResourceContext.pendingProposalItems.slice(0, 3).map((item) => `- 未确认变更：${item.summary}；确认前不要写成已发生事实`),
        ].join("\n")
      : "",
  ].filter((item) => item.trim().length > 0);
  return fragments.join("\n\n") || "none";
}

export async function prepareChapterRepairExecution(
  input: PrepareChapterRepairExecutionInput,
): Promise<PreparedChapterRepairExecution> {
  const issues = normalizeRepairIssues(input.issues);
  const issueCodes = resolveRepairIssueCodes(
    input.runtimePackage,
    input.auditOpenIssueCodes,
  );
  // 自动补长度分支（改进二）：确定性实测当前正文是否未达 soft 下界
  // （length_under_soft / under_hard），或 qualityFeedback/issueCodes 已带 length_under_*。
  // 命中则把 LENGTH_UNDER_SOFT_MIN 折进 issueCodes（让 getRepairModeHint 自动选
  // extend_for_length），并让局部补丁走新的 length_expansion 扩写类型，而不是改写替换。
  // 这防止短候选被 finalizer 的 length_under_hard 强制 discard 后进入死循环。
  const isUnderLength = (() => {
    const lengthEval = evaluateLengthBudget({
      content: input.content,
      targetWordCount: input.targetWordCount ?? null,
    });
    const codeUnder = issueCodes.some((code) =>
      code.toLowerCase().includes("length_under"));
    const feedbackUnder = (input.qualityFeedback ?? []).some((packet) =>
      packet.codes.some((code) => code.toLowerCase().includes("length_under")));
    return Boolean((lengthEval?.band === "under_soft" || lengthEval?.band === "under_hard") || codeUnder || feedbackUnder);
  })();

  let activeRepairMode = input.options.repairMode ?? "light_repair";
  // 改进二：确定性检测到未达 soft 下界时，非 forceFullRewrite 的局部补丁切到扩写类型。
  const wantLengthExpansion = isUnderLength
    && !input.forceFullRewrite
    && activeRepairMode !== "heavy_repair"
    && (activeRepairMode === "light_repair" || activeRepairMode === "length_expansion");
  if (wantLengthExpansion) {
    activeRepairMode = "length_expansion";
  }
  let issueCodesWithLength = issueCodes;
  if (wantLengthExpansion && !issueCodesWithLength.includes("LENGTH_UNDER_SOFT_MIN")) {
    issueCodesWithLength = [...issueCodesWithLength, "LENGTH_UNDER_SOFT_MIN"];
  }
  // 改进一降级换策略：rootCause=unknown 且未 reachRetry 上限时，下一轮 patch 换角度。
  // 最新 feedback 包的 failedPatchCount < QUALITY_FEEDBACK_UNKNOWN_RETRY_MAX 且
  // avoidRetry=false（见 qualityFeedback.buildQualityFeedbackPacket）说明系统允许继续重试；
  // 这里把同一 signature 第 2 次起的策略从「修复连贯性」轮换到「补长度」或「删冗余」，
  // 避免同路径空转。
  const unknownStillRetryable = (() => {
    const latest = input.qualityFeedback?.at(-1);
    if (!latest) {
      return false;
    }
    return latest.rootCause === "unknown"
      && latest.avoidRetry === false
      && latest.failedPatchCount > 0
      && latest.failedPatchCount < QUALITY_FEEDBACK_UNKNOWN_RETRY_MAX;
  })();
  let resolveModeHint = (mode: PatchRepairMode): string => getRepairModeHint(mode, issueCodesWithLength);
  let modeHint = resolveModeHint(activeRepairMode);
  // 篇幅合同仅 heavy_repair 使用（见下方两处 promptInput）。
  const lengthBudget = resolveRepairLengthBudget(input.targetWordCount ?? null);

  if (input.forceFullRewrite && activeRepairMode !== "heavy_repair") {
    activeRepairMode = "heavy_repair";
    modeHint = resolveModeHint(activeRepairMode);
  }

  if (
    unknownStillRetryable
    && !isUnderLength
    && activeRepairMode !== "heavy_repair"
    // 仅当当前仍为「通用」mode 时才旋转策略。调用方显式指定的专项模式
    // （character_only / continuity_only / ending_only）需被保留，不得被静默覆盖。
    && (activeRepairMode === "light_repair")
  ) {
    // 换一个修复角度：若当前是默认 light_repair，则兜底为「删冗余/压缩」互补方向，
    // 让 LLM 从不同切入点重试，而非重复同一 patch 路径。
    activeRepairMode = "light_repair";
    modeHint = "unknown_retry_rotate：根因未被归类，NPATCH 换角度重试——消除重复/冗余表达、收敛疑似未兑现义务的对话回合，避免重放上轮同一 patch 思路。";
  }

  if (!input.forceFullRewrite && activeRepairMode !== "heavy_repair") {
    const patchRepairService = new ChapterPatchRepairService();
    try {
      const patched = await patchRepairService.repair({
        novelId: input.novelId,
        chapterId: input.chapterId,
        novelTitle: input.novelTitle,
        chapterTitle: input.chapterTitle,
        content: input.content,
        issues,
        runtimePackage: input.runtimePackage,
        auditOpenIssueCodes: input.auditOpenIssueCodes,
        repairContext: input.repairContext,
        qualityFeedback: input.qualityFeedback,
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature,
        repairMode: activeRepairMode,
        modeHint,
      });
      return {
        kind: "patched",
        content: patched.content,
        issues,
        finalRepairMode: activeRepairMode,
        modeHint,
        escalatedFromPatch: false,
        patchFailure: null,
      };
    } catch (error) {
      if (!(error instanceof ChapterPatchRepairFailedError)) {
        throw error;
      }
      if (activeRepairMode === "detect_only") {
        throw error;
      }

      // Root B 宽松锚点重试：patch 锚点失配时，用 continuity_only 模式再试一次，
      // 给 LLM 更宽泛的定位空间，避免直接升级 heavy_repair。
      const looseAnchorMode: PatchRepairMode = "continuity_only";
      const looseAnchorHint = "宽松锚点重试（anchor-loose retry）：不要求精确匹配原文，以段落语义为锚，优先修连续性问题。";
      try {
        const retried = await patchRepairService.repair({
          novelId: input.novelId,
          chapterId: input.chapterId,
          novelTitle: input.novelTitle,
          chapterTitle: input.chapterTitle,
          content: input.content,
          issues,
          runtimePackage: input.runtimePackage,
          auditOpenIssueCodes: input.auditOpenIssueCodes,
          repairContext: input.repairContext,
          qualityFeedback: input.qualityFeedback,
          provider: input.options.provider,
          model: input.options.model,
          temperature: input.options.temperature,
          repairMode: looseAnchorMode,
          modeHint: looseAnchorHint,
        });
        return {
          kind: "patched",
          content: retried.content,
          issues,
          finalRepairMode: looseAnchorMode,
          modeHint: looseAnchorHint,
          escalatedFromPatch: false,
          patchFailure: null,
        };
      } catch (retryError) {
        if (!(retryError instanceof ChapterPatchRepairFailedError)) {
          throw retryError;
        }
        // 宽松锚点重试仍失败 → 升级 heavy_repair
      }

      activeRepairMode = "heavy_repair";
      modeHint = getRepairModeHint(activeRepairMode, issueCodes);
      return {
        kind: "heavy_repair",
        issues,
        finalRepairMode: activeRepairMode,
        modeHint,
        escalatedFromPatch: true,
        patchFailure: error,
        prompt: {
          promptInput: {
            novelTitle: input.novelTitle,
            bibleContent: resolveBibleContent(input),
            chapterTitle: input.chapterTitle,
            chapterContent: input.content,
            issuesJson: buildRepairIssuesPayload(
              issues,
              input.runtimePackage,
              input.auditOpenIssueCodes,
              input.qualityFeedback,
            ),
            ragContext: buildRepairRagContext(input),
            modeHint,
            repairMode: activeRepairMode,
            lengthBudget,
          },
          contextBlocks: resolveRepairContext(input)
            ? buildChapterRepairContextBlocks(resolveRepairContext(input) as ChapterRepairContext)
            : undefined,
          options: {
            provider: input.options.provider,
            model: input.options.model,
            temperature: Math.min(input.options.temperature ?? 0.55, 0.65),
            novelId: input.novelId,
            chapterId: input.chapterId,
            stage: "chapter_repair",
            triggerReason: activeRepairMode,
            signal: input.options.signal,
          },
          fallbackContent: input.content,
        },
      };
    }
  }

  return {
    kind: "heavy_repair",
    issues,
    finalRepairMode: "heavy_repair",
    modeHint,
    escalatedFromPatch: false,
    patchFailure: null,
    prompt: {
      promptInput: {
        novelTitle: input.novelTitle,
        bibleContent: resolveBibleContent(input),
        chapterTitle: input.chapterTitle,
        chapterContent: input.content,
        issuesJson: buildRepairIssuesPayload(
          issues,
          input.runtimePackage,
          input.auditOpenIssueCodes,
          input.qualityFeedback,
        ),
        ragContext: buildRepairRagContext(input),
        modeHint,
        repairMode: activeRepairMode,
        lengthBudget,
      },
      contextBlocks: resolveRepairContext(input)
        ? buildChapterRepairContextBlocks(resolveRepairContext(input) as ChapterRepairContext)
        : undefined,
      options: {
        provider: input.options.provider,
        model: input.options.model,
        temperature: Math.min(input.options.temperature ?? 0.55, 0.65),
        novelId: input.novelId,
        chapterId: input.chapterId,
        stage: "chapter_repair",
        triggerReason: activeRepairMode,
        signal: input.options.signal,
      },
      fallbackContent: input.content,
    },
  };
}

export function createHeavyRepairPromptExecution(
  plan: Extract<PreparedChapterRepairExecution, { kind: "heavy_repair" }>,
): {
  asset: typeof chapterRepairPrompt;
  promptInput: ChapterHeavyRepairPromptRequest["promptInput"];
  contextBlocks?: ChapterHeavyRepairPromptRequest["contextBlocks"];
  options: ChapterHeavyRepairPromptRequest["options"];
} {
  return {
    asset: chapterRepairPrompt,
    promptInput: plan.prompt.promptInput,
    contextBlocks: plan.prompt.contextBlocks,
    options: plan.prompt.options,
  };
}

export async function runChapterRepairText(
  input: PrepareChapterRepairExecutionInput,
): Promise<ExecutedChapterRepair> {
  const prepared = await prepareChapterRepairExecution(input);
  if (prepared.kind === "patched") {
    return {
      content: prepared.content,
      finalRepairMode: prepared.finalRepairMode,
      escalatedFromPatch: false,
      patchFailure: null,
    };
  }

  const repaired = await runTextPrompt(createHeavyRepairPromptExecution(prepared));
  return {
    content: repaired.output.trim() || prepared.prompt.fallbackContent,
    finalRepairMode: prepared.finalRepairMode,
    escalatedFromPatch: prepared.escalatedFromPatch,
    patchFailure: prepared.patchFailure,
  };
}

function buildRepairBibleFallback(runtimePackage: ChapterRuntimePackage | null | undefined): string {
  const context = runtimePackage?.context;
  if (!context) {
    return "none";
  }
  const fragments = [
    context.bookContract?.sellingPoint ? `核心卖点：${context.bookContract.sellingPoint}` : "",
    context.bookContract?.first30ChapterPromise ? `前30章承诺：${context.bookContract.first30ChapterPromise}` : "",
    context.macroConstraints?.coreConflict ? `核心冲突：${context.macroConstraints.coreConflict}` : "",
    context.macroConstraints?.progressionLoop ? `推进回路：${context.macroConstraints.progressionLoop}` : "",
    context.volumeWindow?.missionSummary ? `当前卷使命：${context.volumeWindow.missionSummary}` : "",
  ].filter(Boolean);
  return fragments.join("\n") || "none";
}

export function getRepairModeHint(
  repairMode: PatchRepairMode | undefined,
  issueCodes: string[] = [],
): string {
  if (issueCodes.includes("LENGTH_OVER_HARD_MAX")) {
    return "compress_chapter_for_length：整章压缩重复表达、解释段和无效回合，保留核心推进与结尾压力。";
  }
  if (issueCodes.includes("LENGTH_OVER_SOFT_MAX")) {
    return "compress_tail_for_length：优先回收尾段冗余展开，保留结尾 hook 和关键冲突。";
  }
  if (issueCodes.includes("LENGTH_UNDER_SOFT_MIN")) {
    // 原 switch 里 "length_expansion" 的 case 在此分支出现前即被拦截，属死代码；
    // 此处按 mode 区分合并保留其语义：wantLengthExpansion 时 issueCodes 必带
    // LENGTH_UNDER_SOFT_MIN（见 prepareChapterRepairExecution），故 mode=length_expansion
    // 走到这里必然命中该 if，返回扩写专属提示。
    if (repairMode === "length_expansion") {
      return "extend_for_length（自动补长度）：章节未达目标篇幅（length_under_soft/under_hard）。在指定薄弱处扩写——补足义务场景的关键节拍、动作、反应与细节，把推进落到实处；禁止注水、重复或离题支线凑字，禁止把结尾 hook 推后。";
    }
    return "extend_for_length：只补最后的义务场景或结尾 hook，增加有效推进，不要回顾性凑字数。";
  }
  switch (repairMode) {
    case "continuity_only":
      return "优先修连续性、时间线和事件承接，不做大幅风格重写。";
    case "character_only":
      return "优先修人物言行一致性、动机和关系表现，不改变主线任务。";
    case "ending_only":
      return "优先修章节收束、钩子和结尾决断感，让章节尾部更有拉力。";
    case "heavy_repair":
      return "允许较大幅度重写句段，只要剧情方向不变即可；以 issuesJson/missingObligations/blockingIssueCodes 定向修复硬伤为先，不要凭空新增与原问题无关的新冲突或硬伤。";
    case "light_repair":
    default:
      return "以轻修为主，优先保持原有内容框架和事件顺序。";
  }
}
