/**
 * Bug 2: DB 持久化的 length_under_hard open issue 若按当前 content 实测不再 under_hard,
 * 应被 repair resolver 丢弃——否则 LLM 拍的「约3200字」会让 repair 层去压缩实际 7000+ 字的章节。
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  dropStaleLengthUnderHardAuditIssues,
  ChapterRepairIssueResolver,
} = require("../dist/services/novel/runtime/repair/evaluation/ChapterRepairIssueResolver.js");

const FACTORY = {
  // 实测 6050 字符 vs target 8000 → band under_soft (非 under_hard)
  content: "字".repeat(6050),
  targetWordCount: 8000,
};

describe("dropStaleLengthUnderHardAuditIssues", () => {
  it("drops a persisted length_under_hard issue when measured length is NOT under_hard", () => {
    const issues = [{
      severity: "high",
      category: "pacing",
      evidence: "正文长度约3200字，不足目标长度8000字的六成，明显残缺。",
      fixSuggestion: "大幅扩充正文，使长度达到6800字以上。",
      code: "length_under_hard",
    }];
    const out = dropStaleLengthUnderHardAuditIssues(issues, FACTORY.content, FACTORY.targetWordCount);
    assert.deepEqual(out, [], "should drop the stale under_hard when actual >= hardMin");
  });

  it("keeps a genuine under_hard issue when actual content is truly under hardMin", () => {
    const issues = [{
      severity: "high",
      category: "pacing",
      evidence: "正文仅剩120字。",
      fixSuggestion: "必须扩写。",
      code: "length_under_hard",
    }];
    const out = dropStaleLengthUnderHardAuditIssues(issues, "字".repeat(120), 8000);
    assert.equal(out.length, 1);
    assert.equal(out[0].code, "length_under_hard");
  });

  it("keeps non-length issues untouched", () => {
    const issues = [{
      severity: "medium",
      category: "repetition",
      evidence: "多处重复句式。",
      fixSuggestion: "替换重复表达。",
      code: "REPETITION",
    }];
    const out = dropStaleLengthUnderHardAuditIssues(issues, FACTORY.content, FACTORY.targetWordCount);
    assert.equal(out.length, 1);
    assert.equal(out[0].code, "REPETITION");
  });

  it("keeps length_over issues regardless (over-length is not the false positive here)", () => {
    const issues = [{
      severity: "medium",
      category: "pacing",
      evidence: "正文过长，超过目标。",
      fixSuggestion: "压缩。",
      code: "length_over_hard",
    }];
    const out = dropStaleLengthUnderHardAuditIssues(issues, FACTORY.content, FACTORY.targetWordCount);
    assert.equal(out.length, 1);
  });
});

describe("ChapterRepairIssueResolver.resolve cache path (Bug 2)", () => {
  let originalFindFirsts;
  let resolver;

  before(() => {
    originalFindFirsts = {
      auditIssue: prisma.auditIssue.findMany,
      qualityReport: prisma.qualityReport.findFirst,
      chapter: prisma.chapter.findFirst,
    };
    resolver = new ChapterRepairIssueResolver(async () => ({ issues: [] }));
  });

  after(() => {
    prisma.auditIssue.findMany = originalFindFirsts.auditIssue;
    prisma.qualityReport.findFirst = originalFindFirsts.qualityReport;
    prisma.chapter.findFirst = originalFindFirsts.chapter;
  });

  it("drops stale under_hard from cached QualityReport issues when content is NOT under_hard", async () => {
    // 无 auditIssueIds → 走 QualityReport 缓存路径
    prisma.auditIssue.findMany = async () => [];
    prisma.qualityReport.findFirst = async () => ({
      issues: JSON.stringify([{
        severity: "high",
        category: "pacing",
        evidence: "正文长度约3200字，不足目标长度8000字的六成，明显残缺。",
        fixSuggestion: "大幅扩充正文。",
        code: "length_under_hard",
      }]),
    });
    prisma.chapter.findFirst = async () => ({
      content: FACTORY.content,
      targetWordCount: FACTORY.targetWordCount,
    });

    const issues = await resolver.resolve("n1", "c1", {});
    assert.deepEqual(issues, [], "cached stale under_hard should be filtered");
  });
});