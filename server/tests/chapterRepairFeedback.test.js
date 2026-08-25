const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRepairIssuesPayload,
  getRepairModeHint,
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

test("getRepairModeHint: length_expansion returns exclusive extend_for_length hint", () => {
  // 死代码修复后可达分支：wantLengthExpansion 时 issueCodes 必带 LENGTH_UNDER_SOFT_MIN，
  // mode=length_expansion 走扩写专属提示（非通用 extend_for_length）。
  const hint = getRepairModeHint("length_expansion", ["LENGTH_UNDER_SOFT_MIN"]);
  assert.match(hint, /extend_for_length/);
  assert.match(hint, /扩写|补足/);
  // 专属提示应区别于「只补结尾」的通用 extend_for_length（后者走上一级 if 的 else）
  const generic = getRepairModeHint("light_repair", ["LENGTH_UNDER_SOFT_MIN"]);
  assert.notEqual(hint, generic);
  assert.match(generic, /extend_for_length/);
});

test("getRepairModeHint: length_expansion without LENGTH_UNDER_SOFT_MIN falls through", () => {
  // 若 issueCodes 缺 LENGTH_UNDER_SOFT_MIN，不应命中扩写专属 if，回到 switch 默认分支。
  const hint = getRepairModeHint("length_expansion", []);
  assert.equal(hint, "以轻修为主，优先保持原有内容框架和事件顺序。");
});
