const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPadReviewIssuesFromContent,
  mergeReviewIssuesPreferPad,
} = require("../dist/services/novel/volume/volumeReadinessPadIssues.js");
const {
  countIncompleteAttemptsForChapter,
} = require("../dist/services/novel/volume/VolumeReadinessExecutor.js");

test("buildPadReviewIssuesFromContent emits prose_pad_phrase issues when pad hits", () => {
  // 默认词表含「就在这时」
  const content = "就在这时，他抬起头。就在这时，风停了。就在这时，门开了。就在这时，雨落了。".repeat(3);
  const issues = buildPadReviewIssuesFromContent(content);
  assert.ok(issues.length > 0, "expected pad issues");
  assert.ok(issues.every((issue) => issue.code === "prose_pad_phrase"));
  assert.ok(issues.every((issue) => issue.category === "repetition"));
  assert.ok(issues[0].evidence.length > 0);
  assert.ok(issues[0].fixSuggestion.length > 0);
});

test("buildPadReviewIssuesFromContent empty / no pad → []", () => {
  assert.deepEqual(buildPadReviewIssuesFromContent(""), []);
  assert.deepEqual(buildPadReviewIssuesFromContent("他走进房间，把门关上。窗外有风。"), []);
});

test("mergeReviewIssuesPreferPad puts pad first and dedupes", () => {
  const pad = [{
    code: "prose_pad_phrase",
    severity: "medium",
    category: "repetition",
    evidence: "pad",
    fixSuggestion: "fix pad",
  }];
  const existing = [
    {
      code: "prose_pad_phrase",
      severity: "medium",
      category: "repetition",
      evidence: "pad",
      fixSuggestion: "fix pad",
    },
    {
      severity: "high",
      category: "coherence",
      evidence: "other",
      fixSuggestion: "fix other",
    },
  ];
  const merged = mergeReviewIssuesPreferPad(pad, existing);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].code, "prose_pad_phrase");
  assert.equal(merged[1].evidence, "other");
});

test("countIncompleteAttemptsForChapter uses attemptCount on last incomplete", () => {
  assert.equal(countIncompleteAttemptsForChapter([], "c1"), 0);
  assert.equal(countIncompleteAttemptsForChapter([
    { chapterId: "c1", outcome: "repair_incomplete", attemptCount: 2 },
  ], "c1"), 2);
  assert.equal(countIncompleteAttemptsForChapter([
    { chapterId: "c1", outcome: "re_review_incomplete" }, // no attemptCount → 1
  ], "c1"), 1);
  assert.equal(countIncompleteAttemptsForChapter([
    { chapterId: "c1", outcome: "repair_adopted" },
  ], "c1"), 0);
  assert.equal(countIncompleteAttemptsForChapter([
    { chapterId: "other", outcome: "repair_incomplete", attemptCount: 9 },
    { chapterId: "c1", outcome: "polish_incomplete", attemptCount: 1 },
  ], "c1"), 1);
});
