const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectDeletableTaskIds,
  selectSupersededTaskIds,
  selectSupersededGenerationJobIds,
} = require("../dist/services/task/TaskRetentionService.js");

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

// --- selectSupersededTaskIds ---

const SUPERSEDE_CFG = { supersededMinAgeMs: 0 };

function laneRow(overrides = {}) {
  return {
    id: overrides.id ?? `task-${Math.random().toString(16).slice(2)}`,
    novelId: "novelId" in overrides ? overrides.novelId : "novel-1",
    lane: overrides.lane ?? "auto_director",
    status: overrides.status ?? "failed",
    finishedAt: overrides.finishedAt ?? ageDays(1),
    updatedAt: overrides.updatedAt ?? ageDays(1),
  };
}

test("supersede: terminal tasks are deletable when bucket has an active task", () => {
  const rows = [
    laneRow({ id: "running", status: "running" }),
    laneRow({ id: "failed-1", status: "failed" }),
    laneRow({ id: "cancelled-1", status: "cancelled" }),
    laneRow({ id: "succeeded-1", status: "succeeded" }),
  ];
  const deletable = selectSupersededTaskIds(rows, NOW, SUPERSEDE_CFG);
  // the active task itself is never deleted; all 3 terminal ones are
  assert.deepEqual(deletable.sort(), ["cancelled-1", "failed-1", "succeeded-1"]);
});

test("supersede: lone terminal task with no active sibling is NOT deletable", () => {
  const rows = [
    laneRow({ id: "failed-only", status: "failed" }),
    laneRow({ id: "cancelled-only", status: "cancelled" }),
  ];
  const deletable = selectSupersededTaskIds(rows, NOW, SUPERSEDE_CFG);
  assert.equal(deletable.length, 0, "no active task -> nothing superseded");
});

test("supersede: active task itself (queued/running/waiting_approval) is never selected", () => {
  for (const active of ["queued", "running", "waiting_approval"]) {
    const rows = [
      laneRow({ id: "active", status: active }),
      laneRow({ id: "another-active", status: "running" }),
    ];
    const deletable = selectSupersededTaskIds(rows, NOW, SUPERSEDE_CFG);
    assert.ok(!deletable.includes("active"), `${active} should never be superseded`);
    assert.ok(!deletable.includes("another-active"), "running should never be superseded");
  }
});

test("supersede: only auto_director lane is affected", () => {
  const rows = [
    laneRow({ id: "ad-running", lane: "auto_director", status: "running" }),
    laneRow({ id: "ad-failed", lane: "auto_director", status: "failed" }),
    laneRow({ id: "manual-running", lane: "manual_create", status: "running" }),
    laneRow({ id: "manual-failed", lane: "manual_create", status: "failed" }),
  ];
  const deletable = selectSupersededTaskIds(rows, NOW, SUPERSEDE_CFG);
  // manual_create lane skipped entirely; only the auto_director failed is removed
  assert.deepEqual(deletable, ["ad-failed"]);
});

test("supersede: buckets are isolated per novel", () => {
  const rows = [
    // novel-A has an active task -> its failed is superseded
    laneRow({ id: "A-running", novelId: "novel-A", status: "running" }),
    laneRow({ id: "A-failed", novelId: "novel-A", status: "failed" }),
    // novel-B has only a failed task, no active -> kept
    laneRow({ id: "B-failed", novelId: "novel-B", status: "failed" }),
  ];
  const deletable = selectSupersededTaskIds(rows, NOW, SUPERSEDE_CFG);
  assert.deepEqual(deletable, ["A-failed"]);
});

test("supersede: null novelId is its own bucket", () => {
  const rows = [
    laneRow({ id: "null-running", novelId: null, status: "running" }),
    laneRow({ id: "null-failed", novelId: null, status: "failed" }),
    // a different (non-null) novel's lone failed must not borrow the null bucket's active
    laneRow({ id: "other-failed", novelId: "novel-X", status: "failed" }),
  ];
  const deletable = selectSupersededTaskIds(rows, NOW, SUPERSEDE_CFG);
  assert.deepEqual(deletable, ["null-failed"]);
});

test("supersede: minAgeMs keeps recently-finished terminal tasks", () => {
  const cfg = { supersededMinAgeMs: 10 * 60 * 1000 }; // 10 min
  const rows = [
    laneRow({ id: "running", status: "running" }),
    // finished 5 min ago -> within min-age window -> kept this cycle
    laneRow({ id: "fresh-failed", status: "failed", finishedAt: new Date(NOW.getTime() - 5 * 60 * 1000) }),
    // finished 20 min ago -> past window -> deletable
    laneRow({ id: "old-failed", status: "failed", finishedAt: new Date(NOW.getTime() - 20 * 60 * 1000) }),
  ];
  const deletable = selectSupersededTaskIds(rows, NOW, cfg);
  assert.deepEqual(deletable, ["old-failed"]);
});

test("supersede: output is deterministic regardless of input order", () => {
  const make = () => [
    laneRow({ id: "running", status: "running" }),
    laneRow({ id: "t-c", status: "cancelled" }),
    laneRow({ id: "t-a", status: "failed" }),
    laneRow({ id: "t-b", status: "succeeded" }),
  ];
  const first = selectSupersededTaskIds(make(), NOW, SUPERSEDE_CFG);
  const second = selectSupersededTaskIds(make().reverse(), NOW, SUPERSEDE_CFG);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["t-a", "t-b", "t-c"]);
});

// --- selectSupersededGenerationJobIds ---

function jobRow(overrides = {}) {
  return {
    id: overrides.id ?? `job-${Math.random().toString(16).slice(2)}`,
    novelId: "novelId" in overrides ? overrides.novelId : "novel-1",
    status: overrides.status ?? "failed",
    finishedAt: overrides.finishedAt ?? ageDays(1),
    updatedAt: overrides.updatedAt ?? ageDays(1),
  };
}

test("pipeline supersede: terminal jobs deletable when bucket has an active pipeline job", () => {
  const rows = [
    jobRow({ id: "running", status: "running" }),
    jobRow({ id: "failed-1", status: "failed" }),
    jobRow({ id: "succeeded-1", status: "succeeded" }),
    jobRow({ id: "cancelled-1", status: "cancelled" }),
  ];
  const deletable = selectSupersededGenerationJobIds(rows, new Set(), NOW, SUPERSEDE_CFG);
  assert.deepEqual(deletable.sort(), ["cancelled-1", "failed-1", "succeeded-1"]);
});

test("pipeline supersede: active auto_director takeover supersedes terminal pipeline jobs", () => {
  // no active pipeline job, but novel-1 has an active takeover -> terminal jobs still superseded
  const rows = [
    jobRow({ id: "failed-1", status: "failed" }),
    jobRow({ id: "succeeded-1", status: "succeeded" }),
  ];
  const deletable = selectSupersededGenerationJobIds(rows, new Set(["novel-1"]), NOW, SUPERSEDE_CFG);
  assert.deepEqual(deletable.sort(), ["failed-1", "succeeded-1"]);
});

test("pipeline supersede: lone terminal job with no active sibling and no takeover is NOT deletable", () => {
  const rows = [jobRow({ id: "failed-only", status: "failed" })];
  const deletable = selectSupersededGenerationJobIds(rows, new Set(), NOW, SUPERSEDE_CFG);
  assert.equal(deletable.length, 0);
});

test("pipeline supersede: active job itself is never selected", () => {
  for (const active of ["queued", "running", "waiting_approval"]) {
    const rows = [
      jobRow({ id: "active", status: active }),
      jobRow({ id: "failed-1", status: "failed" }),
    ];
    const deletable = selectSupersededGenerationJobIds(rows, new Set(), NOW, SUPERSEDE_CFG);
    assert.ok(!deletable.includes("active"), `${active} should never be superseded`);
    assert.deepEqual(deletable, ["failed-1"]);
  }
});

test("pipeline supersede: buckets are isolated per novel", () => {
  const rows = [
    jobRow({ id: "A-running", novelId: "novel-A", status: "running" }),
    jobRow({ id: "A-failed", novelId: "novel-A", status: "failed" }),
    // novel-B has only a failed job, no active pipeline and no takeover -> kept
    jobRow({ id: "B-failed", novelId: "novel-B", status: "failed" }),
  ];
  const deletable = selectSupersededGenerationJobIds(rows, new Set(), NOW, SUPERSEDE_CFG);
  assert.deepEqual(deletable, ["A-failed"]);
});

test("pipeline supersede: takeover on a different novel does not leak into other buckets", () => {
  const rows = [
    jobRow({ id: "A-failed", novelId: "novel-A", status: "failed" }),
    jobRow({ id: "B-failed", novelId: "novel-B", status: "failed" }),
  ];
  // takeover active only for novel-B -> only B's failed job is superseded
  const deletable = selectSupersededGenerationJobIds(rows, new Set(["novel-B"]), NOW, SUPERSEDE_CFG);
  assert.deepEqual(deletable, ["B-failed"]);
});

test("pipeline supersede: null novelId is its own bucket (takeover never applies to null)", () => {
  const rows = [
    jobRow({ id: "null-running", novelId: null, status: "running" }),
    jobRow({ id: "null-failed", novelId: null, status: "failed" }),
    jobRow({ id: "other-failed", novelId: "novel-X", status: "failed" }),
  ];
  // even if a takeover exists for some novel, null bucket only borrows its own active job
  const deletable = selectSupersededGenerationJobIds(rows, new Set("novel-X"), NOW, SUPERSEDE_CFG);
  assert.deepEqual(deletable, ["null-failed"]);
});

test("pipeline supersede: minAgeMs keeps recently-finished terminal jobs", () => {
  const cfg = { supersededMinAgeMs: 10 * 60 * 1000 };
  const rows = [
    jobRow({ id: "running", status: "running" }),
    jobRow({ id: "fresh-failed", status: "failed", finishedAt: new Date(NOW.getTime() - 5 * 60 * 1000) }),
    jobRow({ id: "old-failed", status: "failed", finishedAt: new Date(NOW.getTime() - 20 * 60 * 1000) }),
  ];
  const deletable = selectSupersededGenerationJobIds(rows, new Set(), NOW, cfg);
  assert.deepEqual(deletable, ["old-failed"]);
});

test("pipeline supersede: output is deterministic regardless of input order", () => {
  const make = () => [
    jobRow({ id: "running", status: "running" }),
    jobRow({ id: "t-c", status: "cancelled" }),
    jobRow({ id: "t-a", status: "failed" }),
    jobRow({ id: "t-b", status: "succeeded" }),
  ];
  const first = selectSupersededGenerationJobIds(make(), new Set(), NOW, SUPERSEDE_CFG);
  const second = selectSupersededGenerationJobIds(make().reverse(), new Set(), NOW, SUPERSEDE_CFG);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["t-a", "t-b", "t-c"]);
});
