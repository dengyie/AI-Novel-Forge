import type { ContentProvenance, StateChangeProposal } from "@ai-novel/shared/types/canonicalState";
import type { ChapterArtifactDeltaOutput } from "../../../../prompting/prompts/novel/chapterArtifactDelta.prompts";
import { createHash } from "node:crypto";
import { compactText, normalizeResourceKey } from "../../characterResource/characterResourceShared";
import { attachProposalSourceQuality } from "../../state/stateProposalSourceQuality";

export const ARTIFACT_DELTA_SOURCE_TYPE = "chapter_artifact_delta";
export const ARTIFACT_DELTA_SOURCE_STAGE = "chapter_execution";

export type CharacterLookupItem = {
  id: string;
  name: string;
  role: string;
  castRole: string | null;
  currentGoal: string | null;
  currentState: string | null;
};

export type ChapterReference = { id: string; order: number; title: string };
export type ChapterArtifactDeltaResourceUpdate = ChapterArtifactDeltaOutput["characterResourceDeltas"][number];
export type ChapterArtifactPayoffDelta = ChapterArtifactDeltaOutput["payoffDeltas"][number];
export type ChapterArtifactKnowledgeState = ChapterArtifactDeltaOutput["characterKnowledgeStates"][number];

export interface ChapterArtifactDeltaSyncInput {
  novelId: string;
  chapterId: string;
  content: string;
  contentRevision: number;
  sourceType?: string;
  sourceStage?: string | null;
  provider?: string;
  model?: string;
  temperature?: number;
  contentProvenance?: ContentProvenance;
}

export interface ChapterArtifactDeltaSyncResult {
  contentHash: string;
  output: ChapterArtifactDeltaOutput;
  stateSnapshotId: string | null;
  characterResourceProposalCount: number;
  characterDynamicsCount: number;
  characterKnowledgeStateCount: number;
  payoffDeltaCount: number;
  canonicalCommittedCount: number;
  concreteFactCount: number;
  staleMarkedCount: number;
  requiresFullReconcile: boolean;
}

export function buildContentHash(content: string): string {
  return createHash("sha256").update(compactText(content)).digest("hex").slice(0, 24);
}

export function normalizeName(value: string | null | undefined): string {
  return compactText(value).replace(/\s+/g, "").toLowerCase();
}

export function cleanOptionalText(value: string | null | undefined): string | undefined {
  const normalized = compactText(value);
  return normalized || undefined;
}

export function cleanNullableText(value: string | null | undefined): string | null {
  return compactText(value) || null;
}

export function clampConfidence(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

export function resolveCharacter(
  characters: Array<{ id: string; name: string }>,
  name: string | null | undefined,
): { id: string; name: string } | null {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  const exact = characters.find((item) => normalizeName(item.name) === normalized);
  if (exact) return exact;
  return characters.find((item) => {
    const itemName = normalizeName(item.name);
    return itemName && (normalized.includes(itemName) || itemName.includes(normalized));
  }) ?? null;
}

export function uniqueTextItems(items: string[] | null | undefined, maxItems: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items ?? []) {
    const normalized = compactText(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxItems) break;
  }
  return result;
}

export function joinFactContents(items: string[], maxItems = 3): string | null {
  return uniqueTextItems(items, maxItems).join("；") || null;
}

export function buildKnowledgeBoundaryLine(state: ChapterArtifactKnowledgeState): string | null {
  const knownFacts = uniqueTextItems(state.knownFacts, 5);
  const hiddenFacts = uniqueTextItems(state.hiddenFacts, 5);
  if (knownFacts.length === 0 && hiddenFacts.length === 0) return null;
  return [
    "【信息边界】",
    knownFacts.length > 0 ? `已知：${knownFacts.join("；")}` : "已知：无新增",
    hiddenFacts.length > 0 ? `未知/不应超前知情：${hiddenFacts.join("；")}` : "未知/不应超前知情：无",
  ].join("");
}

export function mergeKnowledgeBoundaryState(currentState: string | null | undefined, boundaryLine: string): string {
  const base = String(currentState ?? "").replace(/\n?【信息边界】[^\n]*/g, "").trim();
  const cappedBoundary = boundaryLine.slice(0, 1200);
  const baseBudget = Math.max(0, 1200 - cappedBoundary.length - (base ? 1 : 0));
  return [base.slice(0, baseBudget).trim(), cappedBoundary].filter(Boolean).join("\n");
}

export function normalizeLedgerKey(title: string, fallback: string): string {
  const base = compactText(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return base || fallback;
}

export function toCharacterResourceProposals(input: {
  novelId: string;
  chapterId: string;
  chapterOrder: number;
  sourceType: string;
  sourceStage: string | null;
  contentHash: string;
  sourceQuality: ContentProvenance;
  characters: CharacterLookupItem[];
  updates: ChapterArtifactDeltaResourceUpdate[];
}): StateChangeProposal[] {
  return input.updates.map((update) => {
    const holderCharacter = resolveCharacter(input.characters, update.holderCharacterName);
    const previousHolderCharacter = resolveCharacter(input.characters, update.previousHolderCharacterName);
    const knownByCharacterIds = update.knownByCharacterNames
      .map((name) => resolveCharacter(input.characters, name)?.id)
      .filter((id): id is string => Boolean(id));
    const ownerCharacter = update.ownerType === "character"
      ? resolveCharacter(input.characters, update.ownerName) ?? holderCharacter
      : null;
    const resourceKey = normalizeResourceKey({
      name: update.resourceName,
      holderCharacterId: holderCharacter?.id,
      ownerName: update.ownerName ?? null,
    });
    const proposal: StateChangeProposal = {
      novelId: input.novelId,
      chapterId: input.chapterId,
      sourceSnapshotId: null,
      sourceType: input.sourceType,
      sourceStage: input.sourceStage,
      proposalType: "character_resource_update",
      riskLevel: update.riskLevel,
      status: "validated",
      summary: `${update.resourceName} resource delta in chapter ${input.chapterOrder}`,
      payload: {
        resourceKey,
        resourceName: update.resourceName,
        chapterOrder: input.chapterOrder,
        resourceType: update.resourceType,
        narrativeFunction: update.narrativeFunction,
        updateType: update.updateType,
        ownerType: update.ownerType,
        ownerId: ownerCharacter?.id ?? null,
        ownerName: update.ownerName ?? update.holderCharacterName ?? null,
        holderCharacterId: holderCharacter?.id ?? null,
        holderCharacterName: holderCharacter?.name ?? update.holderCharacterName ?? null,
        previousHolderCharacterId: previousHolderCharacter?.id ?? null,
        statusAfter: update.statusAfter,
        visibilityAfter: {
          readerKnows: update.readerKnows,
          holderKnows: update.holderKnows,
          knownByCharacterIds,
        },
        summary: update.summary ?? undefined,
        narrativeImpact: update.narrativeImpact,
        expectedFutureUse: update.expectedFutureUse ?? null,
        expectedUseStartChapterOrder: update.expectedUseStartChapterOrder ?? null,
        expectedUseEndChapterOrder: update.expectedUseEndChapterOrder ?? null,
        constraints: update.constraints,
        confidence: update.confidence ?? null,
        syncContentHash: input.contentHash,
      },
      evidence: update.evidence,
      validationNotes: [update.riskReason ?? ""].filter(Boolean),
    };
    return attachProposalSourceQuality(proposal, input.sourceQuality);
  });
}
