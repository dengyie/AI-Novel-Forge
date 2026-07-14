import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { SettingQualityMode } from "@ai-novel/shared/types/settingQualityPolicy";
import { isSettingQualityActive, resolveSettingQualityPolicy } from "@ai-novel/shared/types/settingQualityPolicy";
import type { SettingAlignmentAssessment } from "@ai-novel/shared/types/settingAlignment";
import type { FunctionAcceptanceTable } from "@ai-novel/shared/types/functionAcceptance";
import { getFunctionTableForVolume, normalizeFunctionIds } from "@ai-novel/shared/types/functionAcceptance";
import { chapterSettingAlignmentService } from "./ChapterSettingAlignmentService";

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
   */
  functionIds?: string[] | null;
  functionTable?: FunctionAcceptanceTable | null;
  functionAcceptanceTables?: FunctionAcceptanceTable[] | null;
  volumeId?: string | null;
  mustAvoid?: string | null;
  exclusiveEvent?: string | null;
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

  const functionTable = input.functionTable
    ?? (
      input.volumeId
        ? getFunctionTableForVolume(input.functionAcceptanceTables, input.volumeId)
        : (input.functionAcceptanceTables?.length === 1
          ? input.functionAcceptanceTables[0] ?? null
          : null)
    );

  return chapterSettingAlignmentService.assess({
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder,
    content: input.content,
    mode,
    functionIds: normalizeFunctionIds(input.functionIds),
    functionTable,
    functionAcceptanceTables: input.functionAcceptanceTables,
    volumeId: input.volumeId,
    mustAvoid: input.mustAvoid,
    exclusiveEvent: input.exclusiveEvent,
    contextPackage: input.contextPackage,
  });
}
