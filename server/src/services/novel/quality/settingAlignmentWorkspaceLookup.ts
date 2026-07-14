import type { FunctionAcceptanceTable } from "@ai-novel/shared/types/functionAcceptance";
import {
  getFunctionTableForVolume,
  normalizeFunctionIds,
} from "@ai-novel/shared/types/functionAcceptance";
import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import { settingAlignmentToQualityLoopSignal } from "@ai-novel/shared/types/settingAlignment";
import type { SettingAlignmentAssessment } from "@ai-novel/shared/types/settingAlignment";

/**
 * 从卷工作区按章序解析 functionIds + 功能表（B3 pipeline / finalization 共用）。
 * 纯函数：不访问 DB。
 */
export function resolveSettingAlignmentFunctionContext(input: {
  document: VolumePlanDocument | null | undefined;
  chapterOrder: number;
  chapterId?: string | null;
}): {
  volumeId: string | null;
  functionIds: string[];
  functionTable: FunctionAcceptanceTable | null;
  exclusiveEvent: string | null;
  mustAvoid: string | null;
} {
  const empty = {
    volumeId: null as string | null,
    functionIds: [] as string[],
    functionTable: null as FunctionAcceptanceTable | null,
    exclusiveEvent: null as string | null,
    mustAvoid: null as string | null,
  };
  const document = input.document;
  if (!document?.volumes?.length) {
    return empty;
  }

  for (const volume of document.volumes) {
    const chapter = volume.chapters.find((item) => {
      if (input.chapterId && item.chapterId === input.chapterId) {
        return true;
      }
      return item.chapterOrder === input.chapterOrder;
    });
    if (!chapter) {
      continue;
    }
    const functionTable = getFunctionTableForVolume(
      document.functionAcceptanceTables,
      volume.id,
    );
    return {
      volumeId: volume.id,
      functionIds: normalizeFunctionIds(chapter.functionIds),
      functionTable,
      exclusiveEvent: chapter.exclusiveEvent ?? null,
      mustAvoid: chapter.mustAvoid ?? null,
    };
  }

  // 章不在工作区时仍尽量返回首卷表，便于 hard-forbid 等非 function 检查
  const primary = document.volumes[0];
  if (!primary) {
    return empty;
  }
  return {
    volumeId: primary.id,
    functionIds: [],
    functionTable: getFunctionTableForVolume(document.functionAcceptanceTables, primary.id),
    exclusiveEvent: null,
    mustAvoid: null,
  };
}

/** 设定债务是否应禁止 defer_and_continue（enforce hard/soft；advisory 允许 defer） */
export function shouldSuppressDeferForSettingAlignment(
  assessment: SettingAlignmentAssessment | null | undefined,
): boolean {
  if (!assessment || assessment.mode === "off" || assessment.mode === "advisory") {
    return false;
  }
  const mapped = settingAlignmentToQualityLoopSignal(assessment);
  return mapped.blockingForQualityLoop || mapped.status === "invalid" || mapped.status === "risk";
}
