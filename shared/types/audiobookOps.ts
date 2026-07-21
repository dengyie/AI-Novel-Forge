/**
 * Audiobook AI Ops Agents（H 计划）— 共享契约类型。
 *
 * SoT: docs/plans/audiobook-ai-ops-agents-plan.md §3,§12-A,C
 *
 * 只放客户端可见的 Ops Run 生命周期 + 报告摘要类型。
 * 内部 Agent 实现类型定义在 server/src/services/audiobook/ops/agents/agentTypes.ts。
 *
 * 不变量（见 §4）：
 * - import 永 draft；Agent 不直批 approved。
 * - approved 必须 heardAt + heardSha256≡primaryFile.sha256（沿用 VoiceAssetReview）。
 * - 进入 setStatus(approved) 前须显式跑进程内门禁 assertOpsApproveAllowed()。
 * - 人工 override 非 default；写 force 标记后 Agent 不覆盖。
 */

export type OpsRunProfile = "full" | "library_only" | "patrol_only" | "ear_auto" | "library_ai_fill";

export const OPS_RUN_PROFILES: readonly OpsRunProfile[] = [
  "full",
  "library_only",
  "patrol_only",
  "ear_auto",
  "library_ai_fill",
] as const;

export function isOpsRunProfile(value: string): value is OpsRunProfile {
  return (OPS_RUN_PROFILES as readonly string[]).includes(value);
}

export type OpsRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const OPS_RUN_STATUSES: readonly OpsRunStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export function isOpsRunStatus(value: string): value is OpsRunStatus {
  return (OPS_RUN_STATUSES as readonly string[]).includes(value);
}

export type OpsRunStepName = "import" | "label" | "ear" | "approve" | "ready" | "synth" | "patrol" | "matrix";

export const OPS_RUN_STEP_NAMES: readonly OpsRunStepName[] = [
  "import",
  "label",
  "ear",
  "approve",
  "ready",
  "synth",
  "patrol",
  "matrix",
] as const;

export type OpsRunStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface OpsRunInput {
  profile: OpsRunProfile;
  novelId?: string | null;
  packRoots?: string[] | null;
  assetIds?: string[] | null;
  autoFix?: boolean | null;
  /** dry-run：只列将 import 的 pack / 将审听的 draft / 将扫描的角色（不改库）；阶段 1 P0。 */
  dryRun?: boolean | null;
}

export interface OpsRunStepSummary {
  step: OpsRunStepName;
  status: OpsRunStepStatus;
  durationMs?: number | null;
  counts?: Record<string, number> | null;
  message?: string | null;
}

export interface OpsRunSummary {
  id: string;
  profile: OpsRunProfile;
  input: OpsRunInput;
  inputFingerprint: string;
  status: OpsRunStatus;
  startedAt: string;
  finishedAt?: string | null;
  cancelRequestedAt?: string | null;
  currentStep?: OpsRunStepName | null;
  stepsSummary: OpsRunStepSummary[];
  reportPath: string;
  error?: { code: string; message: string } | null;
}

export type OpsRunListEntry = Pick<
  OpsRunSummary,
  "id" | "profile" | "status" | "startedAt" | "finishedAt" | "currentStep" | "input"
>;

/**
 * Ear 决策：
 * - approve：声学过硬线，可自动升权
 * - approve_with_low_confidence：中区可听；默认不自动升权（EAR_AUTO_SOFT_APPROVE=1 才软升）
 * - reject：损坏/静音/极端削波等硬拒绝
 * - needs_human：仅门禁/人工 forceKeep 等外部阻断（启发式本身不再产出）
 */
export type OpsEarDecision =
  | "approve"
  | "approve_with_low_confidence"
  | "reject"
  | "needs_human";

/** 客户端可见的 EarVerdict 摘要（写入 review.ear 的同形态）。 */
export interface OpsEarVerdict {
  assetId: string;
  primarySha256: string;
  decision: OpsEarDecision;
  scores: {
    clarity: number;
    cleanliness: number;
    speechLikely: number;
    durationOk: boolean;
    clipOk: boolean;
  };
  /** 稳定审计码，可选 */
  decisionReasonCodes?: string[];
  reasons: string[];
  agent: { name: "ear"; version: string; model?: string | null };
  heardAt: string;
}

export type PatrolCheckId = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7";

export interface PatrolFinding {
  id: PatrolCheckId;
  target: { novelId?: string | null; taskId?: string | null; chapterId?: string | null };
  severity: "info" | "warn" | "error";
  message: string;
  autoFixed?: boolean | null;
}

export interface PatrolReport {
  findings: PatrolFinding[];
  checkedTasks: number;
  checkedChapters: number;
  clean: boolean;
}

export interface OpsRunReport {
  runId: string;
  profile: OpsRunProfile;
  startedAt: string;
  finishedAt?: string | null;
  ear: OpsEarVerdict[];
  approve: {
    attempted: number;
    approved: number;
    /** hard approve 升权数（可选，旧 report 可缺） */
    approvedHard?: number;
    /** soft 升权数（仅 EAR_AUTO_SOFT_APPROVE=1 时非 0） */
    approvedSoft?: number;
    rejected: number;
    skipped: number;
    gateBlocked: number;
  };
  ready?: {
    planned: number;
    bound: number;
    failed: number;
    skipped: number;
  } | null;
  patrol?: PatrolReport | null;
  dryRun?: boolean | null;
  dryRunPlan?: {
    packsToImport?: string[];
    draftsToAudit?: string[];
    charactersToPlan?: number | null;
  } | null;
}

export interface OpsRunCreateResponse {
  runId: string;
  status: OpsRunStatus;
  duplicateOfRunId?: string | null;
}

export interface OpsOverrideInput {
  action: "forceKeepDraft" | "forceReject" | "forceBind";
  assetId?: string | null;
  novelId?: string | null;
  characterId?: string | null;
  voiceAssetId?: string | null;
  reason?: string | null;
}

export interface OpsOverrideResult {
  action: OpsOverrideInput["action"];
  applied: boolean;
  reason?: string | null;
}
