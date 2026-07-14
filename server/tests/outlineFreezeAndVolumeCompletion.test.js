const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOutlineDiffAgainstFunctions,
  buildOutlineFreezeSnapshot,
  evaluateOutlineFreezeGate,
  fingerprintFunctionAcceptanceTable,
  fingerprintOutlineChapterAssignments,
  isOutlineFreezeSnapshotValid,
  upsertOutlineFreezeSnapshot,
} = require("@ai-novel/shared/types/outlineFreeze");

const {
  resolveVolumeCompletion,
  shouldCloseVolumeForSupervisor,
} = require("@ai-novel/shared/types/volumeSettingCompletion");

const {
  normalizeFunctionAcceptanceTable,
  markFunctionsSatisfied,
  applyFunctionAssignmentsFromChapters,
} = require("@ai-novel/shared/types/functionAcceptance");

const {
  buildVolumeWorkspaceDocument,
  normalizeVolumeWorkspaceDocument,
} = require("../dist/services/novel/volume/volumeWorkspaceDocument.js");

const {
  buildOutlineDiffForVolume,
  persistOutlineFreezeOnStructuredOutlineReady,
  evaluateDocumentOutlineFreezeGate,
  buildStructuredOutlineFunctionCoverageEvidence,
} = require("../dist/services/novel/volume/outlineFreezeService.js");

const {
  projectVolumeSettingCompletion,
  toVolumeCompletionCheckpointPayload,
  isVolumeSupervisoryCloseable,
} = require("../dist/services/novel/volume/volumeSettingCompletionService.js");

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
        charactersOnPage: ["陆深", "承接人"],
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
      {
        id: "fn-bridge",
        order: 3,
        title: "桥面锚",
        mustHappen: "桥面环境锚落地",
        acceptanceChecks: ["桥面在场"],
        status: "planned",
      },
    ],
  });
}

function buildVolume(functionIdsByOrder = {}) {
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
      chapterOrder: order,
      title: `第${order}章`,
      summary: `摘要${order}`,
      purpose: `推进${order}`,
      exclusiveEvent: order === 1 ? "陆深当面托付" : order === 2 ? "红线入署" : "桥面锚点",
      endingState: `结束${order}`,
      nextChapterEntryState: `入口${order}`,
      conflictLevel: 40 + order,
      revealLevel: 30 + order,
      targetWordCount: 3000,
      mustAvoid: "不要复写邻章",
      payoffRefs: [],
      functionIds: functionIdsByOrder[order] ?? [],
      taskSheet: null,
      sceneCards: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    })),
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function buildCoveredDocument() {
  return buildVolumeWorkspaceDocument({
    novelId: "novel-1",
    volumes: [buildVolume({
      1: ["fn-trust"],
      2: ["fn-red"],
      3: ["fn-bridge"],
    })],
    functionAcceptanceTables: [buildImportTable("volume-1")],
  });
}

test("C1 mode=off outline diff is non-blocking", () => {
  const report = buildOutlineDiffAgainstFunctions({
    volumeId: "volume-1",
    chapters: [
      { chapterOrder: 1, functionIds: [] },
    ],
    table: buildImportTable(),
    mode: "off",
  });
  assert.equal(report.coverageOk, true);
  assert.equal(report.blocking, false);
  assert.match(report.summary, /off/);
});

test("C1 enforce uncovered functions keeps outline fact incomplete (blocking)", () => {
  const report = buildOutlineDiffAgainstFunctions({
    volumeId: "volume-1",
    chapters: [
      { chapterOrder: 1, functionIds: ["fn-trust"] },
    ],
    table: buildImportTable(),
    mode: "enforce",
  });
  assert.equal(report.blocking, true);
  assert.ok(report.issues.some((issue) => /fn-red|fn-bridge|未覆盖|未挂/.test(issue)));

  const evidence = buildStructuredOutlineFunctionCoverageEvidence({
    document: buildVolumeWorkspaceDocument({
      novelId: "novel-1",
      volumes: [buildVolume({ 1: ["fn-trust"] })],
      functionAcceptanceTables: [buildImportTable()],
    }),
    volumeId: "volume-1",
    mode: "enforce",
  });
  assert.equal(evidence.blocking, true);
  assert.equal(evidence.coverageOk, false);
});

test("C1 freeze snapshot after structured_outline_ready; fingerprint stable", () => {
  const document = buildCoveredDocument();
  const { document: frozen, snapshot } = persistOutlineFreezeOnStructuredOutlineReady({
    document,
    volumeId: "volume-1",
    mode: "enforce",
    actor: "supervisor",
    reason: "structured_outline_ready",
    beatNames: ["开局", "承压"],
  });

  assert.equal(snapshot.approvalPoint, "structured_outline_ready");
  assert.equal(snapshot.coverageOk, true);
  assert.ok(snapshot.contentHash);
  assert.ok(snapshot.tableFingerprint);
  assert.equal(snapshot.tableFingerprint, fingerprintFunctionAcceptanceTable(buildImportTable()));
  assert.ok(frozen.outlineFreezeSnapshots?.some((item) => item.volumeId === "volume-1"));

  const gate = evaluateDocumentOutlineFreezeGate({
    document: frozen,
    volumeId: "volume-1",
    mode: "enforce",
  });
  assert.equal(gate.freezeValid, true);
  assert.equal(gate.allowAutoExecute, true);
  assert.equal(gate.coverageBlocking, false);
});

test("C1 freeze invalid when chapter assignments change after approval", () => {
  const document = buildCoveredDocument();
  const { document: frozen, snapshot } = persistOutlineFreezeOnStructuredOutlineReady({
    document,
    volumeId: "volume-1",
    mode: "enforce",
  });
  assert.equal(isOutlineFreezeSnapshotValid(snapshot, {
    chapters: document.volumes[0].chapters,
    table: buildImportTable(),
    mode: "enforce",
  }), true);

  const mutatedChapters = document.volumes[0].chapters.map((chapter) => (
    chapter.chapterOrder === 3
      ? { ...chapter, functionIds: [] }
      : chapter
  ));
  assert.equal(isOutlineFreezeSnapshotValid(snapshot, {
    chapters: mutatedChapters,
    table: buildImportTable(),
    mode: "enforce",
  }), false);

  const nextDoc = {
    ...frozen,
    volumes: [{
      ...frozen.volumes[0],
      chapters: mutatedChapters,
    }],
  };
  const gate = evaluateDocumentOutlineFreezeGate({
    document: nextDoc,
    volumeId: "volume-1",
    mode: "enforce",
  });
  assert.equal(gate.freezeValid, false);
  assert.equal(gate.allowAutoExecute, false);
});

test("C1 off/advisory never blocks auto_execute for missing freeze", () => {
  const document = buildCoveredDocument();
  for (const mode of ["off", "advisory"]) {
    const gate = evaluateOutlineFreezeGate({
      mode,
      snapshot: null,
      chapters: document.volumes[0].chapters,
      table: buildImportTable(),
    });
    assert.equal(gate.allowAutoExecute, true);
    assert.equal(gate.requireFreeze, false);
  }
});

test("C1 workspace normalize preserves outlineFreezeSnapshots", () => {
  const document = buildCoveredDocument();
  const { document: frozen } = persistOutlineFreezeOnStructuredOutlineReady({
    document,
    volumeId: "volume-1",
    mode: "enforce",
  });
  const roundTrip = normalizeVolumeWorkspaceDocument("novel-1", frozen);
  assert.equal(roundTrip.outlineFreezeSnapshots?.length, 1);
  assert.equal(roundTrip.outlineFreezeSnapshots[0].approvalPoint, "structured_outline_ready");
});

test("C3 mode=off resolves legacy closeable", () => {
  const resolution = resolveVolumeCompletion({
    mode: "off",
    functionTable: buildImportTable(),
    proseComplete: true,
  });
  assert.equal(resolution.kind, "legacy");
  assert.equal(resolution.supervisoryCloseable, true);
  assert.equal(shouldCloseVolumeForSupervisor(resolution), true);
});

test("C3 all satisfied → setting_complete", () => {
  let table = applyFunctionAssignmentsFromChapters(buildImportTable(), [
    { chapterOrder: 1, functionIds: ["fn-trust"] },
    { chapterOrder: 2, functionIds: ["fn-red"] },
    { chapterOrder: 3, functionIds: ["fn-bridge"] },
  ]);
  table = markFunctionsSatisfied(table, ["fn-trust", "fn-red", "fn-bridge"]);
  const resolution = resolveVolumeCompletion({
    mode: "enforce",
    functionTable: table,
    proseComplete: true,
  });
  assert.equal(resolution.kind, "setting_complete");
  assert.equal(resolution.supervisoryCloseable, true);
  assert.deepEqual(resolution.unsatisfiedIds, []);
});

test("C3 missing satisfied → prose_complete_only not closeable", () => {
  const table = applyFunctionAssignmentsFromChapters(buildImportTable(), [
    { chapterOrder: 1, functionIds: ["fn-trust"] },
    { chapterOrder: 2, functionIds: ["fn-red"] },
    { chapterOrder: 3, functionIds: ["fn-bridge"] },
  ]);
  // only one satisfied
  const partial = markFunctionsSatisfied(table, ["fn-trust"]);
  const resolution = resolveVolumeCompletion({
    mode: "enforce",
    functionTable: partial,
    proseComplete: true,
  });
  assert.equal(resolution.kind, "prose_complete_only");
  assert.equal(resolution.supervisoryCloseable, false);
  assert.ok(resolution.unsatisfiedIds.includes("fn-red"));
  assert.ok(resolution.unsatisfiedIds.includes("fn-bridge"));
});

test("C3 force + audit → forced closeable", () => {
  const table = applyFunctionAssignmentsFromChapters(buildImportTable(), [
    { chapterOrder: 1, functionIds: ["fn-trust"] },
  ]);
  const resolution = resolveVolumeCompletion({
    mode: "enforce",
    functionTable: table,
    proseComplete: true,
    forceFlag: true,
    forceAudit: {
      actor: "ops",
      at: "2026-07-15T12:00:00.000Z",
      reason: "force_complete_volume for release window",
    },
  });
  assert.equal(resolution.kind, "forced");
  assert.equal(resolution.supervisoryCloseable, true);
  assert.equal(resolution.forceApplied, true);
  assert.equal(resolution.audit?.actor, "ops");
});

test("C3 force without audit is not silent-closeable", () => {
  const resolution = resolveVolumeCompletion({
    mode: "enforce",
    functionTable: buildImportTable(),
    forceFlag: true,
  });
  assert.equal(resolution.kind, "forced");
  assert.equal(resolution.supervisoryCloseable, false);
});

test("C3 projection + checkpoint payload for director", () => {
  let table = applyFunctionAssignmentsFromChapters(buildImportTable(), [
    { chapterOrder: 1, functionIds: ["fn-trust"] },
    { chapterOrder: 2, functionIds: ["fn-red"] },
    { chapterOrder: 3, functionIds: ["fn-bridge"] },
  ]);
  table = markFunctionsSatisfied(table, ["fn-trust", "fn-red", "fn-bridge"]);
  const document = buildVolumeWorkspaceDocument({
    novelId: "novel-1",
    volumes: [buildVolume({
      1: ["fn-trust"],
      2: ["fn-red"],
      3: ["fn-bridge"],
    })],
    functionAcceptanceTables: [table],
  });
  const projection = projectVolumeSettingCompletion({
    document,
    volumeId: "volume-1",
    mode: "enforce",
    proseComplete: true,
  });
  assert.equal(projection.kind, "setting_complete");
  assert.equal(isVolumeSupervisoryCloseable(projection), true);
  const payload = toVolumeCompletionCheckpointPayload(projection);
  assert.equal(payload.volumeCompletion, "setting_complete");
  assert.equal(payload.supervisoryCloseable, true);
  assert.equal(payload.volumeId, "volume-1");
});

test("C1 e2e fixture: covered enforce → freeze → setting path; uncovered blocks", () => {
  // uncovered
  const uncovered = buildVolumeWorkspaceDocument({
    novelId: "novel-fixture",
    volumes: [buildVolume({ 1: ["fn-trust"] })],
    functionAcceptanceTables: [buildImportTable()],
  });
  const uncoveredDiff = buildOutlineDiffForVolume({
    document: uncovered,
    volumeId: "volume-1",
    mode: "enforce",
  });
  assert.equal(uncoveredDiff.blocking, true);

  // covered + freeze
  const covered = buildCoveredDocument();
  const { document: frozen } = persistOutlineFreezeOnStructuredOutlineReady({
    document: covered,
    volumeId: "volume-1",
    mode: "enforce",
    actor: "fixture",
  });
  const gate = evaluateDocumentOutlineFreezeGate({
    document: frozen,
    volumeId: "volume-1",
    mode: "enforce",
  });
  assert.equal(gate.allowAutoExecute, true);

  // same fixture mode=off baseline: no block
  const offEvidence = buildStructuredOutlineFunctionCoverageEvidence({
    document: uncovered,
    volumeId: "volume-1",
    mode: "off",
  });
  assert.equal(offEvidence.blocking, false);
  assert.equal(offEvidence.coverageOk, true);
});

test("upsertOutlineFreezeSnapshot replaces same volume", () => {
  const a = buildOutlineFreezeSnapshot({
    volumeId: "volume-1",
    chapters: [{ chapterOrder: 1, functionIds: ["fn-trust"] }],
    table: buildImportTable(),
    mode: "advisory",
  });
  const b = buildOutlineFreezeSnapshot({
    volumeId: "volume-1",
    chapters: [
      { chapterOrder: 1, functionIds: ["fn-trust"] },
      { chapterOrder: 2, functionIds: ["fn-red"] },
    ],
    table: buildImportTable(),
    mode: "advisory",
  });
  const list = upsertOutlineFreezeSnapshot([a], b);
  assert.equal(list.length, 1);
  assert.equal(list[0].contentHash, b.contentHash);
  assert.notEqual(
    fingerprintOutlineChapterAssignments([{ chapterOrder: 1, functionIds: ["fn-trust"] }]),
    fingerprintOutlineChapterAssignments([
      { chapterOrder: 1, functionIds: ["fn-trust"] },
      { chapterOrder: 2, functionIds: ["fn-red"] },
    ]),
  );
});
