import type { ChapterRuntimePackage } from "@ai-novel/shared/types/chapterRuntime";
import type { QualityFeedbackPacket } from "@ai-novel/shared/types/qualityFeedback";
import type { ReviewIssue } from "@ai-novel/shared/types/novel";

export interface RepairQualityFeedbackSummary {
  signature: string;
  rootCause: QualityFeedbackPacket["rootCause"];
  severity: QualityFeedbackPacket["severity"];
  codes: string[];
  evidence: string[];
  mustFix: string[];
  planHints: string[];
  failedPatchCount: number;
  avoidRetry: boolean;
  evaluatedAt: string;
}

export function resolveRepairIssueCodes(
  runtimePackage: ChapterRuntimePackage | null | undefined,
  auditOpenIssueCodes?: string[] | null,
): string[] {
  return Array.from(new Set([
    ...(runtimePackage?.audit.openIssues
      ?.map((issue) => issue.code)
      .filter((code): code is string => typeof code === "string" && code.trim().length > 0)
      ?? []),
    ...(Array.isArray(auditOpenIssueCodes)
      ? auditOpenIssueCodes.filter((code): code is string => typeof code === "string" && code.trim().length > 0)
      : []),
  ]));
}

/**
 * Keep only the latest packet: repair needs current actionable guidance, not a
 * replay of historical feedback that can drown out the current issue list.
 */
export function summarizeRepairQualityFeedback(
  feedback: QualityFeedbackPacket[] | null | undefined,
): RepairQualityFeedbackSummary[] {
  const latest = feedback?.at(-1);
  if (!latest) {
    return [];
  }
  return [{
    signature: latest.signature,
    rootCause: latest.rootCause,
    severity: latest.severity,
    codes: latest.codes.slice(0, 8),
    evidence: latest.evidence.slice(0, 3),
    mustFix: latest.mustFix.slice(0, 5),
    planHints: latest.planHints.slice(0, 5),
    failedPatchCount: latest.failedPatchCount,
    avoidRetry: latest.avoidRetry,
    evaluatedAt: latest.evaluatedAt,
  }];
}

export function buildRepairIssuesPayload(
  issues: ReviewIssue[],
  runtimePackage: ChapterRuntimePackage | null | undefined,
  auditOpenIssueCodes?: string[] | null,
  qualityFeedback?: QualityFeedbackPacket[] | null,
): string {
  const missingObligations = runtimePackage?.obligationCoverage?.missing ?? [];
  const blockingIssueCodes = resolveRepairIssueCodes(runtimePackage, auditOpenIssueCodes);
  const feedback = summarizeRepairQualityFeedback(qualityFeedback);

  if (missingObligations.length === 0 && blockingIssueCodes.length === 0 && feedback.length === 0) {
    return JSON.stringify({ issues }, null, 2);
  }

  return JSON.stringify({
    issues,
    ...(missingObligations.length > 0
      ? {
        missingObligations: missingObligations.map((obligation) => ({
          kind: obligation.kind,
          summary: obligation.summary,
          ...(obligation.evidence ? { evidence: obligation.evidence } : {}),
        })),
      }
      : {}),
    ...(blockingIssueCodes.length > 0 ? { blockingIssueCodes } : {}),
    ...(feedback.length > 0 ? { qualityFeedback: feedback } : {}),
  }, null, 2);
}
