const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRepairIssuesPayload,
} = require("../dist/services/novel/runtime/repair/chapterRepairRuntime.js");

test("repair issues payload carries the latest current-chapter quality feedback", () => {
  const payload = JSON.parse(buildRepairIssuesPayload(
    [{
      severity: "high",
      category: "coherence",
      evidence: "后半段连续性断裂",
      fixSuggestion: "修复事件承接",
    }],
    null,
    ["LENGTH_UNDER_SOFT_MIN"],
    [{
      version: 1,
      chapterOrder: 6,
      chapterId: "chapter-6",
      signature: "qfb:latest",
      severity: "soft",
      rootCause: "length_drift",
      codes: ["pacing:high", "length_under_soft"],
      evidence: ["正文低于合同区间"],
      mustFix: ["补关键节拍，不要机械凑字"],
      planHints: ["补必要在场与因果"],
      failedPatchCount: 0,
      avoidRetry: false,
      evaluatedAt: "2026-08-17T16:16:46.928Z",
    }],
  ));

  assert.deepEqual(payload.blockingIssueCodes, ["LENGTH_UNDER_SOFT_MIN"]);
  assert.equal(payload.qualityFeedback.length, 1);
  assert.equal(payload.qualityFeedback[0].signature, "qfb:latest");
  assert.deepEqual(payload.qualityFeedback[0].mustFix, ["补关键节拍，不要机械凑字"]);
});

test("repair issues payload omits absent or malformed quality feedback", () => {
  const payload = JSON.parse(buildRepairIssuesPayload([], null, [], null));
  assert.deepEqual(payload, { issues: [] });
});
