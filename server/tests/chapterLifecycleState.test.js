const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chapterStatePairAfterManualQualityReview,
  chapterStatePairAfterPipelineApproval,
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

test("mergeChapterPatchForGenerationStateBump only adds completed when approved", () => {
  assert.deepEqual(mergeChapterPatchForGenerationStateBump({}, "reviewed"), {
    generationState: "reviewed",
  });
  assert.deepEqual(mergeChapterPatchForGenerationStateBump({}, "approved"), {
    generationState: "approved",
    chapterStatus: "completed",
  });
  assert.deepEqual(
    mergeChapterPatchForGenerationStateBump({ chapterStatus: "pending_review" }, "approved"),
    {
      generationState: "approved",
      chapterStatus: "completed",
    },
  );
});
