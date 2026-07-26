import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import { prisma } from "../../../../../db/prisma";
import type { RepairOptions } from "../../../novelCoreShared";
import { logPipelineInfo } from "../../../novelCoreShared";
import type { ReviewChapterAfterRepair } from "./ChapterRepairBaselineEvaluator";

const REVIEW_ISSUE_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const REVIEW_ISSUE_CATEGORIES = new Set([
  "coherence",
  "repetition",
  "pacing",
  "voice",
  "engagement",
  "logic",
]);

export async function loadLatestQualityReportIssues(
  novelId: string,
  chapterId: string,
): Promise<ReviewIssue[] | null> {
  try {
    const report = await prisma.qualityReport.findFirst({
      where: { novelId, chapterId },
      orderBy: { createdAt: "desc" },
      select: { issues: true },
    });
    if (!report?.issues?.trim()) return null;
    const parsed = JSON.parse(report.issues) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const normalized: ReviewIssue[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const severity = typeof item.severity === "string" ? item.severity : "";
      const category = typeof item.category === "string" ? item.category : "";
      const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
      const fixSuggestion = typeof item.fixSuggestion === "string" ? item.fixSuggestion.trim() : "";
      if (
        !REVIEW_ISSUE_SEVERITIES.has(severity)
        || !REVIEW_ISSUE_CATEGORIES.has(category)
        || !evidence
      ) {
        continue;
      }
      const issue: ReviewIssue & { code?: string } = {
        severity: severity as ReviewIssue["severity"],
        category: category as ReviewIssue["category"],
        evidence,
        fixSuggestion: fixSuggestion || "按 evidence 定向修复，保持剧情方向与角色状态。",
      };
      if (typeof item.code === "string" && item.code.trim()) {
        issue.code = item.code.trim();
      }
      normalized.push(issue);
    }
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

export class ChapterRepairIssueResolver {
  constructor(private readonly reviewChapterAfterRepair: ReviewChapterAfterRepair) {}

  async resolve(
    novelId: string,
    chapterId: string,
    options: RepairOptions,
  ): Promise<ReviewIssue[]> {
    if (Array.isArray(options.reviewIssues)) return options.reviewIssues;
    const auditIssues = options.auditIssueIds?.length
      ? await prisma.auditIssue.findMany({
        where: { id: { in: options.auditIssueIds } },
        orderBy: { createdAt: "asc" },
      })
      : [];
    if (auditIssues.length > 0) {
      return auditIssues.map((item) => ({
        severity: item.severity as ReviewIssue["severity"],
        category: item.auditType === "continuity"
          ? "coherence"
          : item.auditType === "character" ? "logic" : "pacing",
        evidence: item.evidence,
        fixSuggestion: item.fixSuggestion,
      }));
    }
    const cachedIssues = await loadLatestQualityReportIssues(novelId, chapterId);
    if (cachedIssues && cachedIssues.length > 0) {
      logPipelineInfo("resolveRepairIssues: reusing QualityReport issues (skip full audit).", {
        novelId,
        chapterId,
        operation: "repair",
        provider: options.provider ?? null,
        model: options.model ?? null,
        issueCount: cachedIssues.length,
      });
      return cachedIssues;
    }
    const fallbackReview = await this.reviewChapterAfterRepair(novelId, chapterId, {
      ...options,
      skipPayoffLedgerSync: true,
      evaluateOnly: true,
    });
    return fallbackReview.issues;
  }
}
