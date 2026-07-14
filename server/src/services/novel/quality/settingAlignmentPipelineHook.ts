import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { SettingQualityMode } from "@ai-novel/shared/types/settingQualityPolicy";
import { isSettingQualityActive, resolveSettingQualityPolicy } from "@ai-novel/shared/types/settingQualityPolicy";
import type { SettingAlignmentAssessment } from "@ai-novel/shared/types/settingAlignment";
import type { FunctionAcceptanceTable } from "@ai-novel/shared/types/functionAcceptance";
import { getFunctionTableForVolume, normalizeFunctionIds } from "@ai-novel/shared/types/functionAcceptance";
import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";
import { chapterSettingAlignmentService } from "./ChapterSettingAlignmentService";
import { resolveSettingAlignmentFunctionContext } from "./settingAlignmentWorkspaceLookup";

export type SettingAlignmentPipelineContext = {
  novelId: string;
  chapterId: string;
  chapterOrder: number;
  content: string;
  mode?: SettingQualityMode | null;
  contextPackage?: GenerationContextPackage | null;
  /**
   * 可选：卷工作区已加载的功能表与章 functionIds。
   * 缺省时 hook 内不访问 DB（保持纯/可测）；调用方按需注入。
   * 也可传 volumeDocument，由 hook 解析 functionIds/table。
   */
  functionIds?: string[] | null;
  functionTable?: FunctionAcceptanceTable | null;
  functionAcceptanceTables?: FunctionAcceptanceTable[] | null;
  volumeId?: string | null;
  volumeDocument?: VolumePlanDocument | null;
  mustAvoid?: string | null;
  exclusiveEvent?: string | null;
  hardForbiddenTerms?: string[] | null;
  includeHighConfidenceInventedTerms?: boolean;
};

/**
 * Pipeline / finalization 共用：mode=off 或解析失败 → null（不注入 qualityLoop）。
 * 抛错由调用方 catch；本函数自身不 throw 业务阻断。
 */
export function assessSettingAlignmentForQualityLoop(
  input: SettingAlignmentPipelineContext,
): SettingAlignmentAssessment | null {
  const mode = resolveSettingQualityPolicy({ mode: input.mode ?? "off" }).mode;
  if (!isSettingQualityActive({ mode, canonicalSliceLock: false })) {
    return null;
  }

  const fromWorkspace = resolveSettingAlignmentFunctionContext({
    document: input.volumeDocument,
    chapterOrder: input.chapterOrder,
    chapterId: input.chapterId,
  });

  const functionIds = normalizeFunctionIds(
    input.functionIds && input.functionIds.length > 0
      ? input.functionIds
      : fromWorkspace.functionIds,
  );
  const volumeId = input.volumeId ?? fromWorkspace.volumeId;
  const functionTable = input.functionTable
    ?? fromWorkspace.functionTable
    ?? (
      volumeId
        ? getFunctionTableForVolume(input.functionAcceptanceTables, volumeId)
        : (input.functionAcceptanceTables?.length === 1
          ? input.functionAcceptanceTables[0] ?? null
          : null)
    );

  return chapterSettingAlignmentService.assess({
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder,
    content: input.content,
    mode,
    functionIds,
    functionTable,
    functionAcceptanceTables: input.functionAcceptanceTables
      ?? input.volumeDocument?.functionAcceptanceTables
      ?? null,
    volumeId,
    mustAvoid: input.mustAvoid ?? fromWorkspace.mustAvoid,
    exclusiveEvent: input.exclusiveEvent ?? fromWorkspace.exclusiveEvent,
    hardForbiddenTerms: input.hardForbiddenTerms,
    includeHighConfidenceInventedTerms: input.includeHighConfidenceInventedTerms === true,
    contextPackage: input.contextPackage,
  });
}
