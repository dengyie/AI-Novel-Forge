const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveM4bWorkerId } = require("../dist/services/audiobook/m4b/M4bWorkerIdentity.js");

test("m4b queue ownership uses the actual worker PID", () => {
  assert.equal(resolveM4bWorkerId(4821), "4821");
  assert.notEqual(resolveM4bWorkerId(4821), "1500", "the API parent PID must never be recorded as worker ownership");
});
