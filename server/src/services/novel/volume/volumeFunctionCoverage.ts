import type {
  FunctionAcceptanceTable,
  FunctionCoverageResult,
} from "@ai-novel/shared/types/functionAcceptance";
import {
  applyFunctionAssignmentsFromChapters,
  assertFunctionTableEnforcible,
  evaluateFunctionCoverageGate,
  formatFunctionCoverageFailure,
  getFunctionTableForVolume,
  mergeMustAvoidWithFunctionBans,
  normalizeFunctionIds,
  upsertFunctionAcceptanceTable,
  validateFunctionCoverage,
} from "@ai-novel/shared/types/functionAcceptance";
import type { SettingQualityMode } from "@ai-novel/shared/types/settingQualityPolicy";
import { resolveSettingQualityPolicy } from "@ai-novel/shared/types/settingQualityPolicy";
import type {
  VolumeChapterPlan,
  VolumePlan,
  VolumePlanDocument,
} from "@ai-novel/shared/types/novel";

export type FunctionCoverageGateSnapshot = {
  mode: SettingQualityMode;
  blocking: boolean;
  issues: string[];
  coverage: FunctionCoverageResult;
  enforcibleOk: boolean;
};

function chaptersAsCoverageRefs(chapters: VolumeChapterPlan[]) {
  return chapters.map((chapter) => ({
    chapterOrder: chapter.chapterOrder,
    functionIds: chapter.functionIds,
    mustAvoid: chapter.mustAvoid,
  }));
}

/**
 * 仅 mode=enforce 时抛错；advisory 返回 issues 不挡。
 * generated 表 enforce → 抛「不可 enforce」。
 */
export function assertFunctionCoverageForVolume(input: {
  table: FunctionAcceptanceTable | null | undefined;
  chapters: VolumeChapterPlan[];
  mode: SettingQualityMode;
  volumeTitle?: string;
}): FunctionCoverageGateSnapshot {
  const result = evaluateFunctionCoverageGate({
    table: input.table,
    chapters: chaptersAsCoverageRefs(input.chapters),
    mode: input.mode,
  });
  const snapshot: FunctionCoverageGateSnapshot = {
    mode: result.mode,
    blocking: result.blocking,
    issues: result.issues,
    coverage: result.coverage,
    enforcibleOk: result.enforcible.canEnforce || result.mode !== "enforce",
  };
  if (result.blocking) {
    const prefix = input.volumeTitle ? `卷「${input.volumeTitle}」` : "当前卷";
    throw new Error(`${prefix}${formatFunctionCoverageFailure(result)}`);
  }
  return snapshot;
}

/**
 * chapter_list 完成后：写回 assigned + 可选合并 mustNotHappen → mustAvoid。
 * mode=off：原样返回 document。
 */
export function applyFunctionTablePostChapterList(input: {
  document: VolumePlanDocument;
  volumeId: string;
  mode: SettingQualityMode;
  mergeMustAvoid?: boolean;
}): {
  document: VolumePlanDocument;
  gate: FunctionCoverageGateSnapshot;
} {
  const mode = resolveSettingQualityPolicy({ mode: input.mode }).mode;
  if (mode === "off") {
    return {
      document: input.document,
      gate: {
        mode: "off",
        blocking: false,
        issues: [],
        coverage: validateFunctionCoverage({ table: null, chapters: [], mode: "off" }),
        enforcibleOk: true,
      },
    };
  }

  const volume = input.document.volumes.find((item) => item.id === input.volumeId);
  if (!volume) {
    throw new Error("目标卷不存在，无法校验功能覆盖。");
  }
  const table = getFunctionTableForVolume(
    input.document.functionAcceptanceTables,
    input.volumeId,
  );

  // 先按当前 functionIds 写回 assigned
  let nextTables = input.document.functionAcceptanceTables ?? [];
  let nextVolumes = input.document.volumes;
  if (table) {
    const assigned = applyFunctionAssignmentsFromChapters(
      table,
      chaptersAsCoverageRefs(volume.chapters),
    );
    nextTables = upsertFunctionAcceptanceTable(nextTables, assigned);

    if (input.mergeMustAvoid !== false) {
      const coverage = validateFunctionCoverage({
        table: assigned,
        chapters: chaptersAsCoverageRefs(volume.chapters),
        mode,
      });
      nextVolumes = input.document.volumes.map((item) => {
        if (item.id !== volume.id) {
          return item;
        }
        return {
          ...item,
          chapters: item.chapters.map((chapter) => {
            const bans = coverage.mustAvoidByChapterOrder[chapter.chapterOrder] ?? [];
            if (bans.length === 0) {
              return chapter;
            }
            return {
              ...chapter,
              mustAvoid: mergeMustAvoidWithFunctionBans(chapter.mustAvoid, bans),
            };
          }),
        };
      });
    }
  }

  const nextDocument: VolumePlanDocument = {
    ...input.document,
    volumes: nextVolumes,
    functionAcceptanceTables: nextTables.length > 0 ? nextTables : undefined,
  };

  const nextTable = getFunctionTableForVolume(nextTables, input.volumeId);
  const gate = assertFunctionCoverageForVolume({
    table: nextTable,
    chapters: nextVolumes.find((item) => item.id === input.volumeId)?.chapters ?? [],
    mode,
    volumeTitle: volume.title,
  });

  return { document: nextDocument, gate };
}

/** sync 前：enforce 且有表时校验所有相关卷 */
export function assertDocumentFunctionCoverageForSync(input: {
  document: VolumePlanDocument;
  mode: SettingQualityMode;
  chapterRange?: { startOrder: number; endOrder: number };
}): void {
  const mode = resolveSettingQualityPolicy({ mode: input.mode }).mode;
  if (mode !== "enforce") {
    return;
  }
  for (const volume of input.document.volumes) {
    const table = getFunctionTableForVolume(
      input.document.functionAcceptanceTables,
      volume.id,
    );
    if (!table || table.items.length === 0) {
      continue;
    }
    // 若 enforce 但表 generated → 直接挡
    const enforcible = assertFunctionTableEnforcible(table);
    if (!enforcible.canEnforce) {
      throw new Error(`卷「${volume.title}」${enforcible.reason}`);
    }
    const chapters = volume.chapters.filter((chapter) => {
      if (!input.chapterRange) {
        return true;
      }
      return chapter.chapterOrder >= input.chapterRange.startOrder
        && chapter.chapterOrder <= input.chapterRange.endOrder;
    });
    // 覆盖按整卷表校验（范围外章仍可承担 functionIds）
    assertFunctionCoverageForVolume({
      table,
      chapters: volume.chapters,
      mode,
      volumeTitle: volume.title,
    });
    void chapters;
  }
}

export function resolveSettingQualityModeFromOptions(
  mode: SettingQualityMode | null | undefined,
): SettingQualityMode {
  return resolveSettingQualityPolicy(mode ? { mode } : null).mode;
}

export function attachFunctionIdsToChapters(
  volume: VolumePlan,
  assignments: Array<{ chapterOrder: number; functionIds: string[] }>,
): VolumePlan {
  const byOrder = new Map(
    assignments.map((item) => [item.chapterOrder, normalizeFunctionIds(item.functionIds)]),
  );
  return {
    ...volume,
    chapters: volume.chapters.map((chapter) => {
      const ids = byOrder.get(chapter.chapterOrder);
      if (!ids) {
        return chapter;
      }
      return {
        ...chapter,
        functionIds: ids,
      };
    }),
  };
}
