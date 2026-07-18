const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

// Stub promptRunner.runStructuredPrompt before loading the orchestrator module,
// so generateSkeleton's inner critique+retry loop is exercised without a real LLM
// or DB.  Each call is routed through a scripted queue so we can define abstract->focused
// and abstract->abstract trajectories per test.
const promptRunnerEntry = path.resolve(__dirname, "../dist/prompting/core/promptRunner.js");
const callQueue = [];
const callLog = [];
function resetQueue() {
  callQueue.length = 0;
  callLog.length = 0;
}
const promptRunnerStub = new Module(promptRunnerEntry);
promptRunnerStub.filename = promptRunnerEntry;
promptRunnerStub.loaded = true;
promptRunnerStub.exports = {
  runStructuredPrompt(input) {
    const next = callQueue.shift();
    if (!next) {
      throw new Error("volumeSkeletonOrchestratorCritique.test.js: runStructuredPrompt called with empty queue");
    }
    // Each queue item is either a plain () => Promise<output> (legacy: tagged by
    // input.asset id) or { tag, handle } where tag is "skeleton" | "critique".
    if (typeof next === "function") {
      callLog.push(next._tag ?? inferTagFromInput(input));
      return next(input);
    }
    callLog.push(next.tag);
    return next.handle(input);
  },
};
require.cache[promptRunnerEntry] = promptRunnerStub;

// Heuristic tag inference fallback: skeleton prompts carry asset id
// novel.volume.skeleton@v2; critique prompts carry id ending ".critique".
function inferTagFromInput(input) {
  const id = input && input.asset && input.asset.id;
  if (!id) return "unknown";
  if (id.endsWith(".critique")) return "critique";
  if (id.includes("volume.skeleton")) return "skeleton";
  return "unknown";
}

const {
  generateSkeleton,
} = require("../dist/services/novel/volume/volumeGenerationOrchestrator.js");

// A minimal Novel contract shape that buildCommonNovelContext expects.
function buildNovel() {
  return {
    title: "测试小说",
    description: null,
    targetAudience: null,
    bookSellingPoint: null,
    competingFeel: null,
    first30ChapterPromise: null,
    commercialTagsJson: null,
    estimatedChapterCount: 80,
    defaultChapterLength: 3000,
    narrativePov: null,
    pacePreference: null,
    emotionIntensity: null,
    storyModePromptBlock: null,
    genre: null,
    characters: [],
  };
}

function buildWorkspace() {
  return {
    novelId: "novel-1",
    workspaceVersion: "v2",
    volumes: [],
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [],
    rebalanceDecisions: [],
    readiness: {},
    source: "volume",
    activeVersionId: null,
    functionAcceptanceTables: [],
  };
}

function buildStrategyPlan() {
  return {
    recommendedVolumeCount: 2,
    hardPlannedVolumeCount: 2,
    readerRewardLadder: "ladder",
    escalationLadder: "escalation",
    midpointShift: "shift",
    notes: "notes",
    uncertainties: [],
    volumes: [
      { sortOrder: 1, planningMode: "hard", roleLabel: "开书", coreReward: "r1", escalationFocus: "e1", uncertaintyLevel: "low" },
      { sortOrder: 2, planningMode: "hard", roleLabel: "升级", coreReward: "r2", escalationFocus: "e2", uncertaintyLevel: "low" },
    ],
  };
}

function buildOptions(warnSpy) {
  return {
    entrypoint: "test",
    onPhaseStart: async (event) => {
      if (event.phase === "warn") {
        warnSpy.push(event.label);
      }
    },
  };
}

function skeletonOutput(idPrefix, framing) {
  return {
    output: {
      volumes: [
        {
          title: `${idPrefix}-V1`,
          summary: `${idPrefix}-summary-1`,
          openingHook: "hook",
          mainPromise: "promise",
          primaryPressureSource: framing.v1Pressure,
          coreSellingPoint: "usp",
          escalationMode: "escalation",
          protagonistChange: "change",
          midVolumeRisk: framing.v1Risk,
          climax: "climax",
          payoffType: "payoff",
          nextVolumeHook: "hook2",
          resetPoint: null,
          openPayoffs: [],
        },
        {
          title: `${idPrefix}-V2`,
          summary: `${idPrefix}-summary-2`,
          openingHook: "hook",
          mainPromise: "promise",
          primaryPressureSource: framing.v2Pressure,
          coreSellingPoint: "usp",
          escalationMode: "escalation",
          protagonistChange: "change",
          midVolumeRisk: framing.v2Risk,
          climax: "climax",
          payoffType: "payoff",
          nextVolumeHook: "hook3",
          resetPoint: null,
          openPayoffs: [],
        },
      ],
    },
  };
}

function critiqueOutput(risk, v1Title) {
  return {
    output: {
      overallRisk: risk,
      summary: `critique ${risk}`,
      issues: risk === "low"
        ? []
        : [
          { targetRef: "volumes[0].primaryPressureSource", severity: risk, title: v1Title, detail: "需聚焦具名对手" },
        ],
      recommendedActions: ["把 V1 primaryPressureSource 具名到 1-3 个主动对手"],
    },
  };
}

test("generateSkeleton abstract->focused retries exactly once, then accepts (2 generations, no warn)", async () => {
  resetQueue();
  const warnSpy = [];
  // gen1 abstract skeleton -> critique high -> gen2 focused skeleton -> critique low -> accept
  callQueue.push(
    { tag: "skeleton", handle: () => Promise.resolve(skeletonOutput("g1", { v1Pressure: "全班针对主角", v1Risk: "集体站队", v2Pressure: "全校排挤", v2Risk: "舆论全体" })) },
    { tag: "critique", handle: () => Promise.resolve(critiqueOutput("high", "对手面抽象")) },
    { tag: "skeleton", handle: () => Promise.resolve(skeletonOutput("g2", { v1Pressure: "对手甲与对手乙", v1Risk: "对手丙设局", v2Pressure: "对手丁施压", v2Risk: "对手戊反制" })) },
    { tag: "critique", handle: () => Promise.resolve(critiqueOutput("low", "对手面聚焦")) },
  );
  const result = await generateSkeleton({
    document: {
      novelId: "novel-1",
      volumes: [],
      strategyPlan: buildStrategyPlan(),
      critiqueReport: null,
      beatSheets: [],
      rebalanceDecisions: [],
      functionAcceptanceTables: [],
      source: "volume",
      activeVersionId: null,
    },
    novel: buildNovel(),
    workspace: buildWorkspace(),
    storyMacroPlan: null,
    options: buildOptions(warnSpy),
  });

  assert.equal(result.volumes.length, 2);
  // gen2 wins on retry (title carries g2 prefix), and its pressure is focused-local.
  assert.equal(result.volumes[0].title, "g2-V1");
  assert.equal(result.volumes[0].primaryPressureSource, "对手甲与对手乙");
  assert.equal(result.volumes[1].primaryPressureSource, "对手丁施压");
  // Accepted after gen2 critique low → final critique not required → no warn
  assert.equal(warnSpy.length, 0, "should not warn when critique passes");
  // Queue should be empty (all 4 scripted calls consumed: gen1, critique1, gen2, critique2)
  assert.equal(callQueue.length, 0, "queue should be fully drained on success path");
  // Call sequence: skeleton, critique, skeleton, critique (2 gen + 2 critique).
  // 成功路径下骨架先被判定 abstract(high) 触发带反馈重生，重生后 focused 后 critique low 落库。
  // critique 调用数 = 2（loop 内 critique1 + loop 外 final critique2），skeleton 调用数 = 2。
  const successSkeletonCalls = callLog.filter((t) => t === "skeleton").length;
  const successCritiqueCalls = callLog.filter((t) => t === "critique").length;
  assert.equal(successSkeletonCalls, 2, "success: skeleton generated twice (initial + 1 retry)");
  assert.equal(successCritiqueCalls, 2, "success: critique runs twice (loop critique1 high + final critique2 low)");
  assert.deepEqual(callLog, ["skeleton", "critique", "skeleton", "critique"], "call order must be gen→critique→gen→critique");
  // The final critiqueReport on document is the low one
  assert.equal(result.critiqueReport?.overallRisk, "low");
});

test("generateSkeleton abstract->abstract hits 2-gen cap, keeps volumes+critiqueReport, emits warn (no throw)", async () => {
  resetQueue();
  const warnSpy = [];
  // gen1 abstract -> critique high (still abstract) -> gen2 abstract -> critique high (final) -> warn
  callQueue.push(
    { tag: "skeleton", handle: () => Promise.resolve(skeletonOutput("g1", { v1Pressure: "全班针对主角", v1Risk: "集体站队", v2Pressure: "全校排挤", v2Risk: "舆论全体" })) },
    { tag: "critique", handle: () => Promise.resolve(critiqueOutput("high", "对手面抽象")) },
    { tag: "skeleton", handle: () => Promise.resolve(skeletonOutput("g2", { v1Pressure: "全年级排挤", v1Risk: "集体站队", v2Pressure: "舆论全体", v2Risk: "人情秩序" })) },
    { tag: "critique", handle: () => Promise.resolve(critiqueOutput("high", "对手面仍抽象")) },
  );
  const result = await generateSkeleton({
    document: {
      novelId: "novel-1",
      volumes: [],
      strategyPlan: buildStrategyPlan(),
      critiqueReport: null,
      beatSheets: [],
      rebalanceDecisions: [],
      functionAcceptanceTables: [],
      source: "volume",
      activeVersionId: null,
    },
    novel: buildNovel(),
    workspace: buildWorkspace(),
    storyMacroPlan: null,
    options: buildOptions(warnSpy),
  });

  // Did not throw, returns latest volumes and a critiqueReport.
  assert.ok(result.volumes.length === 2, "should return the latest two volumes despite failure");
  assert.equal(result.critiqueReport?.overallRisk, "high");
  assert.ok(warnSpy.length > 0, "should emit a warn phase when critique still fails at cap");
  assert.match(warnSpy[0], /未完全通过/);
  // 产品化文案：warn label 应说明风险性质（抽象集体 framing）与可操作路径（分卷面板手动重生）
  assert.match(warnSpy[0], /抽象集体/);
  assert.match(warnSpy[0], /在分卷面板查看 critique 报告后手动重生/);
  assert.equal(callQueue.length, 0, "queue should be drained");
  // Call sequence: skeleton, critique, skeleton, critique (2 gen + 2 critique).
  // 失败路径 loop 内 critique1=high 触发重生后，generations 已达上限 2，直接走 loop 外 final critique2=high，
  // 再带 warn 落库。critique 调用数 = 2（loop 内 1 + loop 外 final 1），skeleton 调用数 = 2。
  const failSkeletonCalls = callLog.filter((t) => t === "skeleton").length;
  const failCritiqueCalls = callLog.filter((t) => t === "critique").length;
  assert.equal(failSkeletonCalls, 2, "failure: skeleton generated twice then capped");
  assert.equal(failCritiqueCalls, 2, "failure: critique runs twice (loop critique1 + final critique2)");
  assert.deepEqual(callLog, ["skeleton", "critique", "skeleton", "critique"], "call order must be gen→critique→gen→critique");
});
