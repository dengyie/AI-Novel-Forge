const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countIncompleteAttemptsForChapter,
  isChapterLockConflictMessage,
  mapRepairOutcomeFromFrames,
} = require("../dist/services/novel/volume/VolumeReadinessExecutor.js");

// C3：failed / skipped_locked 此前不在计数域，attemptCount 读不到 → 天花板失效 → 无限重试烧预算

test("countIncompleteAttemptsForChapter: failed 计入重试次数（C3）", () => {
  const results = [
    { chapterId: "c1", outcome: "failed", attemptCount: 2 },
  ];
  assert.equal(countIncompleteAttemptsForChapter(results, "c1"), 2);
});

test("countIncompleteAttemptsForChapter: skipped_locked 计入重试次数（C3）", () => {
  const results = [
    { chapterId: "c1", outcome: "skipped_locked", attemptCount: 1 },
  ];
  assert.equal(countIncompleteAttemptsForChapter(results, "c1"), 1);
});

test("countIncompleteAttemptsForChapter: failed 无 attemptCount 时按 1 计（C3）", () => {
  const results = [{ chapterId: "c1", outcome: "failed" }];
  assert.equal(countIncompleteAttemptsForChapter(results, "c1"), 1);
});

test("countIncompleteAttemptsForChapter: incomplete 行为不回归", () => {
  assert.equal(
    countIncompleteAttemptsForChapter(
      [{ chapterId: "c1", outcome: "repair_incomplete", attemptCount: 3 }],
      "c1",
    ),
    3,
  );
});

test("countIncompleteAttemptsForChapter: terminal 清零（kept/adopted）", () => {
  assert.equal(
    countIncompleteAttemptsForChapter(
      [{ chapterId: "c1", outcome: "kept", attemptCount: 3 }],
      "c1",
    ),
    0,
  );
  assert.equal(
    countIncompleteAttemptsForChapter(
      [{ chapterId: "c1", outcome: "repair_adopted", attemptCount: 3 }],
      "c1",
    ),
    0,
  );
});

test("countIncompleteAttemptsForChapter: budget_skipped 不计（被动跳过，未真尝试）", () => {
  assert.equal(
    countIncompleteAttemptsForChapter(
      [{ chapterId: "c1", outcome: "budget_skipped", attemptCount: 5 }],
      "c1",
    ),
    0,
  );
});

test("countIncompleteAttemptsForChapter: 只看该章最后一条", () => {
  const results = [
    { chapterId: "c1", outcome: "failed", attemptCount: 1 },
    { chapterId: "c2", outcome: "repair_incomplete", attemptCount: 9 },
    { chapterId: "c1", outcome: "repair_adopted" },
  ];
  assert.equal(countIncompleteAttemptsForChapter(results, "c1"), 0);
  assert.equal(countIncompleteAttemptsForChapter(results, "c2"), 9);
});

// Minor(b)：锁冲突判定收紧，避免正文/评语里的「锁」字被误记 skipped_locked（真失败被掩盖）

test("isChapterLockConflictMessage: 只认确定性锁冲突措辞", () => {
  assert.equal(isChapterLockConflictMessage("chapter repair lock held"), true);
  assert.equal(isChapterLockConflictMessage("repair in progress for chapter"), true);
  assert.equal(isChapterLockConflictMessage("章节修复进行中"), true);
  assert.equal(isChapterLockConflictMessage("并发修复被拒"), true);
});

test("isChapterLockConflictMessage: 正文/无关错误里的「锁」不误判", () => {
  assert.equal(isChapterLockConflictMessage("他把门锁上了，然后转身离开"), false);
  assert.equal(isChapterLockConflictMessage("deadlock detected in sqlite"), false);
  assert.equal(isChapterLockConflictMessage("readiness chapter step timeout: drainRepairStream"), false);
});

test("mapRepairOutcomeFromFrames: 含「锁」正文的 completed 帧不再误记 skipped_locked", () => {
  const mapped = mapRepairOutcomeFromFrames([{
    phase: "completed",
    status: "failed",
    message: "修复失败：生成内容里门锁描写重复",
  }]);
  assert.equal(mapped.outcome, "failed");
});

test("mapRepairOutcomeFromFrames: 真锁冲突仍记 skipped_locked", () => {
  const mapped = mapRepairOutcomeFromFrames([{
    phase: "completed",
    status: "failed",
    message: "chapter repair lock: another repair in progress",
  }]);
  assert.equal(mapped.outcome, "skipped_locked");
});
