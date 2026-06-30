const test = require("node:test");
const assert = require("node:assert/strict");

const { selectDeletableTaskIds } = require("../dist/services/task/TaskRetentionService.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const CFG = { keepPerNovel: 20, succeededDays: 7, failedDays: 30 };
const NOW = new Date("2026-07-01T00:00:00.000Z");

function row(overrides = {}) {
  return {
    id: overrides.id ?? `task-${Math.random().toString(16).slice(2)}`,
    // use "in" check so explicit novelId: null is honored (?? would coerce it back)
    novelId: "novelId" in overrides ? overrides.novelId : "novel-1",
    status: overrides.status ?? "succeeded",
    finishedAt: overrides.finishedAt ?? null,
    updatedAt: overrides.updatedAt ?? new Date(NOW.getTime() - 10 * DAY_MS),
  };
}

function ageDays(days) {
  return new Date(NOW.getTime() - days * DAY_MS);
}

test("keep-window: 25 succeeded rows all 10 days old -> only oldest 5 deletable", () => {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    // newer index = more recent finishedAt; i=0 newest, i=24 oldest
    rows.push(row({ id: `t${i}`, finishedAt: ageDays(10 + i * 0.01) }));
  }
  const deletable = selectDeletableTaskIds(rows, NOW, CFG);
  assert.equal(deletable.length, 5);
  // the 5 oldest are t20..t24
  assert.deepEqual(deletable.sort(), ["t20", "t21", "t22", "t23", "t24"].sort());
});

test("per-status age: succeeded/cancelled 8 days beyond window deletable, 6 days kept", () => {
  // 21 rows so index 20 is beyond keep-window
  const base = [];
  for (let i = 0; i < 20; i++) {
    base.push(row({ id: `keep${i}`, finishedAt: ageDays(1 + i * 0.01) }));
  }
  const old8 = row({ id: "succ8", status: "succeeded", finishedAt: ageDays(8) });
  const deletable8 = selectDeletableTaskIds([...base, old8], NOW, CFG);
  assert.ok(deletable8.includes("succ8"));

  const young6 = row({ id: "succ6", status: "succeeded", finishedAt: ageDays(6) });
  const deletable6 = selectDeletableTaskIds([...base, young6], NOW, CFG);
  assert.ok(!deletable6.includes("succ6"));

  const cancelled8 = row({ id: "canc8", status: "cancelled", finishedAt: ageDays(8) });
  const deletableCanc = selectDeletableTaskIds([...base, cancelled8], NOW, CFG);
  assert.ok(deletableCanc.includes("canc8"));
});

test("failed status uses 30-day window: 8 days kept, 31 days deletable", () => {
  const base = [];
  for (let i = 0; i < 20; i++) {
    base.push(row({ id: `keep${i}`, status: "failed", finishedAt: ageDays(1 + i * 0.01) }));
  }
  const failed8 = row({ id: "fail8", status: "failed", finishedAt: ageDays(8) });
  const d8 = selectDeletableTaskIds([...base, failed8], NOW, CFG);
  assert.ok(!d8.includes("fail8"), "failed at 8 days should be kept");

  const failed31 = row({ id: "fail31", status: "failed", finishedAt: ageDays(31) });
  const d31 = selectDeletableTaskIds([...base, failed31], NOW, CFG);
  assert.ok(d31.includes("fail31"), "failed at 31 days should be deletable");
});

test("null novelId rows age out in their own bucket, isolated from other novels", () => {
  // novel-1 has 20 recent rows (fills keep-window), plus 1 null-novel old row
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(row({ id: `n1-${i}`, novelId: "novel-1", finishedAt: ageDays(1 + i * 0.01) }));
  }
  const nullOld = row({ id: "null-old", novelId: null, finishedAt: ageDays(10) });
  const deletable = selectDeletableTaskIds([...rows, nullOld], NOW, CFG);
  // null bucket has only 1 row -> within keep-window -> NOT deletable
  assert.ok(!deletable.includes("null-old"));

  // now make null bucket have 21 rows so index 20 ages out
  const nullRows = [];
  for (let i = 0; i < 21; i++) {
    nullRows.push(row({ id: `null-${i}`, novelId: null, finishedAt: ageDays(10 + i * 0.01) }));
  }
  const deletable2 = selectDeletableTaskIds(nullRows, NOW, CFG);
  assert.equal(deletable2.length, 1, "21st null-novel row should age out");
  assert.equal(deletable2[0], "null-20");
});

test("multi-novel isolation: keep-20 applies per novel, not globally", () => {
  const rows = [];
  // novel-A: 21 rows -> 1 ages out
  for (let i = 0; i < 21; i++) {
    rows.push(row({ id: `A${i}`, novelId: "novel-A", finishedAt: ageDays(10 + i * 0.01) }));
  }
  // novel-B: 21 rows -> 1 ages out
  for (let i = 0; i < 21; i++) {
    rows.push(row({ id: `B${i}`, novelId: "novel-B", finishedAt: ageDays(10 + i * 0.01) }));
  }
  const deletable = selectDeletableTaskIds(rows, NOW, CFG);
  assert.equal(deletable.length, 2);
  assert.deepEqual(deletable.sort(), ["A20", "B20"].sort());
});

test("falls back to updatedAt when finishedAt is null", () => {
  const base = [];
  for (let i = 0; i < 20; i++) {
    base.push(row({ id: `keep${i}`, finishedAt: ageDays(1 + i * 0.01) }));
  }
  // old row with null finishedAt but old updatedAt
  const oldByUpdate = row({ id: "byUpdate", finishedAt: null, updatedAt: ageDays(8) });
  const deletable = selectDeletableTaskIds([...base, oldByUpdate], NOW, CFG);
  assert.ok(deletable.includes("byUpdate"));
});

test("keepPerNovel = 0 ages out every terminal row past its window", () => {
  const cfg = { keepPerNovel: 0, succeededDays: 7, failedDays: 30 };
  const rows = [
    row({ id: "old-succ", status: "succeeded", finishedAt: ageDays(8) }),
    row({ id: "young-succ", status: "succeeded", finishedAt: ageDays(3) }),
    row({ id: "old-fail", status: "failed", finishedAt: ageDays(40) }),
  ];
  const deletable = selectDeletableTaskIds(rows, NOW, cfg);
  // young-succ still within 7-day window even with keep 0; failed beyond 30d
  assert.deepEqual(deletable.sort(), ["old-fail", "old-succ"].sort());
});

test("identical timestamps produce a deterministic deletion set via id tiebreaker", () => {
  const sameTime = ageDays(10);
  const make = () => {
    const rows = [];
    for (let i = 0; i < 22; i++) {
      rows.push(row({ id: `t${String(i).padStart(2, "0")}`, finishedAt: sameTime }));
    }
    return rows;
  };
  const first = selectDeletableTaskIds(make(), NOW, CFG);
  const second = selectDeletableTaskIds(make().reverse(), NOW, CFG);
  // 22 rows, keep 20 -> exactly 2 deletable, same set regardless of input order
  assert.equal(first.length, 2);
  assert.deepEqual(first.sort(), second.sort());
  // same timestamp -> id ascending tiebreaker; keep t00..t19, delete t20/t21
  assert.deepEqual(first.sort(), ["t20", "t21"]);
});
