const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PostGenerationStyleReviewRunner,
} = require("../dist/services/novel/runtime/PostGenerationStyleReviewRunner.js");

// 构造一个带 compiledBlocks 的最小 contextPackage，让 runner 通过前置守卫。
function contextPackageWithStyle() {
  return {
    styleContext: {
      compiledBlocks: { contract: {} },
    },
  };
}

function baseInput(overrides = {}) {
  return {
    novelId: "novel-1",
    chapterId: "chapter-1",
    request: { taskStyleProfileId: null, provider: "test", model: "test", temperature: 0.5 },
    contextPackage: contextPackageWithStyle(),
    content: "原始正文，含明显 AI 味。",
    ...overrides,
  };
}

// 生成一个 detection report。
function report({ riskScore, canAutoRewrite = true, violations }) {
  return {
    riskScore,
    summary: "",
    canAutoRewrite,
    appliedRuleIds: [],
    violations: violations ?? [
      {
        ruleName: "risk-breath-driven-transition",
        ruleType: "risk",
        severity: "medium",
        issueCategory: "style_expression",
        excerpt: "深吸一口气",
        reason: "呼吸驱动情绪转折",
        suggestion: "用动作替代",
        canAutoRewrite: true,
      },
    ],
  };
}

// 可编排的 detection stub：按调用序返回预设 report。
function detectionStub(sequence) {
  let call = 0;
  const stub = {
    calls: 0,
    check: async () => {
      const value = sequence[Math.min(call, sequence.length - 1)];
      call += 1;
      stub.calls = call;
      return value;
    },
  };
  return stub;
}

// 可编排的 rewrite stub：每次返回带轮次标记的正文。
function rewriteStub() {
  const stub = {
    calls: 0,
    rewrite: async () => {
      stub.calls += 1;
      return { content: `第${stub.calls}轮改写产物` };
    },
  };
  return stub;
}

function policyStub(policy) {
  return {
    resolve: async () => ({
      enabled: true,
      secondRoundEnabled: true,
      secondRoundThreshold: 50,
      ...policy,
    }),
  };
}

test("首轮 riskScore 低于阈值时不改写", async () => {
  const detection = detectionStub([report({ riskScore: 20 })]);
  const rewrite = rewriteStub();
  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: detection,
    styleRewriteService: rewrite,
    postGenerationStyleReviewPolicyResolver: policyStub(),
  });

  const result = await runner.run(baseInput());

  assert.equal(rewrite.calls, 0, "低于阈值不应改写");
  assert.equal(result.autoRewritten, false);
  assert.equal(result.finalContent, "原始正文，含明显 AI 味。");
});

test("首轮高分改写后残留低于二轮阈值 → 只改一轮", async () => {
  // 首轮 riskScore=70 触发改写；二轮 re-detect 残留 riskScore=30 < secondRoundThreshold=50 → 不进二轮。
  const detection = detectionStub([
    report({ riskScore: 70 }),
    report({ riskScore: 30 }),
  ]);
  const rewrite = rewriteStub();
  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: detection,
    styleRewriteService: rewrite,
    postGenerationStyleReviewPolicyResolver: policyStub(),
  });

  const result = await runner.run(baseInput());

  assert.equal(rewrite.calls, 1, "残留低于阈值应只改一轮");
  assert.equal(detection.calls, 2, "首轮 + 二轮 re-detect 共两次检测");
  assert.equal(result.autoRewritten, true);
  assert.equal(result.finalContent, "第1轮改写产物");
});

test("首轮高分 + 残留仍高 → 追加第二轮改写", async () => {
  // 首轮 riskScore=70 改写；re-detect 残留 riskScore=60 >= 50 → 二轮改写。
  const detection = detectionStub([
    report({ riskScore: 70 }),
    report({ riskScore: 60 }),
  ]);
  const rewrite = rewriteStub();
  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: detection,
    styleRewriteService: rewrite,
    postGenerationStyleReviewPolicyResolver: policyStub(),
  });

  const result = await runner.run(baseInput());

  assert.equal(rewrite.calls, 2, "残留仍高应追加第二轮");
  assert.equal(result.autoRewritten, true);
  assert.equal(result.finalContent, "第2轮改写产物");
});

test("secondRoundEnabled=false → 退回单轮，不做 re-detect", async () => {
  const detection = detectionStub([
    report({ riskScore: 70 }),
    report({ riskScore: 90 }),
  ]);
  const rewrite = rewriteStub();
  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: detection,
    styleRewriteService: rewrite,
    postGenerationStyleReviewPolicyResolver: policyStub({ secondRoundEnabled: false }),
  });

  const result = await runner.run(baseInput());

  assert.equal(rewrite.calls, 1, "gate 关时只改一轮");
  assert.equal(detection.calls, 1, "gate 关时不做 re-detect");
  assert.equal(result.finalContent, "第1轮改写产物");
});

test("硬上限两轮：即使残留极高也不做第三轮", async () => {
  // 三次检测都返回高分，但二轮后不再 re-detect，rewrite 最多两次。
  const detection = detectionStub([
    report({ riskScore: 90 }),
    report({ riskScore: 90 }),
    report({ riskScore: 90 }),
  ]);
  const rewrite = rewriteStub();
  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: detection,
    styleRewriteService: rewrite,
    postGenerationStyleReviewPolicyResolver: policyStub(),
  });

  await runner.run(baseInput());

  assert.equal(rewrite.calls, 2, "硬上限两轮");
  assert.equal(detection.calls, 2, "首轮 + 一次 re-detect，不做第三次检测");
});

test("policy.enabled=false → 直接返回原文", async () => {
  const detection = detectionStub([report({ riskScore: 90 })]);
  const rewrite = rewriteStub();
  const runner = new PostGenerationStyleReviewRunner({
    styleDetectionService: detection,
    styleRewriteService: rewrite,
    postGenerationStyleReviewPolicyResolver: {
      resolve: async () => ({ enabled: false, secondRoundEnabled: true, secondRoundThreshold: 50 }),
    },
  });

  const result = await runner.run(baseInput());

  assert.equal(detection.calls, 0, "禁用时不检测");
  assert.equal(rewrite.calls, 0, "禁用时不改写");
  assert.equal(result.finalContent, "原始正文，含明显 AI 味。");
});
