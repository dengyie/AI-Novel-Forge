/**
 * 将正文垫长/套话 findings 投影为 RepairOptions.reviewIssues，
 * 让 light_repair 段内定向清 pad，而不是只靠 generic review issues。
 */

import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import { detectProseQuality } from "../runtime/proseQuality/ProseQualityDetector";

/** ReviewIssue 允许附带 code（repair L1 / 日志用）；shared 类型未声明但运行时广泛使用。 */
export type ReviewIssueWithCode = ReviewIssue & { code?: string };

/**
 * 从正文扫 pad phrase → ReviewIssue 列表（最多 maxIssues 条）。
 * 无命中返回 []。
 */
export function buildPadReviewIssuesFromContent(
  content: string,
  maxIssues = 12,
): ReviewIssueWithCode[] {
  if (!content || !content.trim()) {
    return [];
  }
  const report = detectProseQuality(content);
  const padFindings = report.findings.filter((finding) => finding.code === "prose_pad_phrase");
  if (padFindings.length === 0) {
    return [];
  }

  const issues: ReviewIssueWithCode[] = [];
  for (const finding of padFindings) {
    if (issues.length >= maxIssues) {
      break;
    }
    const severity: ReviewIssue["severity"] =
      finding.severity === "critical" || finding.severity === "high"
        ? "high"
        : finding.severity === "medium"
          ? "medium"
          : "low";
    issues.push({
      code: "prose_pad_phrase",
      severity,
      category: "repetition",
      evidence: finding.excerpt
        ? `L${finding.line}: ${finding.message}｜摘录：${finding.excerpt}`
        : `L${finding.line}: ${finding.message}`,
      fixSuggestion: finding.fixSuggestion
        || "删减或改写重复过渡套话，改用具体动作/环境/对话推进。",
    });
  }
  return issues;
}

/**
 * 合并 pad issues 与已有 issues：同 code+evidence 去重，pad 置前（优先定向）。
 */
export function mergeReviewIssuesPreferPad(
  padIssues: ReviewIssueWithCode[],
  existing: ReviewIssueWithCode[],
): ReviewIssueWithCode[] {
  if (padIssues.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return padIssues;
  }
  const seen = new Set<string>();
  const out: ReviewIssueWithCode[] = [];
  for (const issue of [...padIssues, ...existing]) {
    const key = `${issue.code ?? ""}|${issue.evidence}|${issue.fixSuggestion}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(issue);
  }
  return out;
}
