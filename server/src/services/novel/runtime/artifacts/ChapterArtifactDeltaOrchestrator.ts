import { prisma } from "../../../../db/prisma";
import { runStructuredPrompt } from "../../../../prompting/core/promptRunner";
import { chapterArtifactDeltaPrompt } from "../../../../prompting/prompts/novel/chapterArtifactDelta.prompts";
import { ragServices } from "../../../rag";
import { stateService } from "../../../state/StateService";
import { characterResourceLedgerService } from "../../characterResource/CharacterResourceLedgerService";
import { characterResourceStaleScanService } from "../../characterResource/CharacterResourceStaleScanService";
import { compactText } from "../../characterResource/characterResourceShared";
import { stateCommitService } from "../../state/StateCommitService";
import { normalizeContentProvenance } from "../../state/stateProposalSourceQuality";
import { withBackgroundChapterLlmSlot } from "../backgroundLlmGate";
import {
  ChapterProjectionRevisionGuard,
  type ChapterProjectionOwner,
} from "../projections";
import {
  ARTIFACT_DELTA_SOURCE_STAGE,
  ARTIFACT_DELTA_SOURCE_TYPE,
  buildContentHash,
  toCharacterResourceProposals,
  type ChapterArtifactDeltaSyncInput,
  type ChapterArtifactDeltaSyncResult,
  type CharacterLookupItem,
} from "./ChapterArtifactContracts";
import { ChapterCharacterProjection } from "./ChapterCharacterProjection";
import { ChapterPayoffProjection } from "./ChapterPayoffProjection";
import { ChapterStateSnapshotProjection } from "./ChapterStateSnapshotProjection";
import { ChapterSummaryFactProjection } from "./ChapterSummaryFactProjection";

function stringifyChapterResourceText(
  items: Awaited<ReturnType<typeof characterResourceLedgerService.listResources>>,
): string {
  return items.slice(0, 20).map((item) => [
    `- ${item.name}`,
    `holder=${item.holderCharacterName ?? "未知"}`,
    `status=${item.status}`,
    `function=${item.narrativeFunction}`,
    item.summary,
  ].filter(Boolean).join(" | ")).join("\n");
}

function stringifyPayoffText(items: Array<{
  ledgerKey: string;
  title: string;
  currentStatus: string;
  summary: string;
  targetStartChapterOrder: number | null;
  targetEndChapterOrder: number | null;
  lastTouchedChapterOrder: number | null;
}>): string {
  return items.slice(0, 20).map((item) => [
    `- ${item.ledgerKey} | ${item.title}`,
    `status=${item.currentStatus}`,
    item.targetStartChapterOrder || item.targetEndChapterOrder
      ? `target=${item.targetStartChapterOrder ?? "?"}-${item.targetEndChapterOrder ?? "?"}`
      : "",
    item.lastTouchedChapterOrder ? `lastTouched=${item.lastTouchedChapterOrder}` : "",
    item.summary,
  ].filter(Boolean).join(" | ")).join("\n");
}

function stringifyPreviousState(
  snapshot: Awaited<ReturnType<typeof stateService.getLatestSnapshotBeforeChapter>>,
): string {
  if (!snapshot) return "";
  const characterLines = snapshot.characterStates
    .map((item) => item.summary?.trim()).filter((item): item is string => Boolean(item)).slice(0, 6);
  const relationLines = snapshot.relationStates
    .map((item) => item.summary?.trim()).filter((item): item is string => Boolean(item)).slice(0, 5);
  const infoLines = snapshot.informationStates.map((item) => `${item.holderType}:${item.fact}`).slice(0, 6);
  const foreshadowLines = snapshot.foreshadowStates.map((item) => `${item.title}(${item.status})`).slice(0, 6);
  return [
    snapshot.summary ? `摘要：${snapshot.summary}` : "",
    characterLines.length > 0 ? `角色：\n${characterLines.map((item) => `- ${item}`).join("\n")}` : "",
    relationLines.length > 0 ? `关系：\n${relationLines.map((item) => `- ${item}`).join("\n")}` : "",
    infoLines.length > 0 ? `信息：\n${infoLines.map((item) => `- ${item}`).join("\n")}` : "",
    foreshadowLines.length > 0 ? `伏笔：\n${foreshadowLines.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export class ChapterArtifactDeltaOrchestrator {
  constructor(
    private readonly summaryFacts = new ChapterSummaryFactProjection(),
    private readonly stateSnapshot = new ChapterStateSnapshotProjection(),
    private readonly payoff = new ChapterPayoffProjection(),
    private readonly character = new ChapterCharacterProjection(),
  ) {}

  async syncChapterArtifacts(input: ChapterArtifactDeltaSyncInput): Promise<ChapterArtifactDeltaSyncResult> {
    const content = compactText(input.content);
    if (!content) throw new Error("章节正文为空，无法提取资产 delta。");
    const owner: ChapterProjectionOwner = {
      novelId: input.novelId,
      chapterId: input.chapterId,
      expectedContentRevision: input.contentRevision,
    };
    await new ChapterProjectionRevisionGuard().assertCurrent(owner);

    const [novel, chapter, chapters, characters, existingResources, payoffRows] = await Promise.all([
      prisma.novel.findUnique({ where: { id: input.novelId }, select: { title: true } }),
      prisma.chapter.findFirst({
        where: { id: input.chapterId, novelId: input.novelId, contentRevision: input.contentRevision },
        select: { id: true, order: true, title: true, expectation: true, taskSheet: true },
      }),
      prisma.chapter.findMany({
        where: { novelId: input.novelId },
        select: { id: true, order: true, title: true },
        orderBy: { order: "asc" },
      }),
      prisma.character.findMany({
        where: { novelId: input.novelId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, name: true, role: true, castRole: true, currentGoal: true, currentState: true,
        },
      }),
      characterResourceLedgerService.listResources(input.novelId).catch(() => []),
      prisma.payoffLedgerItem.findMany({
        where: { novelId: input.novelId },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        select: {
          ledgerKey: true, title: true, currentStatus: true, summary: true,
          targetStartChapterOrder: true, targetEndChapterOrder: true, lastTouchedChapterOrder: true,
        },
        take: 30,
      }),
    ]);
    if (!novel || !chapter) {
      await new ChapterProjectionRevisionGuard().assertCurrent(owner);
      throw new Error("小说或章节不存在，无法提取资产 delta。");
    }

    const previousSnapshot = await stateService.getLatestSnapshotBeforeChapter(input.novelId, chapter.order);
    const contentHash = buildContentHash(content);
    const result = await withBackgroundChapterLlmSlot("chapter_artifact_delta", () => runStructuredPrompt({
      asset: chapterArtifactDeltaPrompt,
      promptInput: {
        novelTitle: novel.title,
        chapterOrder: chapter.order,
        chapterTitle: chapter.title,
        chapterGoal: chapter.taskSheet?.trim() || chapter.expectation?.trim() || "无明确章节目标",
        characterRosterText: this.buildCharacterRosterText(characters),
        previousStateText: stringifyPreviousState(previousSnapshot),
        existingResourceText: stringifyChapterResourceText(existingResources),
        existingPayoffText: stringifyPayoffText(payoffRows),
        chapterContent: content,
      },
      options: {
        provider: input.provider,
        model: input.model,
        temperature: Math.min(input.temperature ?? 0.2, 0.4),
        novelId: input.novelId,
        chapterId: input.chapterId,
        stage: "chapter_artifact_delta",
      },
    }));
    await new ChapterProjectionRevisionGuard().assertCurrent(owner);

    const output = result.output;
    const sourceType = input.sourceType?.trim() || ARTIFACT_DELTA_SOURCE_TYPE;
    const sourceStage = input.sourceStage ?? ARTIFACT_DELTA_SOURCE_STAGE;
    const sourceQuality = normalizeContentProvenance(input.contentProvenance);
    const concreteFactCount = await this.summaryFacts.project({
      owner, chapterOrder: chapter.order, content, output,
    });
    const stateSnapshotId = output.syncPlan.stateSnapshot === "skip"
      ? null
      : await this.stateSnapshot.project({ owner, output });
    const resourceProposals = output.syncPlan.characterResources === "skip"
      ? []
      : toCharacterResourceProposals({
          novelId: owner.novelId,
          chapterId: owner.chapterId,
          chapterOrder: chapter.order,
          sourceType,
          sourceStage,
          contentHash,
          sourceQuality,
          characters,
          updates: output.characterResourceDeltas,
        });
    const stateCommitResult = await stateCommitService.proposeAndCommit({
      novelId: owner.novelId,
      chapterId: owner.chapterId,
      chapterOrder: chapter.order,
      sourceType,
      sourceStage,
      contentProvenance: sourceQuality,
      proposals: resourceProposals,
      projectionOwner: owner,
    });
    const staleMarkedCount = await characterResourceStaleScanService.scanAfterChapter({
      novelId: owner.novelId,
      chapterId: owner.chapterId,
      chapterOrder: chapter.order,
      projectionOwner: owner,
    });
    const payoffDeltaCount = output.syncPlan.payoffLedger === "skip"
      ? 0
      : await this.payoff.project({
          owner, chapterOrder: chapter.order, chapterTitle: chapter.title,
          chapters, output, stateSnapshotId,
        });
    const characterDynamicsCount = output.syncPlan.characterDynamics === "skip"
      ? 0
      : await this.character.projectDynamics({ owner, chapterOrder: chapter.order, characters, output });
    const characterKnowledgeStateCount = output.characterKnowledgeStates.length === 0
      ? 0
      : await this.character.projectKnowledge({ owner, characters, output });
    await new ChapterProjectionRevisionGuard().assertCurrent(owner);
    this.queueRagUpsert("chapter", owner.chapterId);
    this.queueRagUpsert("chapter_summary", owner.chapterId);
    return {
      contentHash,
      output,
      stateSnapshotId,
      characterResourceProposalCount: resourceProposals.length,
      characterDynamicsCount,
      characterKnowledgeStateCount,
      payoffDeltaCount,
      canonicalCommittedCount: stateCommitResult.committed.length,
      concreteFactCount,
      staleMarkedCount,
      requiresFullReconcile: output.requiresFullReconcile || output.syncPlan.payoffLedger === "full_reconcile",
    };
  }

  private buildCharacterRosterText(characters: CharacterLookupItem[]): string {
    return characters.map((character) => [
      `- ${character.id}`, character.name, character.role,
      character.castRole ? `cast=${character.castRole}` : "",
      character.currentGoal ? `goal=${character.currentGoal}` : "",
      character.currentState ? `state=${character.currentState}` : "",
    ].filter(Boolean).join(" | ")).join("\n");
  }

  private queueRagUpsert(ownerType: "chapter" | "chapter_summary", ownerId: string): void {
    void ragServices.ragIndexService.enqueueUpsert(ownerType, ownerId).catch(() => null);
  }
}
