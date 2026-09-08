const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildNonSettingDebtStubUpdate,
} = require("../dist/services/novel/pipeline/quality/PipelineChapterQualityPolicy.js");

// D3：非 setting-debt 持久化失败路径下 DB riskFlags 不落库仅内存，重启后 director 读旧值。
// 修复：对称补一条 stub 落库（与 setting-debt 路径对称），plain update 直接写 riskFlags。
//
// 设计抉择（code-review #2）：不用 contentRevision CAS。原因：recordAssessment 落库失败的
// 常见触发正是 contentRevision 并发冲突（章节已被别路 bump revision）；stub 用同一旧 revision
// 去 CAS 几乎必然 count=0 跳过覆盖——等于没修。用户选了「对称 stub 落库」方向，本意就是
// 「把内存评估落进 DB」，CAS 与该方向矛盾。故 plain update，接受覆盖风险，日志如实标注。
// 不动 chapterStatus：非 setting-debt 不一定有债，误置 needs_repair 会误伤无债章。

const CHAPTER_ID = "chapter-42";
const MEMORY_RISK_FLAGS = JSON.stringify({ qualityLoop: { rootCauseCode: "test" } });

test("returns plain update with riskFlags only (no chapterStatus)", () => {
  const update = buildNonSettingDebtStubUpdate({
    chapterId: CHAPTER_ID,
    memoryRiskFlags: MEMORY_RISK_FLAGS,
  });
  assert.equal(update.kind, "plain");
  assert.deepEqual(update.where, { id: CHAPTER_ID });
  assert.deepEqual(update.data, { riskFlags: MEMORY_RISK_FLAGS });
  // 不含 chapterStatus：非 setting-debt 路径不应误置 needs_repair
  assert.equal(update.data.chapterStatus, undefined);
});

test("expectedContentRevision is accepted but does not switch to CAS", () => {
  // code-review #2：曾用 contentRevision CAS，但在冲突场景必 miss（别路已 bump revision）。
  // 现统一 plain update，expectedContentRevision 仅用于日志标注，不改变写入路径。
  const update = buildNonSettingDebtStubUpdate({
    chapterId: CHAPTER_ID,
    memoryRiskFlags: MEMORY_RISK_FLAGS,
    expectedContentRevision: 7,
  });
  assert.equal(update.kind, "plain");
  assert.deepEqual(update.where, { id: CHAPTER_ID });
  assert.deepEqual(update.data, { riskFlags: MEMORY_RISK_FLAGS });
});

test("missing chapterId returns null (no stub write)", () => {
  assert.equal(
    buildNonSettingDebtStubUpdate({ chapterId: "", memoryRiskFlags: MEMORY_RISK_FLAGS }),
    null,
  );
  assert.equal(
    buildNonSettingDebtStubUpdate({ chapterId: null, memoryRiskFlags: MEMORY_RISK_FLAGS }),
    null,
  );
});

test("missing memoryRiskFlags returns null (nothing to persist)", () => {
  assert.equal(
    buildNonSettingDebtStubUpdate({ chapterId: CHAPTER_ID, memoryRiskFlags: null }),
    null,
  );
  assert.equal(
    buildNonSettingDebtStubUpdate({ chapterId: CHAPTER_ID, memoryRiskFlags: undefined }),
    null,
  );
  // 空字符串 riskFlags 仍可落库（清空语义）
  assert.equal(
    buildNonSettingDebtStubUpdate({ chapterId: CHAPTER_ID, memoryRiskFlags: "" }).kind,
    "plain",
  );
});
