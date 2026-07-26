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

/**
 * readiness plan.reasons → 最小 ReviewIssue 种子。
 * 给 heavy/light repair 入口跳过 resolveRepairIssues 的 full critical_review
 * （单次可达 600s+fallback 600s，曾把 15m 章钟烧穿在 createRepairStream）。
 * adopt 仍走 baseline/candidate evaluateOnly，不靠种子做 L1 判定。
 */
export function buildSeedReviewIssuesFromPlanReasons(
  reasons: string[] | null | undefined,
  maxIssues = 8,
): ReviewIssueWithCode[] {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return [];
  }
  const issues: ReviewIssueWithCode[] = [];
  for (const raw of reasons) {
    if (issues.length >= maxIssues) {
      break;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      continue;
    }
    const lower = text.toLowerCase();
    const category: ReviewIssue["category"] =
      /重复|套话|垫长|pad|repetition/.test(lower)
        ? "repetition"
        : /节奏|pacing|拖沓|注水/.test(lower)
          ? "pacing"
          : /人物|角色|character|逻辑|logic/.test(lower)
            ? "logic"
            : /文风|voice|口吻|人称/.test(lower)
              ? "voice"
              : /吸引力|engagement|爽点/.test(lower)
                ? "engagement"
                : "coherence";
    const severity: ReviewIssue["severity"] =
      /critical|严重|硬伤|L0|blocking|不可/.test(lower)
        ? "critical"
        : /high|高|未过|fail|literary|文学性/.test(lower)
          ? "high"
          : "medium";
    issues.push({
      code: "readiness_plan_reason",
      severity,
      category,
      evidence: text.length > 400 ? `${text.slice(0, 400)}…` : text,
      fixSuggestion: "按 readiness 判定原因定向修复硬伤与未过门项，保持剧情方向与角色状态。",
    });
  }
  return issues;
}
