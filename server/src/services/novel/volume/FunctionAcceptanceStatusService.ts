import type {
  FunctionAcceptanceTable,
} from "@ai-novel/shared/types/functionAcceptance";
import {
  applyFunctionAssignmentsFromChapters,
  getFunctionTableForVolume,
  markFunctionsSatisfied,
  markUnsatisfiedFunctionsMissed,
  normalizeFunctionIds,
  upsertFunctionAcceptanceTable,
} from "@ai-novel/shared/types/functionAcceptance";
import type {
  VolumeChapterPlan,
  VolumePlanDocument,
} from "@ai-novel/shared/types/novel";

/**
 * 功能状态写回骨架（B2 / C3 前置）。
 * 纯函数服务：不碰 DB；由 orchestrator / finalization / 人工 API 调用后写回 workspace。
 */
export class FunctionAcceptanceStatusService {
  applyAssignments(
    document: VolumePlanDocument,
    volumeId: string,
    chapters?: VolumeChapterPlan[],
  ): VolumePlanDocument {
    const table = getFunctionTableForVolume(document.functionAcceptanceTables, volumeId);
    if (!table) {
      return document;
    }
    const volume = document.volumes.find((item) => item.id === volumeId);
    const sourceChapters = chapters
      ?? volume?.chapters
      ?? [];
    const nextTable = applyFunctionAssignmentsFromChapters(
      table,
      sourceChapters.map((chapter) => ({
        chapterOrder: chapter.chapterOrder,
        functionIds: chapter.functionIds,
        mustAvoid: chapter.mustAvoid,
      })),
    );
    return {
      ...document,
      functionAcceptanceTables: upsertFunctionAcceptanceTable(
        document.functionAcceptanceTables,
        nextTable,
      ),
    };
  }

  markSatisfied(
    document: VolumePlanDocument,
    volumeId: string,
    functionIds: string[],
    options: { force?: boolean } = {},
  ): VolumePlanDocument {
    const table = getFunctionTableForVolume(document.functionAcceptanceTables, volumeId);
    if (!table) {
      return document;
    }
    const nextTable = markFunctionsSatisfied(table, functionIds, options);
    return {
      ...document,
      functionAcceptanceTables: upsertFunctionAcceptanceTable(
        document.functionAcceptanceTables,
        nextTable,
      ),
    };
  }

  /**
   * alignment 规则段全部 pass 后调用：仅当 item 的全部 assigned 章都在 passedChapterOrders 内才 satisfied。
   * assigned 空时从 document 章 functionIds 反推挂载序，避免「能检不能标」。
   */
  markSatisfiedFromAlignmentPass(input: {
    document: VolumePlanDocument;
    volumeId: string;
    functionIds: string[];
    passedChapterOrders: number[];
  }): VolumePlanDocument {
    const table = getFunctionTableForVolume(
      input.document.functionAcceptanceTables,
      input.volumeId,
    );
    if (!table) {
      return input.document;
    }
    const volume = input.document.volumes.find((item) => item.id === input.volumeId);
    const derivedOrdersByFunctionId = new Map<string, number[]>();
    for (const chapter of volume?.chapters ?? []) {
      for (const id of normalizeFunctionIds(chapter.functionIds)) {
        const list = derivedOrdersByFunctionId.get(id) ?? [];
        list.push(chapter.chapterOrder);
        derivedOrdersByFunctionId.set(id, list);
      }
    }
    const passed = new Set(
      input.passedChapterOrders.filter((order) => Number.isFinite(order) && order > 0),
    );
    const readyIds = normalizeFunctionIds(input.functionIds).filter((id) => {
      const item = table.items.find((row) => row.id === id);
      if (!item) {
        return false;
      }
      if (item.status === "satisfied" || item.status === "missed") {
        return false;
      }
      const stored = item.assignedChapterOrders ?? [];
      const derived = derivedOrdersByFunctionId.get(id) ?? [];
      // 优先 stored；空则用章挂载反推；仍空则无法安全 satisfied
      const assigned = (stored.length > 0 ? stored : derived)
        .filter((order) => Number.isFinite(order) && order > 0);
      const uniqueAssigned = Array.from(new Set(assigned)).sort((a, b) => a - b);
      if (uniqueAssigned.length === 0) {
        return false;
      }
      return uniqueAssigned.every((order) => passed.has(order));
    });
    if (readyIds.length === 0) {
      return input.document;
    }
    return this.markSatisfied(input.document, input.volumeId, readyIds);
  }

  markMissedAtVolumeEnd(
    document: VolumePlanDocument,
    volumeId: string,
  ): VolumePlanDocument {
    const table = getFunctionTableForVolume(document.functionAcceptanceTables, volumeId);
    if (!table) {
      return document;
    }
    const nextTable = markUnsatisfiedFunctionsMissed(table);
    return {
      ...document,
      functionAcceptanceTables: upsertFunctionAcceptanceTable(
        document.functionAcceptanceTables,
        nextTable,
      ),
    };
  }

  upsertTable(
    document: VolumePlanDocument,
    table: FunctionAcceptanceTable,
  ): VolumePlanDocument {
    return {
      ...document,
      functionAcceptanceTables: upsertFunctionAcceptanceTable(
        document.functionAcceptanceTables,
        table,
      ),
    };
  }
}

export const functionAcceptanceStatusService = new FunctionAcceptanceStatusService();
