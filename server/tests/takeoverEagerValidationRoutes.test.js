const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createApp } = require("../dist/app.js");
const { prisma } = require("../dist/db/prisma.js");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

// Per-model stubbed methods for a *fresh* novel (no volumes, no chapters, no
// story macro, no prior auto-director task). Each returns what an empty DB row
// set would produce, so the eager-validation read chain never consults real rows.
function freshModelStubs() {
  const emptyArray = async () => [];
  const emptyObject = async () => null;
  const freshNovel = {
    id: "novel-fresh",
    title: "fresh",
    description: "",
    targetAudience: null,
    bookSellingPoint: null,
    competingFeel: null,
    first30ChapterPromise: null,
    commercialTagsJson: null,
    genreId: null,
    primaryStoryModeId: null,
    secondaryStoryModeId: null,
    worldId: null,
    writingMode: "original",
    projectMode: "co_pilot",
    narrativePov: "third_person",
    pacePreference: "balanced",
    styleTone: "",
    coverImageUrl: null,
    emotionIntensity: "medium",
    aiFreedom: "medium",
    defaultChapterLength: 8000,
    estimatedChapterCount: 100,
    projectStatus: "not_started",
    storylineStatus: "not_started",
    outlineStatus: "not_started",
    resourceReadyScore: 0,
    sourceNovelId: null,
    sourceKnowledgeDocumentId: null,
    continuationBookAnalysisId: null,
    continuationBookAnalysisSections: null,
    bookContract: null,
  };
  return {
    novel: { findUnique: async () => freshNovel, findUniqueOrThrow: async () => freshNovel, findFirst: async () => freshNovel },
    chapter: { findMany: emptyArray, count: async () => 0, findFirst: emptyObject },
    generationJob: { findFirst: emptyObject, findUnique: emptyObject },
    volumePlan: { findMany: emptyArray, findFirst: emptyObject },
    volumePlanVersion: {
      findMany: emptyArray,
      findFirst: emptyObject,
      findUnique: emptyObject,
      findUniqueOrThrow: emptyObject,
      create: async ({ data }) => ({ id: "volume_version_stub", ...data }),
      upsert: async ({ create }) => ({ id: "volume_version_stub", ...create }),
      update: async ({ data }) => ({ id: "volume_version_stub", ...data }),
      updateMany: async () => ({ count: 0 }),
    },
    storyMacro: { findUnique: emptyObject, findFirst: emptyObject, findMany: emptyArray },
    character: { findMany: emptyArray, count: async () => 0 },
    characterRelation: { findMany: emptyArray },
    styleProfile: { findMany: emptyArray },
    novelWorkflowTask: { findFirst: emptyObject, findMany: emptyArray, count: async () => 0 },
    appSetting: { findMany: emptyArray, findFirst: emptyObject, findUnique: emptyObject },
    novelStyleBinding: { findMany: emptyArray, findFirst: emptyObject },
    styleProfileDraft: { findMany: emptyArray },
  };
}

function applyFreshNovelStubs() {
  // Capture the real methods before overwriting prisma.<model>, so restore()
  // can put them back after the test.
  const originals = {};
  for (const model of Object.keys(prisma)) {
    originals[model] = prisma[model];
  }

  const modelStubs = freshModelStubs();
  const transactionClient = new Proxy({}, {
    get: (_t, modelName) => {
      const stub = modelStubs[modelName];
      if (!stub) {
        // Unknown model inside a volume-workspace transaction on a fresh book
        // should behave emptily; fail loudly rather than silently.
        return async () => {
          throw new Error(`unexpected tx.${String(modelName)} call during fresh-book eager takeover validation`);
        };
      }
      return stub;
    },
  });
  // Route both prisma.<model> and prisma.$transaction(→tx.<model>) into the same stubs
  // so the volume workspace persistence path stays in memory.
  for (const [model, methods] of Object.entries(modelStubs)) {
    prisma[model] = methods;
  }
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = async (runnerOrArray, _opts) => {
    if (typeof runnerOrArray === "function") {
      return runnerOrArray(transactionClient);
    }
    // Array form (unsupported here): map an empty result.
    return runnerOrArray.map(() => undefined);
  };
  return function restore() {
    for (const model of Object.keys(modelStubs)) {
      const orig = originals[model];
      if (orig) {
        prisma[model] = orig;
      }
    }
    prisma.$transaction = originalTransaction;
  };
}

test("POST /api/novels/director/tasks takeover on a not_started book returns 409 and creates no workflow task", async () => {
  const originals = {};
  for (const model of Object.keys(prisma)) {
    originals[model] = prisma[model];
  }

  let taskCreateAttempted = false;
  const restore = applyFreshNovelStubs();
  prisma.novelWorkflowTask = {
    ...(originals.novelWorkflowTask ?? {}),
    create: async () => {
      taskCreateAttempted = true;
      throw new Error("assertTakeoverRequestAllowed must reject before any workflow task is created");
    },
  };

  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/novels/director/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskType: "takeover",
        payload: {
          novelId: "novel-fresh",
          autoExecutionPlan: { mode: "chapter_range", startOrder: 1, endOrder: 10 },
          autoApproval: { enabled: true, approvalPointCodes: [] },
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 409, `expected 409, got ${response.status}: ${JSON.stringify(body)}`);
    assert.equal(body.success, false);
    assert.match(body.error, /章节范围只能从节奏拆章、章节执行或质量修复开始|不能直接/);
    assert.equal(taskCreateAttempted, false, "no workflow task may be created for a rejected takeover");
  } finally {
    restore();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});