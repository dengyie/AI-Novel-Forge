const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DirectorCoreStepModuleRuntime,
  buildDefaultDirectorCoreStepModuleRuntimeDeps,
} = require("../dist/services/novel/director/workflowStepRuntime/DirectorCoreStepModuleRuntime.js");
const {
  resolveChapterExecutionProgressScope,
} = require("../dist/services/novel/director/workflowStepRuntime/directorWorkflowStepShared.js");
const {
  getDirectorExecutionContractSyncStepModule,
} = require("../dist/services/novel/director/workflowStepRuntime/directorWorkflowStepRegistry.js");

// ---- 背景 --------------------------------------------------------
// 接管（whole-book / chapter_range）的 chapter_execution_contract.sync 模块走
// executeChapterExecutionContractSyncStep({ novelId })，同步 volume workspace 时会
// `assertSyncableChapterExecutionContracts` → 如果未携带 executionContractChapterRange，
// 同步器会对整个 workspace 做执行合同质量门禁 —— 一旦全书里任一章（神通者 ch19）合同不完整，
// 整条接管管线死在「第 N 章执行合同未通过质量门禁」。
//
// 先例（都有 range）：novelDirectorAutoExecutionBatchPrepare.ts:143/492、
// novelDirectorStructuredOutlinePhase.ts:79/493。本 step 缺 range = 漏洞。
// 修：runtime 透传 + module buildInput 用 resolveChapterExecutionProgressScope 推导。

function buildWorkspace() {
  return {
    volumes: [
      {
        id: "vol-1",
        title: "卷一",
        chapters: [
          { id: "c1", chapterOrder: 1, title: "Ch1" },
          { id: "c2", chapterOrder: 2, title: "Ch2" },
        ],
      },
    ],
  };
}

function depsDefault() {
  return buildDefaultDirectorCoreStepModuleRuntimeDeps();
}

function buildPipelineRuntimeStub() {
  const base = depsDefault().pipelineRuntime;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "loadVolumeWorkspaceForOutline") {
        return async () => buildWorkspace();
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function buildSyncSpy() {
  const calls = [];
  const spy = async (_novelId, input, options) => {
    calls.push({ input, options });
    return { volumes: buildWorkspace().volumes };
  };
  spy.calls = calls;
  return spy;
}

function makeRuntime(volumeService) {
  const deps = depsDefault();
  return new DirectorCoreStepModuleRuntime({
    ...deps,
    volumeService,
    pipelineRuntime: buildPipelineRuntimeStub(),
  });
}

// ---- RED-1 / GREEN-1: runtime 透传 executionContractChapterRange ----

test("chapter sync runtime forwards executionContractChapterRange to syncVolumeChaptersWithOptions when provided", async () => {
  const volumeService = { syncVolumeChaptersWithOptions: buildSyncSpy() };
  const runtime = makeRuntime(volumeService);

  await runtime.executeChapterExecutionContractSyncStep({
    novelId: "novelx",
    executionContractChapterRange: { startOrder: 4, endOrder: 16 },
  });

  assert.equal(volumeService.syncVolumeChaptersWithOptions.calls.length, 1);
  const call = volumeService.syncVolumeChaptersWithOptions.calls[0];
  assert.deepEqual(call.input.executionContractChapterRange, {
    startOrder: 4,
    endOrder: 16,
  });
});

// 兼容守卫：无 range（历史 whole-scope 语义）时保持 undefined，不注入 null 破坏门禁范围
test("sync keeps whole-scope (undefined) when step carries no chapter range", async () => {
  const volumeService = { syncVolumeChaptersWithOptions: buildSyncSpy() };
  const runtime = makeRuntime(volumeService);

  await runtime.executeChapterExecutionContractSyncStep({ novelId: "novelx" });

  assert.equal(volumeService.syncVolumeChaptersWithOptions.calls.length, 1);
  const call = volumeService.syncVolumeChaptersWithOptions.calls[0];
  assert.equal(call.input.executionContractChapterRange, undefined);
});

// ---- RED-3 / GREEN-3: module buildInput 必须产出 chapter range ----

test("takeover chapter_sync module buildInput carries executionContractChapterRange key", async () => {
  const module = getDirectorExecutionContractSyncStepModule();

  const context = {
    mode: "manual", // 非 director 上下文 → loadDirectorModuleState 走 buildMinimalStateForNovel，不碰 DB
    novelId: "novel-scoped",
  };

  const input = await module.buildInput(context);

  assert.equal(input.novelId, "novel-scoped");
  // 修复前 buildInput 只回 { novelId }，此键缺失 → RED
  assert.ok(
    "executionContractChapterRange" in input,
    "chapter_sync module 必须显式产出 executionContractChapterRange 键",
  );
  // 空 seedPayload 无 autoExecutionPlan → normalizeDirectorAutoExecutionPlan(null) 落到默认 {1..10}
  assert.deepEqual(input.executionContractChapterRange, { startOrder: 1, endOrder: 10 });
});

// ---- 纯函数层：resolveChapterExecutionProgressScope 从存档 auto-execution 推导范围 ----

test("resolveChapterExecutionProgressScope derives chapter range from stored auto-execution state", () => {
  const state = {
    seedPayload: {
      autoExecution: {
        enabled: true,
        startOrder: 4,
        endOrder: 16,
        totalChapterCount: 13,
      },
      autoExecutionPlan: null,
    },
    task: { novelId: "novel-scoped" },
  };
  const range = resolveChapterExecutionProgressScope({ state, request: null });
  assert.deepEqual(range, { startOrder: 4, endOrder: 16 });
});

test("resolveChapterExecutionProgressScope falls back to whole-scope when plan is volume/book", () => {
  const state = {
    seedPayload: {
      autoExecution: null,
      autoExecutionPlan: { mode: "book" },
    },
  };
  const range = resolveChapterExecutionProgressScope({ state, request: null });
  assert.equal(range, null);
});