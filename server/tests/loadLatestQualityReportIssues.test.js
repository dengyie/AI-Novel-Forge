/**
 * resolveRepairIssues 优先复用 QualityReport.issues，避免 repair 入口再烧 full audit。
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  loadLatestQualityReportIssues,
} = require("../dist/services/novel/runtime/repair/ChapterRepairStreamRuntime.js");

describe("loadLatestQualityReportIssues", () => {
  let originalFindFirst;

  before(() => {
    originalFindFirst = prisma.qualityReport.findFirst;
  });

  after(() => {
    prisma.qualityReport.findFirst = originalFindFirst;
  });

  it("returns null when no report / empty issues", async () => {
    prisma.qualityReport.findFirst = async () => null;
    assert.equal(await loadLatestQualityReportIssues("n1", "c1"), null);

    prisma.qualityReport.findFirst = async () => ({ issues: null });
    assert.equal(await loadLatestQualityReportIssues("n1", "c1"), null);

    prisma.qualityReport.findFirst = async () => ({ issues: "[]" });
    assert.equal(await loadLatestQualityReportIssues("n1", "c1"), null);
  });

  it("normalizes valid ReviewIssue rows and drops garbage", async () => {
    prisma.qualityReport.findFirst = async () => ({
      issues: JSON.stringify([
        {
          severity: "high",
          category: "coherence",
          evidence: "主线断点未收",
          fixSuggestion: "补收束",
          code: "LOGIC_GAP",
        },
        { severity: "nope", category: "coherence", evidence: "bad sev" },
        { severity: "medium", category: "pacing", evidence: "  ", fixSuggestion: "x" },
        {
          severity: "critical",
          category: "logic",
          evidence: "角色状态冲突",
          fixSuggestion: "",
        },
      ]),
    });
    const issues = await loadLatestQualityReportIssues("n1", "c1");
    assert.ok(issues);
    assert.equal(issues.length, 2);
    assert.equal(issues[0].severity, "high");
    assert.equal(issues[0].code, "LOGIC_GAP");
    assert.equal(issues[1].severity, "critical");
    assert.ok(issues[1].fixSuggestion.length > 0);
  });

  it("returns null on JSON parse error", async () => {
    prisma.qualityReport.findFirst = async () => ({ issues: "{not-json" });
    assert.equal(await loadLatestQualityReportIssues("n1", "c1"), null);
  });
});
