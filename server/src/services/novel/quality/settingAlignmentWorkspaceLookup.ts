import type { FunctionAcceptanceTable } from "@ai-novel/shared/types/functionAcceptance";
import {
  getFunctionTableForVolume,
  normalizeFunctionIds,
} from "@ai-novel/shared/types/functionAcceptance";
import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import { settingAlignmentToQualityLoopSignal } from "@ai-novel/shared/types/settingAlignment";
import type { SettingAlignmentAssessment } from "@ai-novel/shared/types/settingAlignment";

/**
 * 按章序 / 章 id / 执行窗反查 volumeId，禁止无脑 volumes[0]。
 * 优先级：精确章 → 窗内任一章 → 含 startOrder 的卷 → 首个有章的卷 → null
 */
export function resolveVolumeIdForChapterScope(input: {
  document: VolumePlanDocument | null | undefined;
  chapterOrder?: number | null;
  chapterId?: string | null;
  startOrder?: number | null;
  endOrder?: number | null;
}): string | null {
  const document = input.document;
  if (!document?.volumes?.length) {
    return null;
  }

  if (input.chapterId || (typeof input.chapterOrder === "number" && input.chapterOrder > 0)) {
    for (const volume of document.volumes) {
      const hit = volume.chapters.some((chapter) => {
        if (input.chapterId && chapter.chapterId === input.chapterId) {
          return true;
        }
        return typeof input.chapterOrder === "number"
          && chapter.chapterOrder === input.chapterOrder;
      });
      if (hit) {
        return volume.id;
      }
    }
  }

  const start = typeof input.startOrder === "number" && input.startOrder > 0
    ? input.startOrder
    : null;
  const end = typeof input.endOrder === "number" && input.endOrder > 0
    ? input.endOrder
    : start;
  if (start != null && end != null) {
    for (const volume of document.volumes) {
      const hit = volume.chapters.some((chapter) => (
        chapter.chapterOrder >= start && chapter.chapterOrder <= end
      ));
      if (hit) {
        return volume.id;
      }
    }
  }

  const firstWithChapters = document.volumes.find((volume) => volume.chapters.length > 0);
  return firstWithChapters?.id ?? document.volumes[0]?.id ?? null;
}

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

  // 章不在工作区：用 scope 解析卷，仍返回该卷表（functionIds 空）
  const fallbackVolumeId = resolveVolumeIdForChapterScope({
    document,
    chapterOrder: input.chapterOrder,
    chapterId: input.chapterId,
  });
  if (!fallbackVolumeId) {
    return empty;
  }
  return {
    volumeId: fallbackVolumeId,
    functionIds: [],
    functionTable: getFunctionTableForVolume(document.functionAcceptanceTables, fallbackVolumeId),
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
