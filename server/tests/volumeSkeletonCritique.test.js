const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldRegenerateSkeleton,
  formatSkeletonCritiqueFeedback,
} = require("../dist/services/novel/volume/volumeGenerationHelpers.js");

test("shouldRegenerateSkeleton returns false for null report", () => {
  assert.equal(shouldRegenerateSkeleton(null), false);
});

test("shouldRegenerateSkeleton returns false when overallRisk=low and no high issues", () => {
  assert.equal(shouldRegenerateSkeleton({
    overallRisk: "low",
    summary: "全部 focused-local",
    issues: [],
    recommendedActions: [],
  }), false);
});

test("shouldRegenerateSkeleton returns true when overallRisk=high", () => {
  assert.equal(shouldRegenerateSkeleton({
    overallRisk: "high",
    summary: "存在抽象群体对手面",
    issues: [],
    recommendedActions: [],
  }), true);
});

test("shouldRegenerateSkeleton returns true when any issue has high severity (even if overallRisk=medium)", () => {
  assert.equal(shouldRegenerateSkeleton({
    overallRisk: "medium",
    summary: "边缘",
    issues: [
      { targetRef: "volumes[0].primaryPressureSource", severity: "high", title: "高", detail: "V1 失焦" },
      { targetRef: "volumes[2].summary", severity: "medium", title: "中", detail: "边缘" },
    ],
    recommendedActions: [],
  }), true);
});

test("shouldRegenerateSkeleton returns false for only low/medium issues with overallRisk=medium", () => {
  assert.equal(shouldRegenerateSkeleton({
    overallRisk: "medium",
    summary: "边缘",
    issues: [
      { targetRef: "volumes[2].summary", severity: "medium", title: "中", detail: "边缘" },
      { targetRef: "volumes[3].midVolumeRisk", severity: "low", title: "低", detail: "轻微" },
    ],
    recommendedActions: [],
  }), false);
});

test("formatSkeletonCritiqueFeedback returns empty string for null report", () => {
  assert.equal(formatSkeletonCritiqueFeedback(null), "");
});

test("formatSkeletonCritiqueFeedback includes summary, overallRisk, high/medium issue details, and recommendedActions", () => {
  const feedback = formatSkeletonCritiqueFeedback({
    overallRisk: "high",
    summary: "存在抽象群体对手面，需聚焦具名对手。",
    issues: [
      { targetRef: "volumes[0].primaryPressureSource", severity: "high", title: "对手面抽象", detail: "V1 写成全班针对主角" },
      { targetRef: "volumes[2].summary", severity: "medium", title: "压迫笼统", detail: "中段<cv>summary 仍偏抽象" },
      { targetRef: "volumes[3].midVolumeRisk", severity: "low", title: "轻微", detail: "略偏" },
    ],
    recommendedActions: [
      "把 V1 primaryPressureSource 具名到 1-3 个主动对手",
      "在每卷明确绝大多数人中立旁观",
    ],
  });
  assert.match(feedback, /存在抽象群体对手面/);
  assert.match(feedback, /overallRisk=high/);
  assert.match(feedback, /\[high\] volumes\[0\].primaryPressureSource/);
  assert.match(feedback, /\[medium\] volumes\[2\].summary/);
  // low severity issues should NOT be listed (only high + medium)
  assert.equal(feedback.includes("[low]"), false);
  assert.match(feedback, /把 V1 primaryPressureSource 具名到 1-3 个主动对手/);
});

test("formatSkeletonCritiqueFeedback does NOT inject「称重」or mechanical-measurement literal as a positive example", () => {
  const feedback = formatSkeletonCritiqueFeedback({
    overallRisk: "high",
    summary: "出现机械度量压迫 framing。",
    issues: [
      { targetRef: "volumes[1].summary", severity: "high", title: "骨架用了机械度量", detail: "把人当物过秤" },
    ],
    recommendedActions: [
      "把压迫落到具名对手的动作与可观察代价",
    ],
  });
  // The helper must not itself print the banned-term literal「称重」forward as正向示例
  assert.equal(feedback.includes("称重"), false, "feedback must not print「称重」as a literal positive example");
});
