const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  inspectPrismaRuntime,
  REQUIRED_FIELDS,
} = require("../../scripts/deploy/prisma-runtime-probe.cjs");

test("Prisma runtime probe reports the required AudiobookTask field without touching the database", () => {
  const report = inspectPrismaRuntime({
    requireFrom: path.resolve(__dirname, ".."),
    requiredFields: REQUIRED_FIELDS,
  });

  assert.equal(report.ok, true);
  assert.equal(report.provider, "sqlite");
  assert.equal(report.models.AudiobookTask.fields.m4bGenerationToken, true);
  assert.match(report.clientPath, /@prisma[\/]client[\/]default\.js$/);
  assert.match(report.generatedClientHash, /^[a-f0-9]{64}$/);
});

test("Prisma runtime probe fails closed when a required field is absent", () => {
  assert.throws(
    () => inspectPrismaRuntime({
      requireFrom: path.resolve(__dirname, ".."),
      requiredFields: [{ model: "AudiobookTask", field: "field_that_cannot_exist" }],
    }),
    /missing required Prisma runtime fields/,
  );
});
