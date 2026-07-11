const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectDeletableTaskIds,
  selectSupersededTaskIds,
  selectSupersededGenerationJobIds,
} = require("../dist/services/task/TaskRetentionService.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const CFG = { keepPerNovel: 20, succeededDays: 7, failedDays: 30, supersededMinAgeMs: 0 };
const NOW = new Date("2026-07-01T00:00:00.000Z");

function ageDays(days) {
  return new Date(NOW.getTime() - days * DAY_MS);
}

test("supersede pushdown candidate set: only novels with active need terminal siblings", () => {
  // 模拟下推后的候选集：仅 active + 同 novel 终态，不应包含无关 novel 的终态
  const active = {
    id: "active-1",
    novelId: "novel-A",
    lane: "auto_director",
    status: "running",
    finishedAt: null,
    updatedAt: NOW,
  };
  const terminalSame = {
    id: "term-A",
    novelId: "novel-A",
    lane: "auto_director",
    status: "failed",
    finishedAt: ageDays(1),
    updatedAt: ageDays(1),
  };
  const terminalOther = {
    id: "term-B",
    novelId: "novel-B",
    lane: "auto_director",
    status: "failed",
    finishedAt: ageDays(1),
    updatedAt: ageDays(1),
  };

  // 下推后的查询结果不应包含 novel-B（无 active）
  const pushedDownRows = [active, terminalSame];
  const ids = selectSupersededTaskIds(pushedDownRows, NOW, CFG);
  assert.deepEqual(ids, ["term-A"]);

  // 若错误地全表扫描混入 novel-B 终态但无 active，也不应删
  const withOrphan = [...pushedDownRows, terminalOther];
  const ids2 = selectSupersededTaskIds(withOrphan, NOW, CFG);
  assert.deepEqual(ids2, ["term-A"]);
  assert.ok(!ids2.includes("term-B"));
});

test("pipeline supersede pushdown respects active takeover novel set", () => {
  const activeTakeover = new Set(["novel-A"]);
  const rows = [
    {
      id: "pipe-old",
      novelId: "novel-A",
      status: "failed",
      finishedAt: ageDays(2),
      updatedAt: ageDays(2),
    },
    {
      id: "pipe-other",
      novelId: "novel-B",
      status: "failed",
      finishedAt: ageDays(2),
      updatedAt: ageDays(2),
    },
  ];
  // 下推后只加载 novel-A 终态 + active pipeline
  const pushed = rows.filter((row) => activeTakeover.has(row.novelId));
  const ids = selectSupersededGenerationJobIds(pushed, activeTakeover, NOW, CFG);
  assert.deepEqual(ids, ["pipe-old"]);
});

test("age selector keep-window still holds for pure-JS fallback parity", () => {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({
      id: `t${i}`,
      novelId: "novel-1",
      status: "succeeded",
      finishedAt: ageDays(10 + i * 0.01),
      updatedAt: ageDays(10 + i * 0.01),
    });
  }
  const deletable = selectDeletableTaskIds(rows, NOW, CFG);
  assert.equal(deletable.length, 5);
});
