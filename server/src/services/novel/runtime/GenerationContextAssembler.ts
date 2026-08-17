import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import {
  extractQualityFeedbackFromRiskFlags,
  formatPriorQualityFeedbackLines,
  QUALITY_FEEDBACK_PRIOR_LOOKBACK,
  type QualityFeedbackPacket,
} from "@ai-novel/shared/types/qualityFeedback";
import { buildCompressionLog } from "../../../prompting/core/contextBudget";
import { prisma } from "../../../db/prisma";
import { ragServices } from "../../rag";
import { plannerService } from "../../planner/PlannerService";
import { buildChapterRagQuery } from "../NovelReferenceService";
import { NovelContinuationService } from "../NovelContinuationService";
import { StyleBindingService } from "../../styleEngine/StyleBindingService";
import { WorldContextGateway } from "../worldContext/WorldContextGateway";
import { characterDynamicsQueryService } from "../dynamics/CharacterDynamicsQueryService";
import { characterResourceLedgerService } from "../characterResource/CharacterResourceLedgerService";
import { payoffLedgerSyncService } from "../../payoff/PayoffLedgerSyncService";
import { buildSyntheticPayoffIssues } from "../../payoff/payoffLedgerShared";
import {
  buildRuntimeLedgerFromCanonical,
  buildRuntimeOpenConflictsFromCanonical,
  buildRuntimeStateSnapshotFromCanonical,
} from "../state/CanonicalStateService";
import { contextAssemblyService } from "../production/ContextAssemblyService";
import type { ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import { buildPreviousChaptersSummary } from "./runtimeContextBlocks";
import { mapRowToPlan } from "../storyMacro/storyMacroPlanPersistence";
import {
  buildBookContractContext,
  buildNarrativeProgressHint,
  buildChapterRepairContextFromPackage,
  buildChapterReviewContext,
  buildChapterWriteContext,
  buildMacroConstraintContext,
  buildVolumeWindowContext,
  getAllContextBlocks,
  getRuntimePromptBudgetProfiles,
} from "../../../prompting/prompts/novel/chapterLayeredContext";
import { novelFactService } from "../fact/NovelFactService";
import { batchContextCache } from "./BatchContextCache";
import {
  buildRuntimeCharacterHardFactsList,
  parseCharacterProhibitionsJson,
} from "../characters/characterHardFacts";
import type { PendingCharacterHardFactReviewMap } from "../characters/characterHardFacts";
import { NovelVolumeService } from "../volume/NovelVolumeService";
import { ChapterPlanJITService } from "../planning/ChapterPlanJITService";
import {
  buildBlockingPendingReviewProposalWhere,
  loadPendingCharacterHardFactReviews,
} from "./context/pendingReviewContext";
import { buildSyntheticCharacterResourceIssues } from "./context/syntheticCharacterResourceIssues";
import { buildSceneDiversityForceDirective } from "@ai-novel/shared/types/genreBeatQuota";
import { timelineContextService } from "../../../modules/timeline";
import {
  extractChapterTail,
  extractOpening,
  findVolumeWindowSeed,
  mapRuntimeChapterPlan,
  OPENING_COMPARE_LIMIT,
  resolveChapterResourceCharacterIds,
  runtimeChapterSelect,
  SCENE_DIVERSITY_LOOKBACK,
} from "./context/GenerationContextProjection";

export { buildBlockingPendingReviewProposalWhere } from "./context/pendingReviewContext";
export { resolveChapterResourceCharacterIds } from "./context/GenerationContextProjection";

/**
 * Keep invalid chapter bodies out of the direct continuation anchor while retaining
 * their structured quality feedback for the next writer attempt.
 */
export function splitPriorChapterContextRows<
  T extends { chapterStatus?: string | null },
>(rows: T[]): { anchorRows: T[]; feedbackRows: T[] } {
  return {
    anchorRows: rows.filter((row) => row.chapterStatus !== "needs_repair"),
    feedbackRows: rows,
  };
}

export function buildPriorChapterContextQuery(input: {
  novelId: string;
  chapterOrder: number;
  includeNeedsRepair: boolean;
}) {
  return {
    where: {
      novelId: input.novelId,
      order: { lt: input.chapterOrder },
      content: { not: null },
      ...(input.includeNeedsRepair
        ? {}
        : { chapterStatus: { not: "needs_repair" as const } }),
    },
    orderBy: { order: "desc" as const },
    take: Math.max(QUALITY_FEEDBACK_PRIOR_LOOKBACK, 20),
    select: {
      order: true,
      title: true,
      content: true,
      riskFlags: true,
      chapterStatus: true,
    },
  };
}

export class GenerationContextAssembler {
  private readonly continuationService = new NovelContinuationService();
  private readonly worldContextGateway = new WorldContextGateway();
  private readonly styleBindingService = new StyleBindingService();
  private readonly volumeService = new NovelVolumeService();
  private readonly chapterPlanJITService = new ChapterPlanJITService({
    ensureChapterExecutionContract: (novelId, chapterId, options) => (
      this.volumeService.ensureChapterExecutionContract(novelId, chapterId, options)
    ),
  });

  async assemble(
    novelId: string,
    chapterId: string,
    request: ChapterRuntimeRequestInput,
  ): Promise<{
    novel: { id: string; title: string };
    chapter: {
      id: string;
      title: string;
      order: number;
      content: string | null;
      contentRevision: number;
      expectation: string | null;
      targetWordCount: number | null;
      conflictLevel: number | null;
      revealLevel: number | null;
      mustAvoid: string | null;
      taskSheet: string | null;
      sceneCards: string | null;
      hook: string | null;
    };
    contextPackage: GenerationContextPackage;
  }> {
    // Phase 2：novel 稳定层从缓存获取，避免每章重复全量查询
    let [novel, chapter] = await Promise.all([
      batchContextCache.getNovelRow(novelId),
      prisma.chapter.findFirst({
        where: { id: chapterId, novelId },
        select: runtimeChapterSelect,
      }),
    ]);

    if (!novel || !chapter) {
      throw new Error("Novel or chapter not found.");
    }

    // 懒规划 JIT：全书 autopilot 路径在 ensureChapterPlan 之前确保 task sheet 就绪。
    // JIT 生成时会注入已发生事实（factLedger），解决 task sheet 与实际前文脱节问题。
    if (request.controlPolicy?.advanceMode === "full_book_autopilot") {
      await this.chapterPlanJITService.ensureExecutionReady(novelId, chapterId);
    }
    const ensuredPlan = await plannerService.ensureChapterPlan(novelId, chapterId, request);
    const refreshedChapter = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      select: runtimeChapterSelect,
    });
    if (!refreshedChapter) {
      throw new Error("Novel or chapter not found.");
    }
    chapter = refreshedChapter;
    const resourceCharacterIds = resolveChapterResourceCharacterIds({
      plan: ensuredPlan,
      characters: novel.characters,
    });
    const pendingReviewProposalCountPromise = prisma.stateChangeProposal.count({
      where: buildBlockingPendingReviewProposalWhere(novelId, chapterId),
    });
// pending 硬事实评审是辅助上下文：DB 抖动时降级为空 Map，不阻断整章生成
    // （与 NovelReferenceService fail-loud 不同关注点）
    const pendingCharacterHardFactReviewsPromise = loadPendingCharacterHardFactReviews(novelId, chapterId)
      .catch(() => new Map() as PendingCharacterHardFactReviewMap);
    const [
      worldContextBlock,
      pendingReviewProposalCount,
      pendingCharacterHardFactReviews,
      openAuditIssues,
      summaries,
      priorChapterAnchorRows,
      priorChapterFeedbackRows,
      sceneDiversitySourceChapters,
      decisions,
      characterDynamics,
      continuationPack,
      styleContext,
      payoffLedger,
      characterResourceContext,
      timelineContext,
    ] = await Promise.all([
      this.worldContextGateway.getWorldContextBlock(novelId, { purpose: "chapter" }),
      pendingReviewProposalCountPromise,
      pendingCharacterHardFactReviewsPromise,
      prisma.auditIssue.findMany({
        where: {
          status: "open",
          report: {
            is: {
              novelId,
              chapterId,
            },
          },
        },
        orderBy: [{ createdAt: "desc" }],
      }),
      prisma.chapterSummary.findMany({
        where: {
          novelId,
          chapter: { order: { lt: chapter.order } },
        },
        include: { chapter: true },
        orderBy: { chapter: { order: "desc" } },
        take: 3,
      }),
      // A3：承接锚点与 QFP 反馈使用独立 lookback。锚点查询先在数据库排除 needs_repair，
      // 避免连续失败章占满固定窗口；反馈查询保留 needs_repair，确保其结构化纠偏仍可到达 writer。
      prisma.chapter.findMany(buildPriorChapterContextQuery({
        novelId,
        chapterOrder: chapter.order,
        includeNeedsRepair: false,
      })),
      prisma.chapter.findMany(buildPriorChapterContextQuery({
        novelId,
        chapterOrder: chapter.order,
        includeNeedsRepair: true,
      })),
      // 写作近邻多样性：当前章前序 N 章 title/taskSheet + summary（≠ 债板前 30 观测窗）
      prisma.chapter.findMany({
        where: {
          novelId,
          order: { lt: chapter.order },
        },
        orderBy: { order: "desc" },
        take: SCENE_DIVERSITY_LOOKBACK,
        select: {
          order: true,
          title: true,
          taskSheet: true,
          chapterSummary: { select: { summary: true } },
        },
      }),
      prisma.creativeDecision.findMany({
        where: {
          novelId,
          OR: [{ expiresAt: null }, { expiresAt: { gte: chapter.order } }],
        },
        orderBy: [{ importance: "asc" }, { createdAt: "desc" }],
        take: 12,
      }),
      characterDynamicsQueryService.getOverview(novelId, {
        chapterOrder: chapter.order,
      }).catch(() => null),
      this.continuationService.buildChapterContextPack(novelId),
      this.styleBindingService.resolveForGeneration({
        novelId,
        chapterId,
        taskStyleProfileId: request.taskStyleProfileId,
      }),
      payoffLedgerSyncService.getPayoffLedger(novelId, {
        chapterOrder: chapter.order,
      }),
      characterResourceLedgerService.buildContext(novelId, {
        chapterId,
        chapterOrder: chapter.order,
        ...(resourceCharacterIds.length > 0 ? { characterIds: resourceCharacterIds } : {}),
      }).catch(() => null),
      // 写作路径重新注入 timelineContext：writer prompt 仍 required timeline_context，
      // quality gate 在 null 时只能降级 warning，无法做完整时间线检测。
      timelineContextService.buildForChapter({
        novelId,
        chapterId,
        chapterIndex: chapter.order,
      }).catch((error) => {
        console.warn("[context-assembler] timelineContext build failed; writing with empty timeline fallback", {
          novelId,
          chapterId,
          chapterOrder: chapter.order,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    ]);

    const recentChapters = splitPriorChapterContextRows(priorChapterAnchorRows).anchorRows;
    const qualityFeedbackChapters = priorChapterFeedbackRows;

    const resolvedStateDrivenContext = await contextAssemblyService.build({
      novelId,
      chapterId,
      chapterOrder: chapter.order,
      includeCurrentChapterState: false,
      policy: request.controlPolicy,
      pendingReviewProposalCount,
      openAuditIssueCount: openAuditIssues.length,
      hasRepairableDraft: Boolean(chapter.content?.trim()),
    });
    const canonicalState = resolvedStateDrivenContext.snapshot;

    const canonicalLedger = buildRuntimeLedgerFromCanonical(canonicalState);
    const previousChaptersSummary = buildPreviousChaptersSummary(request.previousChaptersSummary, summaries);
    const mappedOpenConflicts = buildRuntimeOpenConflictsFromCanonical(canonicalState);
    const storyMacroPlan = novel.storyMacroPlan ? mapRowToPlan(novel.storyMacroPlan) : null;
    const volumeWindow = buildVolumeWindowContext(findVolumeWindowSeed(
      novel.volumePlans.map((volume) => ({
        id: volume.id,
        sortOrder: volume.sortOrder,
        title: volume.title,
        summary: volume.summary,
        mainPromise: volume.mainPromise,
        openPayoffsJson: volume.openPayoffsJson,
        chapters: volume.chapters,
      })),
      chapter.order,
    ));
    const activeStyleProfileId = styleContext.matchedBindings[0]?.styleProfileId?.trim()
      || styleContext.matchedBindings[0]?.styleProfile?.id?.trim()
      || request.taskStyleProfileId?.trim()
      || "";
    const novelStyleTone = novel.styleTone?.trim() || "";
    const filteredToneGuardrails = canonicalState.bookContract.toneGuardrails.filter((item) => {
      const normalized = item.trim();
      if (!normalized) {
        return false;
      }
      if (!activeStyleProfileId) {
        return true;
      }
      return !novelStyleTone || normalized !== novelStyleTone;
    });
    const bookContract = buildBookContractContext({
      title: canonicalState.bookContract.title,
      genre: canonicalState.bookContract.genre ?? null,
      targetAudience: canonicalState.bookContract.targetAudience ?? novel.targetAudience,
      sellingPoint: canonicalState.bookContract.sellingPoint ?? novel.bookSellingPoint,
      first30ChapterPromise: canonicalState.bookContract.first30ChapterPromise ?? novel.first30ChapterPromise,
      narrativePov: novel.narrativePov,
      pacePreference: novel.pacePreference,
      emotionIntensity: novel.emotionIntensity,
      toneGuardrails: filteredToneGuardrails.length > 0
        ? filteredToneGuardrails
        : (!activeStyleProfileId && novelStyleTone ? [novelStyleTone] : []),
      hardConstraints: canonicalState.bookContract.hardConstraints.length > 0
        ? canonicalState.bookContract.hardConstraints
        : storyMacroPlan?.constraints ?? [],
    });
    const macroConstraints = buildMacroConstraintContext(storyMacroPlan);
    const mappedPlan = mapRuntimeChapterPlan(ensuredPlan);
    const mappedStateSnapshot = buildRuntimeStateSnapshotFromCanonical(canonicalState);
    const canonicalCharacterMap = new Map(
      canonicalState.characters.map((item) => [item.characterId, item]),
    );
    const mappedCharacterRoster = novel.characters.map((item) => {
      const canonicalCharacter = canonicalCharacterMap.get(item.id);
      return {
        id: item.id,
        name: item.name,
        role: item.role,
        personality: item.personality ?? null,
        background: item.background ?? null,
        development: item.development ?? null,
        identityLabel: item.identityLabel ?? null,
        factionLabel: item.factionLabel ?? null,
        stanceLabel: item.stanceLabel ?? null,
        powerLevel: item.powerLevel ?? null,
        realm: item.realm ?? null,
        currentLocation: item.currentLocation ?? null,
        availability: item.availability ?? null,
        prohibitions: parseCharacterProhibitionsJson(item.prohibitionsJson),
        currentState: canonicalCharacter?.currentState ?? item.currentState ?? null,
        currentGoal: canonicalCharacter?.currentGoal ?? item.currentGoal ?? null,
        appearance: item.appearance ?? null,
        physique: item.physique ?? null,
        attireStyle: item.attireStyle ?? null,
        signatureDetail: item.signatureDetail ?? null,
        voiceTexture: item.voiceTexture ?? null,
        presenceImpression: item.presenceImpression ?? null,
      };
    });
    // Union：canonical state 可能含 batchContextCache 缓存窗口内新增的角色，
    // novel.characters（缓存）尚未包含。把缺失角色以 canonical 最小信息补入 roster，
    // 避免新建角色在下一次缓存刷新前被写作引擎完全忽视。
    const rosterIdSet = new Set(mappedCharacterRoster.map((item) => item.id));
    for (const canonical of canonicalState.characters) {
      if (!rosterIdSet.has(canonical.characterId)) {
        mappedCharacterRoster.push({
          id: canonical.characterId,
          name: canonical.name,
          role: canonical.role ?? "unknown",
          personality: null,
          background: null,
          development: null,
          identityLabel: null,
          factionLabel: null,
          stanceLabel: null,
          powerLevel: null,
          realm: null,
          currentLocation: null,
          availability: null,
          prohibitions: [],
          currentState: canonical.currentState ?? null,
          currentGoal: canonical.currentGoal ?? null,
          appearance: null,
          physique: null,
          attireStyle: null,
          signatureDetail: null,
          voiceTexture: null,
          presenceImpression: null,
        });
      }
    }
    const mappedCharacterHardFacts = buildRuntimeCharacterHardFactsList(
      mappedCharacterRoster,
      pendingCharacterHardFactReviews,
    );
    const mappedCreativeDecisions = decisions.map((item) => ({
      id: item.id,
      chapterId: item.chapterId ?? null,
      category: item.category,
      content: item.content,
      importance: item.importance,
      expiresAt: item.expiresAt ?? null,
      sourceType: item.sourceType ?? null,
      sourceRefId: item.sourceRefId ?? null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    }));
    const mappedOpenAuditIssues = openAuditIssues.map((item) => ({
      id: item.id,
      reportId: item.reportId,
      auditType: item.auditType as GenerationContextPackage["openAuditIssues"][number]["auditType"],
      severity: item.severity as GenerationContextPackage["openAuditIssues"][number]["severity"],
      code: item.code,
      description: item.description,
      evidence: item.evidence,
      fixSuggestion: item.fixSuggestion,
      status: item.status as GenerationContextPackage["openAuditIssues"][number]["status"],
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })).concat(
      buildSyntheticPayoffIssues(payoffLedger.items, chapter.order).map((issue) => ({
        id: `payoff-ledger:${issue.ledgerKey}:${issue.code}`,
        reportId: `payoff-ledger:${novelId}:${chapterId}`,
        auditType: "plot" as const,
        severity: issue.severity,
        code: issue.code,
        description: issue.description,
        evidence: issue.evidence,
        fixSuggestion: issue.fixSuggestion,
        status: "open" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      buildSyntheticCharacterResourceIssues(characterResourceContext, { novelId, chapterId }),
    );
    const runtimeContinuation = {
      enabled: continuationPack.enabled,
      sourceType: continuationPack.sourceType,
      sourceId: continuationPack.sourceId,
      sourceTitle: continuationPack.sourceTitle,
      systemRule: continuationPack.systemRule,
      humanBlock: continuationPack.humanBlock,
      antiCopyCorpus: continuationPack.antiCopyCorpus,
    } satisfies GenerationContextPackage["continuation"];

    const nearestPriorChapter = recentChapters[0];
    const rawPreviousChapterTail = extractChapterTail(nearestPriorChapter?.content);
    let previousChapterTail: string | null = rawPreviousChapterTail || null;
    // needs_repair 过滤后，最近合格前章可能不是 N-1；prompt block 文案硬写「上一章实际尾段」
    // 且要求「本章开头必须直接承接」，若把 N-2 甚至更早的尾段当直接上一章喂给 writer，会把
    // 跨章尾段误锚 → 承接错位。此处在内容首段前缀元信息，明确实际章号与跨越区间，chapter
    // 摘要/任务单负责复原被跳过章的进度；prompt block 结构与 schema 均保持不变。
    if (
      previousChapterTail &&
      nearestPriorChapter &&
      nearestPriorChapter.order !== chapter.order - 1
    ) {
      const missingChapterOrder = chapter.order - 1;
      const anchorChapterOrder = nearestPriorChapter.order;
      const gapChapterCount = missingChapterOrder - anchorChapterOrder;
      previousChapterTail = [
        `（元信息：第 ${missingChapterOrder} 章尚待修复未纳入正文承接；以下引用第 ${anchorChapterOrder} 章尾段作为参考锚点，中间跨越 ${gapChapterCount} 章。本章开头承接以此为准，被跳过章的推进请通过章节摘要与任务单复原，不得直接沿用第 ${missingChapterOrder} 章尾段设定。）`,
        rawPreviousChapterTail,
      ].join("\n\n");
    }
    if (!previousChapterTail && chapter.order > 1) {
      // lookback 内无合格章：承接锚点空，续写只能靠摘要/任务单，可观测告警
      console.warn("[context-assembler] previous_chapter_tail empty after needs_repair filter", {
        novelId,
        chapterId,
        chapterOrder: chapter.order,
        eligiblePriorCount: recentChapters.length,
      });
    }
    // A3：近邻章 QFP 投影 → writer/repair「上章纠偏」（确定性模板，非第二 blocking 引擎）。
    // 反馈允许来自 needs_repair 章，但其正文仍被排除在 previous_chapter_tail 之外；这样失败章
    // 的最新根因不会丢失，也不会把不合格正文误当作直接承接锚点。
    const priorQualityPackets: QualityFeedbackPacket[] = qualityFeedbackChapters
      .slice(0, QUALITY_FEEDBACK_PRIOR_LOOKBACK)
      .flatMap((row) => extractQualityFeedbackFromRiskFlags(row.riskFlags));
    const priorQualityFeedback = formatPriorQualityFeedbackLines(priorQualityPackets);

    // 写作近邻同质 → 软强制换场景（advisory；不接 volumeReplanGate；≠ 债板 recommendForce 窗）
    const sceneDiversityRecentTexts = [...sceneDiversitySourceChapters]
      .sort((left, right) => left.order - right.order)
      .map((row) => [
        row.title,
        row.taskSheet,
        row.chapterSummary?.summary,
      ].filter(Boolean).join(" "))
      .filter((text) => text.trim().length > 0);
    const sceneDiversityForce = buildSceneDiversityForceDirective({
      recentTexts: sceneDiversityRecentTexts,
      window: SCENE_DIVERSITY_LOOKBACK,
    });

    const storyWorldSlice = worldContextBlock?.rawSlice ?? null;
    const worldBlock = worldContextBlock?.promptBlock
      ?? "本书世界上下文：暂无。请根据小说基础信息、章节任务和已有连续性推进，不要凭空新增复杂世界规则。";
    const openingHint = await this.buildOpeningConstraintHint(novelId, chapter.order);

    // Phase 2 缺陷6：合并 baseContextPackage 与 contextPackage 为单一构建。
    // 先用占位值构建 chapterWriteContext，再后置填充派生字段，消除字段手抄两遍。
    const sharedFields = {
      chapter: {
        id: chapter.id,
        title: chapter.title,
        order: chapter.order,
        content: chapter.content ?? null,
        contentRevision: chapter.contentRevision,
        expectation: chapter.expectation ?? null,
        targetWordCount: chapter.targetWordCount ?? null,
        conflictLevel: chapter.conflictLevel ?? null,
        revealLevel: chapter.revealLevel ?? null,
        mustAvoid: chapter.mustAvoid ?? null,
        taskSheet: chapter.taskSheet ?? null,
        sceneCards: chapter.sceneCards ?? null,
        hook: chapter.hook ?? null,
        supportingContextText: worldBlock,
      },
      plan: mappedPlan,
      narrativeProgressHint: buildNarrativeProgressHint(
        chapter.order,
        novel.estimatedChapterCount,
      ),
      canonicalState,
      nextAction: resolvedStateDrivenContext.nextAction,
      chapterStateGoal: resolvedStateDrivenContext.chapterStateGoal,
      protectedSecrets: resolvedStateDrivenContext.protectedSecrets,
      pendingReviewProposalCount,
      stateSnapshot: mappedStateSnapshot,
      openConflicts: mappedOpenConflicts,
      storyWorldSlice,
      characterDynamics,
      characterRoster: mappedCharacterRoster,
      characterHardFacts: mappedCharacterHardFacts,
      creativeDecisions: mappedCreativeDecisions,
      openAuditIssues: mappedOpenAuditIssues,
      previousChaptersSummary,
      previousChapterTail,
      priorQualityFeedback,
      openingHint,
      sceneDiversityForce: sceneDiversityForce.shouldForce ? sceneDiversityForce : null,
      continuation: runtimeContinuation,
      styleContext,
      bookContract,
      macroConstraints,
      volumeWindow,
      ledgerPendingItems: canonicalLedger.ledgerPendingItems,
      ledgerUrgentItems: canonicalLedger.ledgerUrgentItems,
      ledgerOverdueItems: canonicalLedger.ledgerOverdueItems,
      ledgerSummary: canonicalLedger.ledgerSummary,
      timelineContext,
      characterResourceContext,
      contextGatingDecisions: [] as GenerationContextPackage["contextGatingDecisions"],
      chapterChangeFlags: {
        introducedPayoff: false,
        payoffResolutionSignal: false,
        relationshipShiftSignal: false,
        majorStateShiftSignal: false,
      },
      tokenBudgetPolicy: {
        chapterBudgetProfile: "balanced" as const,
        stageTokenCap: {
          writer: 2600,
          light_audit: 900,
          full_audit: 2600,
          repair: 2200,
        },
        retryCap: {
          full_audit: 1,
          repair: 1,
        },
        auditMode: "light" as const,
      },
      promptBudgetProfiles: getRuntimePromptBudgetProfiles(),
    };

    // buildChapterWriteContext 仅需稳定字段，用 sharedFields + 占位派生字段构建
    const chapterWriteContext = buildChapterWriteContext({
      bookContract,
      macroConstraints,
      volumeWindow,
      contextPackage: {
        ...sharedFields,
        ragContext: "",
        chapterMission: null,
        chapterWriteContext: null,
        chapterReviewContext: null,
        chapterRepairContext: null,
      },
    });

    // 填充事实账本：读取已发生不可逆事实，注入 completedMilestones
    try {
      const factEntries = await novelFactService.listForChapter({
        novelId,
        beforeChapterOrder: chapter.order,
      });
      if (factEntries.length > 0) {
        chapterWriteContext.completedMilestones = factEntries.map((entry) => entry.text);
      }
    } catch (error) {
      console.warn("[context-assembler] fact ledger read failed, completedMilestones will be empty", {
        novelId,
        chapterOrder: chapter.order,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const partialPackageForReview = {
      ...sharedFields,
      ragContext: "",
      chapterMission: chapterWriteContext.chapterMission,
      chapterWriteContext,
      chapterReviewContext: null,
      chapterRepairContext: null,
    };
    const chapterReviewContext = buildChapterReviewContext(chapterWriteContext, partialPackageForReview);
    const chapterRepairContext = buildChapterRepairContextFromPackage({
      ...partialPackageForReview,
      chapterReviewContext,
    }, []);

    // Retrieve knowledge-base context using a mission-aware query so the recall
    // matches what this chapter is actually trying to do. Built after the
    // chapter write context so the query can fold in the chapter mission and
    // the participating characters rather than only the outline title/summary.
    const ragQuery = buildChapterRagQuery({
      chapterOrder: chapter.order,
      novelTitle: novel.title,
      chapterTitle: chapterWriteContext.chapterMission.title,
      objective: chapterWriteContext.chapterMission.objective,
      expectation: chapterWriteContext.chapterMission.expectation,
      mustAdvance: chapterWriteContext.chapterMission.mustAdvance,
      targetConflicts: chapterWriteContext.chapterStateGoal?.targetConflicts ?? [],
      participantNames: chapterWriteContext.participants.map((participant) => participant.name),
      structuredOutline: novel.structuredOutline ?? null,
    });
    let ragText = "";
    try {
      ragText = await ragServices.hybridRetrievalService.buildContextBlock(ragQuery, {
        novelId,
        currentChapterOrder: chapter.order,
      });
    } catch {
      ragText = "";
    }

    // Phase 2 缺陷6：用 sharedFields 展开，只补充派生字段，消除两遍手抄
    const contextPackage: GenerationContextPackage = {
      ...sharedFields,
      ragContext: ragText,
      chapterMission: chapterWriteContext.chapterMission,
      chapterWriteContext,
      chapterReviewContext,
      chapterRepairContext,
    };
    const compressionLog = buildCompressionLog(
      contextPackage.chapterWriteContext ? getAllContextBlocks(contextPackage) : [],
      2600,
    );
    console.debug("[ctx-budget]", compressionLog);

    return {
      novel: { id: novel.id, title: novel.title },
      chapter: {
        id: chapter.id,
        title: chapter.title,
        order: chapter.order,
        content: chapter.content ?? null,
        contentRevision: chapter.contentRevision,
        expectation: chapter.expectation ?? null,
        targetWordCount: chapter.targetWordCount ?? null,
        conflictLevel: chapter.conflictLevel ?? null,
        revealLevel: chapter.revealLevel ?? null,
        mustAvoid: chapter.mustAvoid ?? null,
        taskSheet: chapter.taskSheet ?? null,
        sceneCards: chapter.sceneCards ?? null,
        hook: chapter.hook ?? null,
      },
      contextPackage,
    };
  }

  private async buildOpeningConstraintHint(novelId: string, chapterOrder: number): Promise<string> {
    const recentChapters = await prisma.chapter.findMany({
      where: {
        novelId,
        order: { lt: chapterOrder },
        content: { not: null },
      },
      orderBy: { order: "desc" },
      take: OPENING_COMPARE_LIMIT,
      select: { order: true, title: true, content: true },
    });

    const openingList = recentChapters
      .map((item) => ({
        order: item.order,
        title: item.title,
        opening: extractOpening(item.content ?? ""),
      }))
      .filter((item) => item.opening.length > 0);

    if (openingList.length === 0) {
      return "Recent openings: none.";
    }

    return [
      "Recent openings (do not reuse the same opening structure or sentence starter):",
      ...openingList.map((item) => `- Chapter ${item.order} ${item.title}: ${item.opening}`),
    ].join("\n");
  }
}
