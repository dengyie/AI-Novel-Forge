import type { ChapterArtifactDeltaOutput } from "../../../../prompting/prompts/novel/chapterArtifactDelta.prompts";
import type { SnapshotExtractionOutput } from "../../../state/stateSnapshotExtraction";
import { stateService } from "../../../state/StateService";
import type { ChapterProjectionOwner } from "../projections";
import { cleanNullableText, cleanOptionalText } from "./ChapterArtifactContracts";

export class ChapterStateSnapshotProjection {
  async project(input: {
    owner: ChapterProjectionOwner;
    output: ChapterArtifactDeltaOutput;
  }): Promise<string | null> {
    const state = input.output.stateDeltas;
    const extracted: SnapshotExtractionOutput = {
      summary: cleanOptionalText(state.summary) ?? input.output.summary,
      characterStates: state.characterStates.map((item) => ({
        characterId: cleanOptionalText(item.characterId),
        characterName: cleanOptionalText(item.characterName),
        currentGoal: cleanOptionalText(item.currentGoal),
        emotion: cleanOptionalText(item.emotion),
        stressLevel: typeof item.stressLevel === "number" ? item.stressLevel : undefined,
        secretExposure: cleanOptionalText(item.secretExposure),
        knownFacts: item.knownFacts,
        misbeliefs: item.misbeliefs,
        summary: cleanOptionalText(item.summary),
      })),
      relationStates: state.relationStates.map((item) => ({
        sourceCharacterId: cleanOptionalText(item.sourceCharacterId),
        sourceCharacterName: cleanOptionalText(item.sourceCharacterName),
        targetCharacterId: cleanOptionalText(item.targetCharacterId),
        targetCharacterName: cleanOptionalText(item.targetCharacterName),
        trustScore: typeof item.trustScore === "number" ? item.trustScore : undefined,
        intimacyScore: typeof item.intimacyScore === "number" ? item.intimacyScore : undefined,
        conflictScore: typeof item.conflictScore === "number" ? item.conflictScore : undefined,
        dependencyScore: typeof item.dependencyScore === "number" ? item.dependencyScore : undefined,
        summary: cleanOptionalText(item.summary),
      })),
      informationStates: state.informationStates.map((item) => ({
        holderType: item.holderType,
        holderRefId: cleanNullableText(item.holderRefId),
        holderRefName: cleanNullableText(item.holderRefName),
        fact: item.fact,
        status: item.status,
        summary: cleanOptionalText(item.summary),
      })),
      foreshadowStates: state.foreshadowStates.map((item) => ({
        title: item.title,
        summary: cleanOptionalText(item.summary),
        status: item.status,
        setupChapterId: cleanOptionalText(item.setupChapterId),
        payoffChapterId: cleanNullableText(item.payoffChapterId),
      })),
    };
    const snapshot = await stateService.persistExtractedChapterSnapshot({
      novelId: input.owner.novelId,
      chapterId: input.owner.chapterId,
      expectedContentRevision: input.owner.expectedContentRevision,
      extracted,
      skipPayoffLedgerSync: true,
    });
    return snapshot?.id ?? null;
  }
}
