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
 * 审校结束时与 `novelCoreReviewService` 对齐：已通过则收尾为完成，否则待修复。
 * `pass` 必须来自文学 isPass（shared 80/75/75）；!pass 不得 completed（A6）。
 */
export function chapterStatePairAfterManualQualityReview(pass: boolean): ChapterStatePairPatch {
  return {
    generationState: "reviewed",
    chapterStatus: pass ? "completed" : "needs_repair",
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
 * 质量过审门：仅 literaryPass=true 时允许 completed 成对状态；否则 needs_repair。
 * 供 review / repair 写路径与验收测共用，避免 !literaryPass 被标 completed。
 *
 * 兼容入口：等价于 `chapterStatePairAfterQualityGates({ literaryPass, styleClear: true })`。
 * 需要同时拦文风门时请用 {@link chapterStatePairAfterQualityGates}。
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
 * **A6 + styleClear**：仅当调用方证明文学门与文风门均过时才允许 `completed`。
 * - `literaryPass === true` 且 `styleClear !== false` → approved + completed
 *   （`styleClear` 省略视为 true，兼容旧调用方；关键路径应显式传入）
 * - `literaryPass === false` 或 `styleClear === false` → reviewed + needs_repair
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
      // styleClear 显式 false 时拒绝 completed；省略则兼容旧路径视为 true
      const styleClear = options.styleClear !== false;
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
