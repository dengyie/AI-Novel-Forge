/**
 * 章节存在两套并行字段：`generationState`（流水线语义）与 `chapterStatus`（运营/编辑器语义）。
 * 本模块集中表达「在同一写路径下宜同时提交的成对取值」，避免出现「已通过审校但未标完成」之类漂移。
 */

export type PipelineGenerationState = "planned" | "drafted" | "reviewed" | "repaired" | "approved" | "published";

export type OperationalChapterStatus =
  | "unplanned"
  | "pending_generation"
  | "generating"
  | "pending_review"
  | "needs_repair"
  | "completed";

export interface ChapterStatePairPatch {
  generationState?: PipelineGenerationState;
  chapterStatus?: OperationalChapterStatus;
}

/**
 * 人工/API 审校写路径：文学门 ∧ 文风门皆过才 `completed`，否则 `needs_repair`。
 * generationState 统一为 `reviewed`（人工审校语义，与 pipeline `approved` 区分）。
 *
 * 调用方必须显式传入 `styleClear`（不得默认 true）；见 {@link chapterStatePairAfterQualityGates}。
 */
export function chapterStatePairAfterManualQualityReview(input: {
  literaryPass: boolean;
  styleClear: boolean;
}): ChapterStatePairPatch {
  return {
    generationState: "reviewed",
    chapterStatus: input.literaryPass && input.styleClear ? "completed" : "needs_repair",
  };
}

/**
 * 流水线在文学 isPass 达标后将章节标为已通过时的推荐成对取值。
 * 调用方必须先用 isPass / isLiteraryQualityPass 门禁；本 helper 本身不二次验分。
 */
export function chapterStatePairAfterPipelineApproval(): ChapterStatePairPatch {
  return {
    generationState: "approved",
    chapterStatus: "completed",
  };
}

/**
 * @deprecated 兼容/测试入口：内部固定 `styleClear: true`，**不能**单独用于生产写路径。
 * 生产 review / repair / pipeline 必须用 {@link chapterStatePairAfterQualityGates}
 * 并传入真实 `styleClear`（omit ≠ true，fail-closed）。
 *
 * 行为：等价于 `chapterStatePairAfterQualityGates({ literaryPass, styleClear: true })`。
 */
export function chapterStatePairAfterLiteraryQualityGate(literaryPass: boolean): ChapterStatePairPatch {
  return chapterStatePairAfterQualityGates({ literaryPass, styleClear: true });
}

/**
 * 双门质量过审：literaryPass ∧ styleClear 才允许 completed。
 * - 任一门 false → reviewed + needs_repair
 * - 两门皆 true → approved + completed
 */
export function chapterStatePairAfterQualityGates(input: {
  literaryPass: boolean;
  styleClear: boolean;
}): ChapterStatePairPatch {
  return input.literaryPass && input.styleClear
    ? chapterStatePairAfterPipelineApproval()
    : {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    };
}

/**
 * 草稿/修复稿落库（正文写入中）：generation 前进，运营态保持 generating。
 */
export function chapterStatePairAfterDraftSave(
  generationState: "drafted" | "repaired",
): ChapterStatePairPatch {
  return {
    generationState,
    chapterStatus: "generating",
  };
}

/**
 * 大纲/目录新建或下游重置回规划：成对 planned + unplanned。
 */
export function chapterStatePairAfterPlannedReset(): ChapterStatePairPatch {
  return {
    generationState: "planned",
    chapterStatus: "unplanned",
  };
}

/**
 * 将 `generationState` 升为 `approved` 时，顺带保证 `chapterStatus` 与用户可见「已完成」一致。
 *
 * **A6 + styleClear（fail-closed）**：仅当调用方**显式证明**文学门与文风门均过时才允许 `completed`。
 * - `literaryPass === true` 且 `styleClear === true` → approved + completed
 * - `literaryPass === true` 且 `styleClear` 省略或 false → reviewed + needs_repair（禁止 omit→true）
 * - `literaryPass === false` → reviewed + needs_repair
 * - `literaryPass` 省略 → **不**自动 completed（只 bump generationState）
 */
export function mergeChapterPatchForGenerationStateBump(
  current: ChapterStatePairPatch | undefined,
  nextGenerationState: PipelineGenerationState,
  options?: { literaryPass?: boolean; styleClear?: boolean },
): ChapterStatePairPatch {
  const base: ChapterStatePairPatch = { ...(current ?? {}) };

  if (nextGenerationState === "approved") {
    if (options?.literaryPass === true) {
      // fail-closed：必须显式 styleClear === true；省略与 false 同等拦 completed
      const styleClear = options.styleClear === true;
      return {
        ...base,
        ...chapterStatePairAfterQualityGates({ literaryPass: true, styleClear }),
      };
    }
    if (options?.literaryPass === false) {
      return {
        ...base,
        ...chapterStatePairAfterQualityGates({ literaryPass: false, styleClear: false }),
      };
    }
    // 未证明 literaryPass：只记 generation，不写 completed（防 A6 旁路）
    base.generationState = "approved";
    return base;
  }

  base.generationState = nextGenerationState;
  return base;
}
