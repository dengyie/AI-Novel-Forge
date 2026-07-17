const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chapterStatePairAfterManualQualityReview,
  chapterStatePairAfterPipelineApproval,
  chapterStatePairAfterLiteraryQualityGate,
  chapterStatePairAfterDraftSave,
  chapterStatePairAfterPlannedReset,
  mergeChapterPatchForGenerationStateBump,
} = require("../dist/services/novel/chapterLifecycleState.js");

test("chapterStatePairAfterManualQualityReview matches pass / fail semantics", () => {
  assert.deepEqual(chapterStatePairAfterManualQualityReview(true), {
    generationState: "reviewed",
    chapterStatus: "completed",
  });
  assert.deepEqual(chapterStatePairAfterManualQualityReview(false), {
    generationState: "reviewed",
    chapterStatus: "needs_repair",
  });
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

test("mergeChapterPatchForGenerationStateBump only completes when literaryPass proven (A6)", () => {
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
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", { literaryPass: true }),
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
  // styleClear 省略仍兼容旧路径视为 true
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({}, "approved", { literaryPass: true }),
    {
      generationState: "approved",
      chapterStatus: "completed",
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
