const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPayoffLifecycleNodes,
} = require("../../shared/dist/types/payoffLedger.js");

test("buildPayoffLifecycleNodes marks setup→paid progression", () => {
  const setup = buildPayoffLifecycleNodes("setup");
  assert.equal(setup.filter((n) => n.reached).length, 1);
  assert.equal(setup.find((n) => n.current)?.stage, "setup");

  const hinted = buildPayoffLifecycleNodes("hinted");
  assert.deepEqual(hinted.filter((n) => n.reached).map((n) => n.stage), ["setup", "hinted"]);
  assert.equal(hinted.find((n) => n.current)?.stage, "hinted");

  const paid = buildPayoffLifecycleNodes("paid_off");
  assert.deepEqual(paid.map((n) => n.stage), ["setup", "hinted", "pending_payoff", "paid_off"]);
  assert.ok(paid.every((n) => n.reached));
  assert.equal(paid.find((n) => n.current)?.stage, "paid_off");
});

test("buildPayoffLifecycleNodes treats overdue/failed as branch terminals", () => {
  const overdue = buildPayoffLifecycleNodes("overdue");
  assert.equal(overdue.filter((n) => n.current).length, 1);
  assert.equal(overdue.find((n) => n.current)?.stage, "overdue");
  assert.ok(overdue.some((n) => n.stage === "pending_payoff" && n.reached && !n.current));

  const failed = buildPayoffLifecycleNodes("failed");
  assert.equal(failed.filter((n) => n.current).length, 1);
  assert.equal(failed.find((n) => n.current)?.stage, "failed");
});
