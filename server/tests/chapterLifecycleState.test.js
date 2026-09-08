const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chapterStatePairAfterManualQualityReview,
  chapterStatePairAfterPipelineApproval,
  chapterStatePairAfterLiteraryQualityGate,
  chapterStatePairAfterDraftSave,
  chapterStatePairAfterPlannedReset,
  mergeChapterPatchForGenerationStateBump,
  chapterStatePairAfterQualityGates,
} = require("../dist/services/novel/chapterLifecycleState.js");

test("chapterStatePairAfterManualQualityReview requires dual-gate", () => {
  assert.deepEqual(
    chapterStatePairAfterManualQualityReview({ literaryPass: true, styleClear: true }),
    {
      generationState: "reviewed",
      chapterStatus: "completed",
    },
  );
  assert.deepEqual(
    chapterStatePairAfterManualQualityReview({ literaryPass: true, styleClear: false }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
  assert.deepEqual(
    chapterStatePairAfterManualQualityReview({ literaryPass: false, styleClear: true }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
  assert.deepEqual(
    chapterStatePairAfterManualQualityReview({ literaryPass: false, styleClear: false }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
});

test("chapterStatePairAfterPipelineApproval aligns approved with completed", () => {
  assert.deepEqual(chapterStatePairAfterPipelineApproval(), {
    generationState: "approved",
    chapterStatus: "completed",
  });
});

test("chapterStatePairAfterLiteraryQualityGate blocks completed when !literaryPass (A6)", () => {
  assert.deepEqual(chapterStatePairAfterLiteraryQualityGate(true), {
    generationState: "approved",
    chapterStatus: "completed",
  });
  assert.deepEqual(chapterStatePairAfterLiteraryQualityGate(false), {
    generationState: "reviewed",
    chapterStatus: "needs_repair",
  });
});

test("chapterStatePairAfterDraftSave keeps generating operational status", () => {
  assert.deepEqual(chapterStatePairAfterDraftSave("drafted"), {
    generationState: "drafted",
    chapterStatus: "generating",
  });
  assert.deepEqual(chapterStatePairAfterDraftSave("repaired"), {
    generationState: "repaired",
    chapterStatus: "generating",
  });
});

test("chapterStatePairAfterPlannedReset pairs planned with unplanned", () => {
  assert.deepEqual(chapterStatePairAfterPlannedReset(), {
    generationState: "planned",
    chapterStatus: "unplanned",
  });
});

test("mergeChapterPatchForGenerationStateBump only completes when dual-gate proven (fail-closed)", () => {
  assert.deepEqual(mergeChapterPatchForGenerationStateBump({}, "reviewed"), {
    generationState: "reviewed",
  });
  // 未证明 literaryPass：不得假 completed
  assert.deepEqual(mergeChapterPatchForGenerationStateBump({}, "approved"), {
    generationState: "approved",
  });
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({ chapterStatus: "pending_review" }, "approved"),
    {
      generationState: "approved",
      chapterStatus: "pending_review",
    },
  );
  // literaryPass true 但 styleClear 省略 → fail-closed needs_repair
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", { literaryPass: true }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", {
      literaryPass: true,
      styleClear: true,
    }),
    {
      generationState: "approved",
      chapterStatus: "completed",
    },
  );
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", { literaryPass: false }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
});

test("mergeChapterPatchForGenerationStateBump dual-gate: styleClear false blocks completed", () => {
  // literaryPass ∧ styleClear 才 completed；styleClear 显式 false → needs_repair
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", {
      literaryPass: true,
      styleClear: true,
    }),
    {
      generationState: "approved",
      chapterStatus: "completed",
    },
  );
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", {
      literaryPass: true,
      styleClear: false,
    }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
  // styleClear 省略不再兼容旧路径视为 true（fail-closed）
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", { literaryPass: true }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
  // 省略 literaryPass：无论 styleClear 如何都不假 completed
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", { styleClear: true }),
    {
      generationState: "approved",
    },
  );
});

test("chapterStatePairAfterQualityGates dual-gate matrix", () => {
  assert.deepEqual(chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: true }), {
    generationState: "approved",
    chapterStatus: "completed",
  });
  assert.deepEqual(chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: false }), {
    generationState: "reviewed",
    chapterStatus: "needs_repair",
  });
  assert.deepEqual(chapterStatePairAfterQualityGates({ literaryPass: false, styleClear: true }), {
    generationState: "reviewed",
    chapterStatus: "needs_repair",
  });
});

test("chapterStatePairAfterQualityGates lengthPass: 三门缺一即 needs_repair", () => {
  // 文学 ∧ 文风都过，但 lengthPass=false（自动修复出口的强制长度硬门）→ 不得 completed
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: true, lengthPass: false }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
  // literaryPass 或 styleClear 任一 false，即使 lengthPass=true 也需 repair
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: false, lengthPass: true }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: false, styleClear: true, lengthPass: true }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
});

test("chapterStatePairAfterQualityGates lengthPass: 三门皆 up", () => {
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: true, lengthPass: true }),
    {
      generationState: "approved",
      chapterStatus: "completed",
    },
  );
});

test("chapterStatePairAfterQualityGates lengthPass 省略 → 向后兼容 equivalent to true", () => {
  // 未显式传 lengthPass 的既有调用方（含流水线生成路径）行为与 lengthPass: true 一致
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: true }),
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: true, lengthPass: true }),
  );
  assert.deepEqual(
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: false }),
    chapterStatePairAfterQualityGates({ literaryPass: true, styleClear: false, lengthPass: true }),
  );
});
