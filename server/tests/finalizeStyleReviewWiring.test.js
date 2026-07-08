const test = require("node:test");
const assert = require("node:assert/strict");

const { ChapterContentFinalizationService } = require("../dist/services/novel/runtime/ChapterContentFinalizationService.js");
const { openConflictService } = require("../dist/services/state/OpenConflictService.js");

// 接入守卫：finalize 必须真正调用 PostGenerationStyleReviewRunner.run，采纳改写产物作为定稿正文，
// runner 抛错时回退原内容不中断生成，质量门收到的应是改写后正文（而非原始草稿）。
// 这是闭合此前"runner 做好但从没接入 finalize 生成链路"的 P1 缺口的关键集成测试。

function acceptedAcceptance() {
  return {
    acceptance: {
      score: { coherence: 90, pacing: 90, repetition: 90, engagement: 90, voice: 90, overall: 90 },
      issues: [],
      auditReports: [],
      assessment: {
        status: "accepted",
        score: { coherence: 90, pacing: 90, repetition: 90, engagement: 90, voice: 90, overall: 90 },
        blockingIssues: [],
        repairDirectives: [],
        missingObligations: [],
        repairability: "none",
        decisionReason: "ok",
        riskTags: [],
        assetSyncRecommendation: { priority: "normal", reason: "ok", requiresFullPayoffReconcile: false },
        continuePolicy: "continue",
        summary: "ok",
      },
    },
    timelineGate: { result: { status: "passed", score: 0.9, issues: [] } },
  };
}

const originalListOpenConflicts = openConflictService.listOpenConflicts;
test.before(() => { openConflictService.listOpenConflicts = async () => []; });
test.after(() => { openConflictService.listOpenConflicts = originalListOpenConflicts; });

function buildService({ runner }) {
  let gateContent = null;
  const qualityGateService = {
    runAcceptanceGateOnly: async (input) => {
      gateContent = input.content;
      return acceptedAcceptance();
    },
  };
  const artifactSyncService = { syncChapterArtifacts: async () => undefined };
  const plannerService = { shouldTriggerReplanFromAudit: () => false };
  const agentRuntime = { finishChapterGenRun: async () => undefined };
  const service = new ChapterContentFinalizationService({
    qualityGateService,
    artifactSyncService,
    plannerService,
    agentRuntime,
    postGenerationStyleReviewRunner: runner,
  });
  service.markChapterStatus = async () => undefined;
  service.finishTraceRun = async () => undefined;
  return { service, getGateContent: () => gateContent };
}

const STYLE_CONTEXT = { styleContext: { compiledBlocks: { generationSystemAddendum: "anti-ai" } } };
const baseInput = (content) => ({
  novelId: "novel-1",
  chapterId: "chapter-1",
  request: {},
  contextPackage: { chapter: { id: "chapter-1", title: "第1章", order: 1, targetWordCount: 3000 }, ...STYLE_CONTEXT },
  content,
  runId: null,
  startMs: null,
});

test("finalize 调用 runner 并采纳改写后的正文作为 finalContent", async () => {
  let runCalls = 0;
  const { service, getGateContent } = buildService({
    runner: {
      run: async (input) => {
        runCalls += 1;
        assert.equal(input.content, "原始草稿含 AI 味");
        return {
          report: { riskScore: 80, summary: "高", violations: [], canAutoRewrite: true, appliedRuleIds: [] },
          residualReport: { riskScore: 0, summary: "干净", violations: [], canAutoRewrite: false, appliedRuleIds: [] },
          autoRewritten: true,
          originalContent: "原始草稿含 AI 味",
          finalContent: "改写后正文",
        };
      },
    },
  });

  const result = await service.finalizeChapterContent(baseInput("原始草稿含 AI 味"));

  assert.equal(runCalls, 1);
  assert.equal(result.finalContent, "改写后正文");
  assert.equal(result.styleReview.autoRewritten, true);
  assert.equal(result.styleReview.finalContent, "改写后正文");
  // 质量门收到的应是改写后正文（验证整条链路透传改写产物，而非原始草稿）。
  assert.equal(getGateContent(), "改写后正文");
});

test("runner.autoRewritten=false 时原样透传原始正文", async () => {
  const { service, getGateContent } = buildService({
    runner: {
      run: async () => ({
        report: { riskScore: 20, summary: "低", violations: [], canAutoRewrite: false, appliedRuleIds: [] },
        residualReport: null,
        autoRewritten: false,
        originalContent: null,
        finalContent: "正文",
      }),
    },
  });

  const result = await service.finalizeChapterContent(baseInput("正文"));

  assert.equal(result.finalContent, "正文");
  assert.equal(result.styleReview.autoRewritten, false);
  assert.equal(getGateContent(), "正文");
});

test("runner.run 抛错时回退原始正文，不中断章节定稿", async () => {
  let runCalls = 0;
  const { service, getGateContent } = buildService({
    runner: {
      run: async () => {
        runCalls += 1;
        throw new Error("LLM 渠道挂了");
      },
    },
  });

  const result = await service.finalizeChapterContent(baseInput("正文"));

  assert.equal(runCalls, 1);
  // 抛错 → 回退原文，finalize 不应抛出。
  assert.equal(result.finalContent, "正文");
  assert.equal(result.styleReview.autoRewritten, false);
  assert.equal(result.styleReview.report, null);
  assert.equal(result.styleReview.residualReport, null);
  assert.equal(getGateContent(), "正文");
});

test("无 styleContext 时 runner 仍被调用但应自短路（不依赖 finalize 跳过）", async () => {
  // finalize 不自己判 styleContext，统一交给 runner。runner 无 styleContext 时返回 noRewrite。
  let runCalls = 0;
  const { service } = buildService({
    runner: {
      run: async (input) => {
        runCalls += 1;
        // 模拟真实 runner 的无 styleContext 短路：返回 noRewrite。
        assert.equal(input.contextPackage.styleContext?.compiledBlocks, undefined);
        return {
          report: null,
          residualReport: null,
          autoRewritten: false,
          originalContent: null,
          finalContent: input.content,
        };
      },
    },
  });

  const noStyleInput = {
    ...baseInput("正文"),
    contextPackage: { chapter: { id: "chapter-1", title: "第1章", order: 1, targetWordCount: 3000 } },
  };
  const result = await service.finalizeChapterContent(noStyleInput);

  assert.equal(runCalls, 1);
  assert.equal(result.finalContent, "正文");
});
