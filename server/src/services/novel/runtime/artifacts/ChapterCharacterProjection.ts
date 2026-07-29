import type { ChapterArtifactDeltaOutput } from "../../../../prompting/prompts/novel/chapterArtifactDelta.prompts";
import { prisma } from "../../../../db/prisma";
import {
  ChapterProjectionRevisionGuard,
  type ChapterProjectionOwner,
} from "../projections";
import {
  ARTIFACT_DELTA_SOURCE_TYPE,
  buildKnowledgeBoundaryLine,
  clampConfidence,
  mergeKnowledgeBoundaryState,
  normalizeName,
  type CharacterLookupItem,
} from "./ChapterArtifactContracts";

export class ChapterCharacterProjection {
  async projectDynamics(input: {
    owner: ChapterProjectionOwner;
    chapterOrder: number;
    characters: CharacterLookupItem[];
    output: ChapterArtifactDeltaOutput;
  }): Promise<number> {
    const characterByName = new Map(input.characters.map((item) => [normalizeName(item.name), item]));
    const [currentVolume, relations] = await Promise.all([
      prisma.volumePlan.findFirst({
        where: {
          novelId: input.owner.novelId,
          chapters: {
            some: { chapterOrder: input.chapterOrder },
          },
        },
        select: { id: true },
      }),
      prisma.characterRelation.findMany({
        where: { novelId: input.owner.novelId },
        select: {
          id: true,
          sourceCharacterId: true,
          targetCharacterId: true,
        },
      }),
    ]);
    const relationByPair = new Map(relations.map((relation) => [
      `${relation.sourceCharacterId}:${relation.targetCharacterId}`,
      relation,
    ]));

    let writeCount = 0;
    await prisma.$transaction(async (tx) => {
      await new ChapterProjectionRevisionGuard(tx).lockCurrentForWrite(input.owner);
      await tx.characterCandidate.deleteMany({
        where: {
          novelId: input.owner.novelId,
          sourceChapterId: input.owner.chapterId,
          status: "pending",
        },
      });
      for (const candidate of input.output.characterCandidates) {
        const proposed = characterByName.get(normalizeName(candidate.proposedName));
        const matched = candidate.matchedCharacterName
          ? characterByName.get(normalizeName(candidate.matchedCharacterName))
          : proposed;
        if (matched) {
          continue;
        }
        await tx.characterCandidate.create({
          data: {
            novelId: input.owner.novelId,
            sourceChapterId: input.owner.chapterId,
            proposedName: candidate.proposedName,
            proposedRole: candidate.proposedRole || null,
            summary: candidate.summary || null,
            evidenceJson: JSON.stringify(Array.from(new Set(candidate.evidence))),
            matchedCharacterId: null,
            status: "pending",
            confidence: clampConfidence(candidate.confidence),
          },
        });
        writeCount += 1;
      }

      await tx.characterFactionTrack.deleteMany({
        where: {
          novelId: input.owner.novelId,
          chapterId: input.owner.chapterId,
          sourceType: ARTIFACT_DELTA_SOURCE_TYPE,
        },
      });
      for (const update of input.output.factionUpdates) {
        const character = characterByName.get(normalizeName(update.characterName));
        if (!character) {
          continue;
        }
        await tx.characterFactionTrack.create({
          data: {
            novelId: input.owner.novelId,
            characterId: character.id,
            volumeId: currentVolume?.id ?? null,
            chapterId: input.owner.chapterId,
            chapterOrder: input.chapterOrder,
            factionLabel: update.factionLabel,
            stanceLabel: update.stanceLabel || null,
            summary: update.summary || null,
            sourceType: ARTIFACT_DELTA_SOURCE_TYPE,
            confidence: clampConfidence(update.confidence),
          },
        });
        writeCount += 1;
      }

      await tx.characterRelationStage.deleteMany({
        where: {
          novelId: input.owner.novelId,
          chapterId: input.owner.chapterId,
          sourceType: ARTIFACT_DELTA_SOURCE_TYPE,
        },
      });
      for (const dynamic of input.output.relationDynamics) {
        const sourceCharacter = characterByName.get(normalizeName(dynamic.sourceCharacterName));
        const targetCharacter = characterByName.get(normalizeName(dynamic.targetCharacterName));
        if (!sourceCharacter || !targetCharacter || sourceCharacter.id === targetCharacter.id) {
          continue;
        }
        await tx.characterRelationStage.updateMany({
          where: {
            novelId: input.owner.novelId,
            sourceCharacterId: sourceCharacter.id,
            targetCharacterId: targetCharacter.id,
            isCurrent: true,
          },
          data: { isCurrent: false },
        });
        const relation = relationByPair.get(`${sourceCharacter.id}:${targetCharacter.id}`) ?? null;
        await tx.characterRelationStage.create({
          data: {
            novelId: input.owner.novelId,
            relationId: relation?.id ?? null,
            sourceCharacterId: sourceCharacter.id,
            targetCharacterId: targetCharacter.id,
            volumeId: currentVolume?.id ?? null,
            chapterId: input.owner.chapterId,
            chapterOrder: input.chapterOrder,
            stageLabel: dynamic.stageLabel,
            stageSummary: dynamic.stageSummary,
            nextTurnPoint: dynamic.nextTurnPoint || null,
            sourceType: ARTIFACT_DELTA_SOURCE_TYPE,
            confidence: clampConfidence(dynamic.confidence),
            isCurrent: true,
          },
        });
        writeCount += 1;
      }
    });
    return writeCount;
  }

  async projectKnowledge(input: {
    owner: ChapterProjectionOwner;
    characters: CharacterLookupItem[];
    output: ChapterArtifactDeltaOutput;
  }): Promise<number> {
    const characterByName = new Map(input.characters.map((item) => [normalizeName(item.name), item]));
    // 先解析出本章节命中角色的 id 与边界行，避免在事务内重复做 LLM 输出归一化。
    const pendingUpdates = input.output.characterKnowledgeStates
      .map((state) => {
        const character = characterByName.get(normalizeName(state.characterName));
        const boundaryLine = buildKnowledgeBoundaryLine(state);
        if (!character || !boundaryLine) {
          return null;
        }
        return {
          characterId: character.id,
          boundaryLine,
        };
      })
      .filter((item): item is { characterId: string; boundaryLine: string } => Boolean(item));
    if (pendingUpdates.length === 0) {
      return 0;
    }

    let writeCount = 0;
    await prisma.$transaction(async (tx) => {
      await new ChapterProjectionRevisionGuard(tx).lockCurrentForWrite(input.owner);
      for (const update of pendingUpdates) {
        // 事务内重读 currentState：同一 syncChapterArtifacts 流程里 proposeAndCommit
        // （StateCommitService）会先行把 resource/knowledge 类提案的 currentState 落库，
        // 若仍使用闭包外 characters 列表里的旧 currentState 合并，会以旧值覆盖新值
        // 造成 lost-update。在事务内 findUnique 让 merge 基于最新落库值。
        const fresh = await tx.character.findUnique({
          where: { id: update.characterId },
          select: { currentState: true },
        });
        const previousState = fresh?.currentState ?? null;
        const nextCurrentState = mergeKnowledgeBoundaryState(previousState, update.boundaryLine);
        if (nextCurrentState === (previousState ?? "")) {
          continue;
        }
        await tx.character.update({
          where: { id: update.characterId },
          data: { currentState: nextCurrentState },
        });
        writeCount += 1;
      }
    });
    return writeCount;
  }

}
