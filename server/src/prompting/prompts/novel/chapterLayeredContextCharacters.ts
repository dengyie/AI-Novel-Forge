import type {
  ChapterWriteContext,
  GenerationContextPackage,
} from "@ai-novel/shared/types/chapterRuntime";
import { compactText, takeUnique } from "./chapterLayeredContextShared";

function buildVisibleProfileSummary(
  character: GenerationContextPackage["characterRoster"][number] | undefined,
): string | null {
  if (!character) {
    return null;
  }
  const parts = takeUnique([
    character.appearance || character.physique
      ? `样貌/体态=${compactText([character.appearance, character.physique].filter(Boolean).join("；"))}`
      : "",
    character.signatureDetail ? `标志=${compactText(character.signatureDetail)}` : "",
    character.voiceTexture ? `声音=${compactText(character.voiceTexture)}` : "",
  ], 3);
  return parts.length > 0 ? parts.join(" | ") : null;
}

function absenceRiskRank(risk: "none" | "info" | "warn" | "high"): number {
  return ["none", "info", "warn", "high"].indexOf(risk);
}

export function buildDynamicCharacterGuidance(
  contextPackage: GenerationContextPackage,
): Pick<ChapterWriteContext, "characterBehaviorGuides" | "activeRelationStages" | "pendingCandidateGuards"> {
  const overview = contextPackage.characterDynamics;
  if (!overview) {
    return {
      characterBehaviorGuides: [],
      activeRelationStages: [],
      pendingCandidateGuards: [],
    };
  }

  const currentChapterOrder = contextPackage.chapter.order;
  const rosterById = new Map(contextPackage.characterRoster.map((character) => [character.id, character]));
  const planParticipantNames = new Set((contextPackage.plan?.participants ?? []).map((item) => compactText(item)));
  const conflictCharacterIds = new Set(
    contextPackage.openConflicts.flatMap((conflict) => conflict.affectedCharacterIds ?? []),
  );

  const activeRelationStages = overview.relations
    .slice(0, 8)
    .map((relation) => ({
      relationId: relation.relationId ?? null,
      sourceCharacterId: relation.sourceCharacterId,
      sourceCharacterName: compactText(relation.sourceCharacterName, relation.sourceCharacterId),
      targetCharacterId: relation.targetCharacterId,
      targetCharacterName: compactText(relation.targetCharacterName, relation.targetCharacterId),
      stageLabel: compactText(relation.stageLabel),
      stageSummary: compactText(relation.stageSummary),
      nextTurnPoint: compactText(relation.nextTurnPoint, "") || null,
      isCurrent: relation.isCurrent,
    }));
  const relationStageByCharacterId = new Map<string, typeof activeRelationStages>();
  for (const relation of activeRelationStages) {
    const sourceStages = relationStageByCharacterId.get(relation.sourceCharacterId) ?? [];
    sourceStages.push(relation);
    relationStageByCharacterId.set(relation.sourceCharacterId, sourceStages);

    const targetStages = relationStageByCharacterId.get(relation.targetCharacterId) ?? [];
    targetStages.push(relation);
    relationStageByCharacterId.set(relation.targetCharacterId, targetStages);
  }

  const characterBehaviorGuides = overview.characters
    .filter((item) => rosterById.has(item.characterId))
    .map((item) => {
      const roster = rosterById.get(item.characterId);
      const relationStages = relationStageByCharacterId.get(item.characterId) ?? [];
      const shouldPreferAppearance = item.isCoreInVolume && (
        item.plannedChapterOrders.includes(currentChapterOrder)
        || item.absenceRisk === "high"
        || item.absenceRisk === "warn"
      );
      let score = 0;
      if (item.isCoreInVolume) {
        score += 40;
      }
      if (item.volumeResponsibility) {
        score += 20;
      }
      if (item.plannedChapterOrders.includes(currentChapterOrder)) {
        score += 25;
      }
      if (relationStages.length > 0) {
        score += 24;
      }
      if (item.absenceRisk === "high") {
        score += 30;
      } else if (item.absenceRisk === "warn") {
        score += 20;
      } else if (item.absenceRisk === "info") {
        score += 8;
      }
      if (planParticipantNames.has(item.name)) {
        score += 16;
      }
      if (conflictCharacterIds.has(item.characterId)) {
        score += 12;
      }
      if (item.currentGoal) {
        score += 4;
      }
      return {
        score,
        guide: {
          characterId: item.characterId,
          name: item.name,
          role: roster?.role ?? item.role,
          castRole: item.castRole ?? null,
          volumeRoleLabel: item.volumeRoleLabel ?? null,
          volumeResponsibility: item.volumeResponsibility ?? null,
          currentGoal: roster?.currentGoal ?? item.currentGoal ?? null,
          currentState: roster?.currentState ?? item.currentState ?? null,
          visibleProfileSummary: buildVisibleProfileSummary(roster),
          factionLabel: item.factionLabel ?? null,
          stanceLabel: item.stanceLabel ?? null,
          relationStageLabels: takeUnique(
            relationStages.map((relation) => (
              relation.nextTurnPoint
                ? `${relation.stageLabel} -> ${relation.nextTurnPoint}`
                : relation.stageLabel
            )),
            3,
          ),
          relationRiskNotes: takeUnique(
            relationStages.map((relation) => (
              `${relation.sourceCharacterName} / ${relation.targetCharacterName}: ${relation.stageSummary}${relation.nextTurnPoint ? ` | next=${relation.nextTurnPoint}` : ""}`
            )),
            3,
          ),
          plannedChapterOrders: item.plannedChapterOrders,
          absenceRisk: item.absenceRisk,
          absenceSpan: item.absenceSpan,
          isCoreInVolume: item.isCoreInVolume,
          shouldPreferAppearance,
        },
      };
    })
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.guide.shouldPreferAppearance !== right.guide.shouldPreferAppearance) {
        return left.guide.shouldPreferAppearance ? -1 : 1;
      }
      if (left.guide.isCoreInVolume !== right.guide.isCoreInVolume) {
        return left.guide.isCoreInVolume ? -1 : 1;
      }
      if (left.guide.absenceRisk !== right.guide.absenceRisk) {
        return absenceRiskRank(right.guide.absenceRisk) - absenceRiskRank(left.guide.absenceRisk);
      }
      return left.guide.name.localeCompare(right.guide.name, "zh-Hans-CN");
    })
    .slice(0, 8)
    .map((item) => item.guide);

  return {
    characterBehaviorGuides,
    activeRelationStages,
    pendingCandidateGuards: overview.candidates
      .slice(0, 4)
      .map((candidate) => ({
        id: candidate.id,
        proposedName: compactText(candidate.proposedName),
        proposedRole: compactText(candidate.proposedRole, "") || null,
        summary: compactText(candidate.summary, "") || null,
        evidence: takeUnique(candidate.evidence, 3),
        sourceChapterOrder: candidate.sourceChapterOrder ?? null,
      })),
  };
}

const MAX_PARTICIPANTS = 6;

export interface ParticipantsSelection {
  participants: GenerationContextPackage["characterRoster"];
  /** true 表示结果来自「与本章相关」的选择链；false 表示盲兜底（roster 前4），不可当作在场信号。 */
  isRelevanceBased: boolean;
}

export function buildParticipants(
  contextPackage: GenerationContextPackage,
  characterBehaviorGuides: ChapterWriteContext["characterBehaviorGuides"] = [],
  requiredCharacterIds: ReadonlySet<string> = new Set(),
): GenerationContextPackage["characterRoster"] {
  return selectParticipants(contextPackage, characterBehaviorGuides, requiredCharacterIds).participants;
}

export function selectParticipants(
  contextPackage: GenerationContextPackage,
  characterBehaviorGuides: ChapterWriteContext["characterBehaviorGuides"] = [],
  requiredCharacterIds: ReadonlySet<string> = new Set(),
): ParticipantsSelection {
  const rosterById = new Map(contextPackage.characterRoster.map((character) => [character.id, character]));
  const participantNames = new Set(contextPackage.plan?.participants ?? []);
  const conflictCharacterIds = new Set(
    contextPackage.openConflicts.flatMap((conflict) => conflict.affectedCharacterIds ?? []),
  );
  // 必须出场（must_on_page）角色不被 slice(0,6) 截断：先收集 required，
  // 再用其余选中项填满剩余名额。required 超过 6 人时全部保留（义务优先于窗口）。
  const selectWithRequired = (
    ordered: Array<GenerationContextPackage["characterRoster"][number] | undefined>,
  ): GenerationContextPackage["characterRoster"] => {
    const deduped: GenerationContextPackage["characterRoster"] = [];
    const seen = new Set<string>();
    for (const character of ordered) {
      if (!character || seen.has(character.id)) {
        continue;
      }
      seen.add(character.id);
      deduped.push(character);
    }
    const required = deduped.filter((character) => requiredCharacterIds.has(character.id));
    const optional = deduped.filter((character) => !requiredCharacterIds.has(character.id));
    // required 之外 roster 里若还有 required 角色（guide 过滤未选中但义务要求出场），也要补上
    for (const id of requiredCharacterIds) {
      if (seen.has(id)) {
        continue;
      }
      const character = rosterById.get(id);
      if (character) {
        seen.add(id);
        required.push(character);
      }
    }
    return [...required, ...optional.slice(0, Math.max(0, MAX_PARTICIPANTS - required.length))];
  };
  if (characterBehaviorGuides.length > 0) {
    const selected = characterBehaviorGuides
      .filter((guide) => (
        guide.shouldPreferAppearance
        || guide.isCoreInVolume
        || guide.relationStageLabels.length > 0
        || participantNames.has(guide.name)
        || conflictCharacterIds.has(guide.characterId)
        || requiredCharacterIds.has(guide.characterId)
      ))
      .map((guide) => rosterById.get(guide.characterId));
    if (selected.some(Boolean) || requiredCharacterIds.size > 0) {
      return { participants: selectWithRequired(selected), isRelevanceBased: true };
    }
  }

  const selected = contextPackage.characterRoster.filter((character) => (
    participantNames.has(character.name)
    || conflictCharacterIds.has(character.id)
    || requiredCharacterIds.has(character.id)
  ));
  if (selected.length > 0 || requiredCharacterIds.size > 0) {
    return { participants: selectWithRequired(selected), isRelevanceBased: true };
  }
  // 盲兜底：roster 前4仅供 participant_subset 展示，不代表本章在场，
  // 调用方不得据此把对应硬事实当作「在场角色硬事实」注入。
  return { participants: contextPackage.characterRoster.slice(0, 4), isRelevanceBased: false };
}
