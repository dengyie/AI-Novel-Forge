import type { FunctionAcceptanceItem, FunctionAcceptanceTable } from "@ai-novel/shared/types/functionAcceptance";
import {
  getFunctionTableForVolume,
  normalizeFunctionIds,
} from "@ai-novel/shared/types/functionAcceptance";
import type { SettingQualityMode } from "@ai-novel/shared/types/settingQualityPolicy";
import { resolveSettingQualityPolicy } from "@ai-novel/shared/types/settingQualityPolicy";
import {
  evaluateSettingAlignmentRules,
  type SettingAlignmentAssessment,
  type SettingAlignmentCheck,
} from "@ai-novel/shared/types/settingAlignment";
import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import { HIGH_CONFIDENCE_INVENTED_TERMS } from "../storyWorldSlice/storyWorldSliceCanonicalGuard";

export type ChapterSettingAlignmentAssessInput = {
  chapterId: string;
  chapterOrder?: number | null;
  content: string;
  mode?: SettingQualityMode | null;
  /** 若给 raw policy 对象则 resolve；优先 mode 字段 */
  settingQualityPolicy?: unknown;
  functionIds?: string[] | null;
  functionItems?: FunctionAcceptanceItem[] | null;
  functionTable?: FunctionAcceptanceTable | null;
  functionAcceptanceTables?: FunctionAcceptanceTable[] | null;
  volumeId?: string | null;
  mustAvoid?: string | null;
  exclusiveEvent?: string | null;
  requiredCharacterAppearances?: string[] | null;
  forbiddenCrossings?: string[] | null;
  hardForbiddenTerms?: string[] | null;
  contextPackage?: GenerationContextPackage | null;
  /**
   * 可选 LLM 段。本 milestone 默认不调用；超时/失败由调用方传入 llmTimedOut。
   * 不得以 LLM 失败默认 blocking。
   */
  llmChecks?: SettingAlignmentCheck[] | null;
  llmUsed?: boolean;
  llmTimedOut?: boolean;
  llmError?: string | null;
  evaluatedAt?: string | Date;
};

/**
 * 章设定对齐服务（B3）。
 * 纯规则段默认；LLM 段 opt-in 且失败不默认 blocking。
 */
export class ChapterSettingAlignmentService {
  assess(input: ChapterSettingAlignmentAssessInput): SettingAlignmentAssessment {
    const mode = this.resolveMode(input);
    const fromContext = this.extractFromContext(input.contextPackage);
    const functionTable = this.resolveFunctionTable(input);
    const functionIds = normalizeFunctionIds(
      input.functionIds
      ?? fromContext.functionIds
      ?? [],
    );

    return evaluateSettingAlignmentRules({
      chapterId: input.chapterId,
      chapterOrder: input.chapterOrder ?? fromContext.chapterOrder,
      content: input.content ?? "",
      mode,
      functionIds,
      functionItems: input.functionItems,
      functionTable,
      mustAvoid: input.mustAvoid ?? fromContext.mustAvoid,
      exclusiveEvent: input.exclusiveEvent ?? fromContext.exclusiveEvent,
      requiredCharacterAppearances:
        input.requiredCharacterAppearances
        ?? fromContext.requiredCharacterAppearances,
      forbiddenCrossings:
        input.forbiddenCrossings
        ?? fromContext.forbiddenCrossings,
      hardForbiddenTerms: uniqueTerms([
        ...(input.hardForbiddenTerms ?? []),
        ...HIGH_CONFIDENCE_INVENTED_TERMS,
      ]),
      llmChecks: input.llmChecks,
      llmUsed: input.llmUsed,
      llmTimedOut: input.llmTimedOut,
      llmError: input.llmError,
      evaluatedAt: input.evaluatedAt,
    });
  }

  private resolveMode(input: ChapterSettingAlignmentAssessInput): SettingQualityMode {
    if (input.mode) {
      return input.mode;
    }
    if (input.settingQualityPolicy != null) {
      return resolveSettingQualityPolicy(input.settingQualityPolicy).mode;
    }
    return "off";
  }

  private resolveFunctionTable(
    input: ChapterSettingAlignmentAssessInput,
  ): FunctionAcceptanceTable | null {
    if (input.functionTable) {
      return input.functionTable;
    }
    if (input.functionAcceptanceTables && input.volumeId) {
      return getFunctionTableForVolume(input.functionAcceptanceTables, input.volumeId);
    }
    if (input.functionAcceptanceTables?.length === 1) {
      return input.functionAcceptanceTables[0] ?? null;
    }
    return null;
  }

  private extractFromContext(contextPackage: GenerationContextPackage | null | undefined): {
    chapterOrder: number | null;
    mustAvoid: string | null;
    exclusiveEvent: string | null;
    requiredCharacterAppearances: string[];
    forbiddenCrossings: string[];
    functionIds: string[];
  } {
    if (!contextPackage) {
      return {
        chapterOrder: null,
        mustAvoid: null,
        exclusiveEvent: null,
        requiredCharacterAppearances: [],
        forbiddenCrossings: [],
        functionIds: [],
      };
    }
    const chapter = contextPackage.chapter;
    const writeCtx = contextPackage.chapterWriteContext;
    const obligation = writeCtx?.obligationContract;
    const boundary = writeCtx?.chapterBoundary;
    return {
      chapterOrder: typeof chapter?.order === "number" ? chapter.order : null,
      mustAvoid: typeof chapter?.mustAvoid === "string" ? chapter.mustAvoid : null,
      exclusiveEvent: boundary?.exclusiveEvent
        ?? (typeof (writeCtx as { exclusiveEvent?: string } | null | undefined)?.exclusiveEvent === "string"
          ? (writeCtx as { exclusiveEvent?: string }).exclusiveEvent ?? null
          : null),
      requiredCharacterAppearances: obligation?.requiredCharacterAppearances ?? [],
      forbiddenCrossings: [
        ...(obligation?.forbiddenCrossings ?? []),
        ...(boundary?.doNotCross ?? []),
      ],
      // functionIds 尚未进 runtime chapter schema；由调用方显式传入
      functionIds: [],
    };
  }
}

function uniqueTerms(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

export const chapterSettingAlignmentService = new ChapterSettingAlignmentService();
