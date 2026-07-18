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
function resetQueue() {
  callQueue.length = 0;
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
    return next(input);
  },
};
require.cache[promptRunnerEntry] = promptRunnerStub;

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
    () => Promise.resolve(skeletonOutput("g1", { v1Pressure: "全班针对主角", v1Risk: "集体站队", v2Pressure: "全校排挤", v2Risk: "舆论全体" })),
    () => Promise.resolve(critiqueOutput("high", "对手面抽象")),
    () => Promise.resolve(skeletonOutput("g2", { v1Pressure: "对手甲与对手乙", v1Risk: "对手丙设局", v2Pressure: "对手丁施压", v2Risk: "对手戊反制" })),
    () => Promise.resolve(critiqueOutput("low", "对手面聚焦")),
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
  // The final critiqueReport on document is the low one
  assert.equal(result.critiqueReport?.overallRisk, "low");
});

test("generateSkeleton abstract->abstract hits 2-gen cap, keeps volumes+critiqueReport, emits warn (no throw)", async () => {
  resetQueue();
  const warnSpy = [];
  // gen1 abstract -> critique high (still abstract) -> gen2 abstract -> critique high (final) -> warn
  callQueue.push(
    () => Promise.resolve(skeletonOutput("g1", { v1Pressure: "全班针对主角", v1Risk: "集体站队", v2Pressure: "全校排挤", v2Risk: "舆论全体" })),
    () => Promise.resolve(critiqueOutput("high", "对手面抽象")),
    () => Promise.resolve(skeletonOutput("g2", { v1Pressure: "全年级排挤", v1Risk: "集体站队", v2Pressure: "舆论全体", v2Risk: "人情秩序" })),
    () => Promise.resolve(critiqueOutput("high", "对手面仍抽象")),
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
  assert.equal(callQueue.length, 0, "queue should be drained");
});
