import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import { prisma } from "../../../../../db/prisma";
import { evaluateLengthBudget } from "@ai-novel/shared/types/chapterLengthControl";
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

const UNDER_LENGTH_AUDIT_CODES = new Set([
  "length_under_hard",
  "length_under_soft",
  "LENGTH_UNDER_HARD_MAX",
  "LENGTH_UNDER_SOFT_MIN",
]);

/**
 * Bug 2: 持久化的 open length_under_hard audit issue 是 LLM 在审计时按拍头的数字
 * （「约3200字」）判的，正文实际可能已 7000+。resolve 复用这些 DB issue 时，
 * 若按「当前 content + targetWordCount」确定性实测已不再 under_hard，则丢弃它，
 * 避免 repair 层被 LLM 拍的假数字误触发压缩。
 * 无 targetWordCount（无长度合同）时保守丢弃 under 系 code —— 没有合同就谈不上长度门。
 */
export interface ReviewAuditIssue extends ReviewIssue {
  code?: string;
}

export function dropStaleLengthUnderHardAuditIssues(
  issues: ReviewAuditIssue[],
  content: string,
  targetWordCount: number | null | undefined,
): ReviewAuditIssue[] {
  if (!Array.isArray(issues) || issues.length === 0) {
    return issues;
  }
  return issues.filter((issue) => {
    const code = String(issue.code ?? "").trim();
    const isUnderLengthAuditIssue = code
      ? UNDER_LENGTH_AUDIT_CODES.has(code)
      : false;
    if (!isUnderLengthAuditIssue) {
      return true;
    }
    const evalResult = evaluateLengthBudget({ content, targetWordCount });
    // 无合同 → 无长度门 → 认为 under 系 issue 不可信（假阳性）
    if (!evalResult) {
      return false;
    }
    return evalResult.band === "under_hard";
  });
}

/**
 * 按当前正文确定性复核 under 系长度门（Bug 2 共用过滤）。
 * 查不到正文/合同信息时保守丢弃 under 系——无长度合同就谈不上长度门。
 */
async function filterWithChapterContract(
  issues: ReviewAuditIssue[],
  novelId: string,
  chapterId: string,
): Promise<ReviewAuditIssue[]> {
  let chapter = null;
  try {
    chapter = await prisma.chapter.findFirst({ where: { id: chapterId, novelId } });
  } catch {
    return dropStaleLengthUnderHardAuditIssues(issues, "", null);
  }
  return dropStaleLengthUnderHardAuditIssues(
    issues,
    chapter?.content ?? "",
    chapter?.targetWordCount ?? null,
  );
}

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
      const mapped: ReviewAuditIssue[] = auditIssues.map((item) => ({
        severity: item.severity as ReviewIssue["severity"],
        category: item.auditType === "continuity"
          ? "coherence"
          : item.auditType === "character" ? "logic" : "pacing",
        evidence: item.evidence,
        fixSuggestion: item.fixSuggestion,
        ...(item.code ? { code: item.code } : {}),
      }));
      // Bug 2: 按当前正文确定性复核长度门，丢弃 LLM 拍数字产生的 stale under_hard 假阳性。
      return filterWithChapterContract(mapped, novelId, chapterId);
    }
    const cachedIssues = await loadLatestQualityReportIssues(novelId, chapterId);
    if (cachedIssues && cachedIssues.length > 0) {
      const filtered = await filterWithChapterContract(cachedIssues, novelId, chapterId);
      logPipelineInfo("resolveRepairIssues: reusing QualityReport issues (skip full audit).", {
        novelId,
        chapterId,
        operation: "repair",
        provider: options.provider ?? null,
        model: options.model ?? null,
        issueCount: filtered.length,
      });
      return filtered;
    }
    const fallbackReview = await this.reviewChapterAfterRepair(novelId, chapterId, {
      ...options,
      skipPayoffLedgerSync: true,
      evaluateOnly: true,
    });
    return fallbackReview.issues;
  }
}
