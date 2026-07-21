/**
 * OpsRun 内部报告类型 + 进程内 approve 门禁。
 *
 * SoT: docs/plans/audiobook-ai-ops-agents-plan.md §12-C,D
 *
 * 客户端可见类型在 shared/types/audiobookOps.ts；本文件定义内部 Agent
 * 实现所需的强类型 + §D 的进程内 approve 门禁 assertOpsApproveAllowed。
 */
import { AppError } from "../../../middleware/errorHandler";
import type {
  OpsRunReport,
} from "@ai-novel/shared/types/audiobookOps";

export const EAR_AGENT_NAME = "ear" as const;
/** v2：中区 soft 默认不升权；EAR_AUTO_SOFT_APPROVE=1 才 soft 升权；启发式不再 needs_human。 */
export const EAR_AGENT_VERSION = "2";

/** Agent 升权路径的进程内门禁（§D）。生产须 token；dev 可显式 allow_open。 */
export function assertOpsApproveAllowed(): void {
  const allowOpen = process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE?.trim() === "1";
  const hasToken = !!(process.env.VOICE_LIBRARY_APPROVE_TOKEN ?? "").trim();
  if (!hasToken && !allowOpen) {
    throw new AppError(
      "Agent 升权需生产 token（VOICE_LIBRARY_APPROVE_TOKEN）或显式 dev 开关 AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE=1",
      403,
    );
  }
}

/** dev 路径审计（reason=allow_open）；生产路径由 setStatus 内 audit 覆盖。 */
export function auditOpsApproveAllowedPath(): { via: "token" | "allow_open" } {
  const allowOpen = process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE?.trim() === "1";
  const hasToken = !!(process.env.VOICE_LIBRARY_APPROVE_TOKEN ?? "").trim();
  return {
    via: hasToken ? "token" : allowOpen ? "allow_open" : "token",
  };
}

export interface OpsReportBuilder {
  runId: string;
  profile: OpsRunReport["profile"];
  startedAt: string;
  finishedAt: string | null;
  ear: OpsRunReport["ear"];
  approve: OpsRunReport["approve"];
  ready: OpsRunReport["ready"];
  patrol: OpsRunReport["patrol"];
  dryRun: boolean;
  dryRunPlan: OpsRunReport["dryRunPlan"];
}

export function createReportBuilder(input: {
  runId: string;
  profile: OpsRunReport["profile"];
  startedAt: string;
  dryRun: boolean;
}): OpsReportBuilder {
  return {
    runId: input.runId,
    profile: input.profile,
    startedAt: input.startedAt,
    finishedAt: null,
    ear: [],
    approve: { attempted: 0, approved: 0, approvedHard: 0, approvedSoft: 0, rejected: 0, skipped: 0, gateBlocked: 0 },
    ready: null,
    patrol: null,
    dryRun: input.dryRun,
    dryRunPlan: null,
  };
}

export function finalizeReport(builder: OpsReportBuilder): OpsRunReport {
  return {
    runId: builder.runId,
    profile: builder.profile,
    startedAt: builder.startedAt,
    finishedAt: builder.finishedAt,
    ear: builder.ear,
    approve: builder.approve,
    ready: builder.ready,
    patrol: builder.patrol,
    dryRun: builder.dryRun || null,
    dryRunPlan: builder.dryRunPlan,
  };
}
