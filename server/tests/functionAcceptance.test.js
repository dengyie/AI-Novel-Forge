const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertFunctionTableEnforcible,
  validateFunctionCoverage,
  evaluateFunctionCoverageGate,
  applyFunctionAssignmentsFromChapters,
  markFunctionsSatisfied,
  markUnsatisfiedFunctionsMissed,
  normalizeFunctionAcceptanceTable,
  normalizeFunctionIds,
  mergeMustAvoidWithFunctionBans,
  upsertFunctionAcceptanceTable,
  getFunctionTableForVolume,
} = require("@ai-novel/shared/types/functionAcceptance");

const {
  normalizeVolumeWorkspaceDocument,
  serializeVolumeWorkspaceDocument,
  buildVolumeWorkspaceDocument,
} = require("../dist/services/novel/volume/volumeWorkspaceDocument.js");

const {
  applyFunctionTablePostChapterList,
  assertDocumentFunctionCoverageForSync,
} = require("../dist/services/novel/volume/volumeFunctionCoverage.js");

const {
  FunctionAcceptanceStatusService,
} = require("../dist/services/novel/volume/FunctionAcceptanceStatusService.js");

function buildImportTable(volumeId = "volume-1") {
  return normalizeFunctionAcceptanceTable({
    volumeId,
    schemaVersion: 1,
    source: "import",
    items: [
      {
        id: "fn-trust",
        order: 1,
        title: "陆深托付",
        mustHappen: "陆深当面托付关键事务",
        mustNotHappen: ["超自然外挂开局"],
        acceptanceChecks: ["托付对话落地", "承接人在场"],
        status: "planned",
      },
      {
        id: "fn-red",
        order: 2,
        title: "红入署",
        mustHappen: "红线角色完成入署节点",
        acceptanceChecks: ["入署现场", "身份落点"],
        status: "planned",
      },
    ],
  });
}

function buildBaseVolume(functionIdsByOrder = {}) {
  return {
    id: "volume-1",
    novelId: "novel-1",
    sortOrder: 1,
    title: "第一卷",
    summary: "卷摘要",
    openingHook: "开卷",
    mainPromise: "主承诺",
    primaryPressureSource: "压力",
    coreSellingPoint: "卖点",
    escalationMode: "升级",
    protagonistChange: "变化",
    midVolumeRisk: "风险",
    climax: "高潮",
    payoffType: "兑现",
    nextVolumeHook: "钩子",
    resetPoint: null,
    openPayoffs: [],
    status: "active",
    sourceVersionId: null,
    chapters: [1, 2, 3].map((order) => ({
      id: `chapter-${order}`,
      volumeId: "volume-1",
      chapterOrder: order,
      title: `第${order}章`,
      summary: `摘要${order}`,
      purpose: null,
      conflictLevel: null,
      revealLevel: null,
      targetWordCount: null,
      mustAvoid: null,
      taskSheet: null,
      payoffRefs: [],
      ...(functionIdsByOrder[order]
        ? { functionIds: functionIdsByOrder[order] }
        : {}),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

// --- pure policy / coverage ---

test("generated table cannot enforce", () => {
  const table = normalizeFunctionAcceptanceTable({
    volumeId: "volume-1",
    source: "generated",
    items: [{
      id: "fn-a",
      order: 1,
      title: "生成项",
      mustHappen: "发生",
      acceptanceChecks: ["检查"],
    }],
  });
  const result = assertFunctionTableEnforcible(table);
  assert.equal(result.canEnforce, false);
  assert.match(result.reason ?? "", /generated/);
});

test("import table can enforce", () => {
  const table = buildImportTable();
  const result = assertFunctionTableEnforcible(table);
  assert.equal(result.canEnforce, true);
});

test("mode=off skips coverage", () => {
  const coverage = validateFunctionCoverage({
    table: buildImportTable(),
    chapters: [{ chapterOrder: 1, functionIds: [] }],
    mode: "off",
  });
  assert.equal(coverage.ok, true);
  assert.equal(coverage.missingIds.length, 0);
});

test("enforce missing functionIds fails coverage", () => {
  const table = buildImportTable();
  const gate = evaluateFunctionCoverageGate({
    table,
    chapters: [
      { chapterOrder: 1, functionIds: ["fn-trust"] },
      { chapterOrder: 2, functionIds: [] },
    ],
    mode: "enforce",
  });
  assert.equal(gate.blocking, true);
  assert.ok(gate.coverage.missingIds.includes("fn-red"));
});

test("enforce full coverage passes", () => {
  const table = buildImportTable();
  const gate = evaluateFunctionCoverageGate({
    table,
    chapters: [
      { chapterOrder: 1, functionIds: ["fn-trust"] },
      { chapterOrder: 5, functionIds: ["fn-red"] },
    ],
    mode: "enforce",
  });
  assert.equal(gate.blocking, false);
  assert.equal(gate.coverage.ok, true);
});

test("advisory incomplete coverage does not block", () => {
  const table = buildImportTable();
  const gate = evaluateFunctionCoverageGate({
    table,
    chapters: [{ chapterOrder: 1, functionIds: ["fn-trust"] }],
    mode: "advisory",
  });
  assert.equal(gate.blocking, false);
  assert.ok(gate.issues.length > 0);
});

test("assignment writeback planned→assigned", () => {
  const table = buildImportTable();
  const next = applyFunctionAssignmentsFromChapters(table, [
    { chapterOrder: 3, functionIds: ["fn-trust"] },
    { chapterOrder: 10, functionIds: ["fn-red"] },
  ]);
  const trust = next.items.find((item) => item.id === "fn-trust");
  const red = next.items.find((item) => item.id === "fn-red");
  assert.equal(trust.status, "assigned");
  assert.deepEqual(trust.assignedChapterOrders, [3]);
  assert.equal(red.status, "assigned");
  assert.deepEqual(red.assignedChapterOrders, [10]);
});

test("satisfied and missed writeback", () => {
  let table = buildImportTable();
  table = applyFunctionAssignmentsFromChapters(table, [
    { chapterOrder: 1, functionIds: ["fn-trust"] },
  ]);
  table = markFunctionsSatisfied(table, ["fn-trust"]);
  assert.equal(table.items.find((item) => item.id === "fn-trust").status, "satisfied");
  table = markUnsatisfiedFunctionsMissed(table);
  assert.equal(table.items.find((item) => item.id === "fn-red").status, "missed");
  assert.equal(table.items.find((item) => item.id === "fn-trust").status, "satisfied");
});

test("merge mustAvoid with function bans", () => {
  const merged = mergeMustAvoidWithFunctionBans("不要跑题", ["超自然外挂开局", "不要跑题"]);
  assert.match(merged, /超自然外挂开局/);
  assert.equal(merged.split("；").filter((p) => p === "不要跑题").length, 1);
});

// --- workspace roundtrip ---

test("workspace roundtrip keeps functionIds and functionAcceptanceTables", () => {
  const table = buildImportTable("volume-1");
  const document = buildVolumeWorkspaceDocument({
    novelId: "novel-1",
    volumes: [buildBaseVolume({ 1: ["fn-trust"], 2: ["fn-red"] })],
    strategyPlan: {
      recommendedVolumeCount: 1,
      hardPlannedVolumeCount: 1,
      readerRewardLadder: "r",
      escalationLadder: "e",
      midpointShift: "m",
      notes: "n",
      volumes: [{
        sortOrder: 1,
        planningMode: "hard",
        roleLabel: "开局",
        coreReward: "r",
        escalationFocus: "e",
        uncertaintyLevel: "low",
      }],
      uncertainties: [],
    },
    beatSheets: [{
      volumeId: "volume-1",
      volumeSortOrder: 1,
      status: "generated",
      beats: [{
        key: "beat-1",
        label: "开局",
        summary: "摘要",
        chapterSpanHint: "1-3",
        mustDeliver: ["事件A"],
      }],
    }],
    functionAcceptanceTables: [table],
  });

  assert.ok(document.functionAcceptanceTables?.length === 1);
  assert.deepEqual(document.volumes[0].chapters[0].functionIds, ["fn-trust"]);

  const reparsed = normalizeVolumeWorkspaceDocument(
    "novel-1",
    serializeVolumeWorkspaceDocument(document),
  );
  assert.equal(reparsed.functionAcceptanceTables?.length, 1);
  assert.equal(reparsed.functionAcceptanceTables[0].source, "import");
  assert.deepEqual(reparsed.volumes[0].chapters[0].functionIds, ["fn-trust"]);
  assert.deepEqual(reparsed.volumes[0].chapters[1].functionIds, ["fn-red"]);
});

test("applyFunctionTablePostChapterList assigns and blocks enforce gaps", () => {
  const table = buildImportTable("volume-1");
  const document = buildVolumeWorkspaceDocument({
    novelId: "novel-1",
    volumes: [buildBaseVolume({ 1: ["fn-trust"] })],
    functionAcceptanceTables: [table],
  });

  assert.throws(() => {
    applyFunctionTablePostChapterList({
      document,
      volumeId: "volume-1",
      mode: "enforce",
    });
  }, /功能未覆盖|功能验收/);

  const complete = buildVolumeWorkspaceDocument({
    novelId: "novel-1",
    volumes: [buildBaseVolume({ 1: ["fn-trust"], 2: ["fn-red"] })],
    functionAcceptanceTables: [table],
  });
  const { document: next, gate } = applyFunctionTablePostChapterList({
    document: complete,
    volumeId: "volume-1",
    mode: "enforce",
  });
  assert.equal(gate.blocking, false);
  const nextTable = getFunctionTableForVolume(next.functionAcceptanceTables, "volume-1");
  assert.equal(nextTable.items.find((item) => item.id === "fn-trust").status, "assigned");
  assert.equal(nextTable.items.find((item) => item.id === "fn-red").status, "assigned");
  // mustNotHappen merged into ch1 mustAvoid
  assert.match(next.volumes[0].chapters[0].mustAvoid ?? "", /超自然外挂开局/);
});

test("sync coverage rejects generated table under enforce", () => {
  const generated = normalizeFunctionAcceptanceTable({
    volumeId: "volume-1",
    source: "generated",
    items: [{
      id: "fn-a",
      order: 1,
      title: "生成",
      mustHappen: "发生",
      acceptanceChecks: ["检查"],
    }],
  });
  const document = buildVolumeWorkspaceDocument({
    novelId: "novel-1",
    volumes: [buildBaseVolume({ 1: ["fn-a"] })],
    functionAcceptanceTables: [generated],
  });
  assert.throws(() => {
    assertDocumentFunctionCoverageForSync({
      document,
      mode: "enforce",
    });
  }, /generated|生成表/);
});

test("FunctionAcceptanceStatusService markSatisfiedFromAlignmentPass needs all assigned chapters", () => {
  const service = new FunctionAcceptanceStatusService();
  let document = buildVolumeWorkspaceDocument({
    novelId: "novel-1",
    volumes: [buildBaseVolume({ 1: ["fn-trust"], 2: ["fn-trust"] })],
    functionAcceptanceTables: [buildImportTable("volume-1")],
  });
  document = service.applyAssignments(document, "volume-1");
  // only chapter 1 passed → not satisfied
  let next = service.markSatisfiedFromAlignmentPass({
    document,
    volumeId: "volume-1",
    functionIds: ["fn-trust"],
    passedChapterOrders: [1],
  });
  let table = getFunctionTableForVolume(next.functionAcceptanceTables, "volume-1");
  assert.equal(table.items.find((item) => item.id === "fn-trust").status, "assigned");

  next = service.markSatisfiedFromAlignmentPass({
    document: next,
    volumeId: "volume-1",
    functionIds: ["fn-trust"],
    passedChapterOrders: [1, 2],
  });
  table = getFunctionTableForVolume(next.functionAcceptanceTables, "volume-1");
  assert.equal(table.items.find((item) => item.id === "fn-trust").status, "satisfied");
});

test("markSatisfiedFromAlignmentPass derives assigned from chapter functionIds when empty", () => {
  const service = new FunctionAcceptanceStatusService();
  // 表未 applyAssignments：assignedChapterOrders 空，但章上挂了 functionIds
  const document = buildVolumeWorkspaceDocument({
    novelId: "novel-1",
    volumes: [buildBaseVolume({ 3: ["fn-trust"] })],
    functionAcceptanceTables: [buildImportTable("volume-1")],
  });
  const next = service.markSatisfiedFromAlignmentPass({
    document,
    volumeId: "volume-1",
    functionIds: ["fn-trust"],
    passedChapterOrders: [3],
  });
  const table = getFunctionTableForVolume(next.functionAcceptanceTables, "volume-1");
  assert.equal(table.items.find((item) => item.id === "fn-trust").status, "satisfied");
});

test("normalizeFunctionIds dedupes", () => {
  assert.deepEqual(normalizeFunctionIds(["a", "a", " b ", ""]), ["a", "b"]);
});

test("upsertFunctionAcceptanceTable replaces same volumeId", () => {
  const t1 = buildImportTable("volume-1");
  const t2 = {
    ...t1,
    source: "hybrid",
    items: t1.items.slice(0, 1),
  };
  const tables = upsertFunctionAcceptanceTable([t1], t2);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].source, "hybrid");
  assert.equal(tables[0].items.length, 1);
});
