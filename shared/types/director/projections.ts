import type {
  DirectorCircuitBreakerState,
  DirectorQualityLoopBudgetNextAction,
} from "../novelDirector";
import type {
  DirectorArtifactSource,
  DirectorArtifactStatus,
  DirectorArtifactTargetType,
  DirectorArtifactType,
} from "./artifacts";
import type {
  DirectorEvent,
  DirectorEventType,
  DirectorLlmUsageRecordSummary,
  DirectorLlmUsageSummary,
  DirectorPolicyMode,
  DirectorPromptUsageSummary,
  DirectorRuntimePolicySnapshot,
  DirectorRuntimeSnapshot,
  DirectorStepUsageSummary,
  DirectorUsageAttributionStatus,
} from "./runtime";
import type { DirectorRunCommandType } from "./commands";
import type { DirectorDashboardView } from "./dashboard";
import type { DirectorNextAction } from "./workspace";

export type DirectorRuntimeProjectionStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "failed"
  | "completed";

export interface DirectorRuntimeProjectionEvent {
  eventId: string;
  type: DirectorEventType;
  summary: string;
  nodeKey?: string | null;
  artifactType?: DirectorArtifactType | null;
  severity?: DirectorEvent["severity"];
  occurredAt: string;
  usage?: DirectorLlmUsageSummary | null;
}

export type DirectorAutopilotRecoveryDecision =
  | "continue"
  | "auto_repair_chapter"
  | "auto_rewrite_chapter"
  | "auto_replan_window"
  | "auto_resume_from_checkpoint"
  | "defer_and_continue"
  | "requires_manual_recovery";

export interface DirectorRuntimeProgressBreakdown {
  planningProgress: number;
  chapterProgress: number;
  qualityProgress: number;
  activeJobProgress: number;
  planningPercent: number;
  chapterExecutionPercent: number;
  qualityRepairPercent: number;
  totalPercent: number;
  completedSteps: number;
  totalSteps: number;
  draftedChapters: number;
  continuableChapters: number;
  totalChapters: number;
  pendingRepairChapters: number;
  explanation: string;
}

export interface DirectorRuntimeVisibleRiskBadge {
  label: string;
  level: "info" | "warning" | "danger";
  source?: "status" | "artifact" | "event" | "policy";
}

export interface DirectorRuntimeQualityDebtSummary {
  deferredChapterCount: number;
  deferredChapterOrders: number[];
  latestReason?: string | null;
}

export interface DirectorRuntimeQualityBudgetSummary {
  currentChapterId?: string | null;
  currentChapterOrder?: number | null;
  latestSignatureKey?: string | null;
  latestIssueSignature?: string | null;
  latestReason?: string | null;
  patchRepairUsed: number;
  chapterRewriteUsed: number;
  windowReplanUsed: number;
  deferredCount: number;
  nextAction: DirectorQualityLoopBudgetNextAction;
  nextActionLabel: string;
  explanation: string;
}

export interface DirectorOutlineFactSummary {
  beatSheetReady: boolean;
  chapterListReady: boolean;
  chapterDetailReady: boolean;
  plannedChapterCount: number;
  selectedChapterCount: number;
  completedDetailSteps: number;
  totalDetailSteps: number;
  syncedChapterCount: number;
}

export interface DirectorChapterExecutionFactSummary {
  totalChapters: number;
  draftedChapterCount: number;
  reviewedChapterCount: number;
  approvedChapterCount: number;
  committedChapterCount: number;
  completedChapters: number;
  needsRepairChapters: number;
  ratio: number;
  expectedChapterCount?: number | null;
}

export interface DirectorRepairFactSummary {
  draftedChapterCount: number;
  reviewedChapterCount: number;
  committedChapterCount: number;
  needsRepairChapters: number;
  payoffArtifactCount: number;
  characterResourceArtifactCount: number;
}

export interface DirectorTaskFactSummaryStep {
  stepId: string;
  label: string;
  stage: string;
  completed: boolean;
  completenessRatio: number;
  evidence?: Record<string, unknown>;
  nextAction?: string | null;
}

export interface DirectorTaskFactSummary {
  allStepsCompleted: boolean;
  completedStepCount: number;
  totalStepCount: number;
  currentFactStepId?: string | null;
  currentFactStepLabel?: string | null;
  currentFactEvidence?: Record<string, unknown> | null;
  hasNovelProject: boolean;
  hasStoryMacro: boolean;
  hasBookContract: boolean;
  characterCount: number;
  hasVolumeStrategy: boolean;
  volumeCount: number;
  outlineFacts: DirectorOutlineFactSummary;
  chapterExecutionFacts: DirectorChapterExecutionFactSummary;
  repairFacts: DirectorRepairFactSummary;
  steps: DirectorTaskFactSummaryStep[];
}

export type ChapterExecutionProgressStage =
  | "execution_contract_ready"
  | "context_package_ready"
  | "draft_started"
  | "draft_saved"
  | "audit_completed"
  | "repair_completed_or_not_needed"
  | "runtime_package_saved"
  | "chapter_artifacts_synced"
  | "chapter_state_committed"
  | "reviewable_or_approved";

export interface DirectorChapterExecutionProgressItem {
  chapterId: string;
  chapterOrder: number;
  status: string;
  currentStage: ChapterExecutionProgressStage;
  completedStages: ChapterExecutionProgressStage[];
  missingStages: ChapterExecutionProgressStage[];
  recoverable: boolean;
  nextAction: string;
}

export interface DirectorChapterExecutionProgressSummary {
  totalChapters: number;
  draftedChapterCount: number;
  approvedChapterCount: number;
  completedChapters: number;
  needsRepairChapters: number;
  activeChapterId?: string | null;
  activeChapterOrder?: number | null;
  currentChapterId?: string | null;
  currentChapterOrder?: number | null;
  currentStage?: ChapterExecutionProgressStage | null;
  recoverableRange?: {
    startOrder: number | null;
    endOrder: number | null;
  };
  ratio: number;
  chapters?: DirectorChapterExecutionProgressItem[];
}

export interface DirectorRuntimeProjection {
  runId: string;
  novelId?: string | null;
  status: DirectorRuntimeProjectionStatus;
  runtimeId?: string | null;
  runtimeStatus?: string | null;
  currentAction?: string | null;
  waitingReason?: string | null;
  activeExecution?: {
    executionId: string;
    stepType: string;
    resourceClass?: string | null;
    workerId?: string | null;
    slotId?: string | null;
    status: string;
    startedAt?: string | null;
    leaseExpiresAt?: string | null;
  } | null;
  resourceClass?: string | null;
  checkpointSummary?: string | null;
  nextAutomaticAction?: string | null;
  workerHealth?: DirectorWorkerHealthSummary | null;
  currentNodeKey?: string | null;
  currentLabel?: string | null;
  currentFactStepId?: string | null;
  currentFactStepLabel?: string | null;
  currentFactEvidence?: Record<string, unknown> | null;
  factSummary?: DirectorTaskFactSummary | null;
  headline?: string | null;
  detail?: string | null;
  lastEventSummary?: string | null;
  requiresUserAction: boolean;
  blockedReason?: string | null;
  blockingReason?: string | null;
  nextActionLabel?: string | null;
  recommendedAction?: DirectorNextAction | null;
  recoveryDecision?: DirectorAutopilotRecoveryDecision;
  isAutopilotRecoverable?: boolean;
  scopeSummary?: string | null;
  progressSummary?: string | null;
  progressBreakdown?: DirectorRuntimeProgressBreakdown;
  chapterExecutionProgress?: DirectorChapterExecutionProgressSummary | null;
  visibleRiskBadges?: DirectorRuntimeVisibleRiskBadge[];
  rootCauseCode?: "none" | "draft_generation_failed" | "draft_obligation_unmet" | "draft_repair_exhausted" | "replan_required" | null;
  blockingObligations?: Array<{
    kind: "must_hit_now" | "must_preserve" | "payoff_touch" | "character_appearance" | "goal_change" | "forbidden_crossing";
    summary: string;
    evidence?: string | null;
  }>;
  qualityDebtSummary?: DirectorRuntimeQualityDebtSummary | null;
  qualityBudgetSummary?: DirectorRuntimeQualityBudgetSummary | null;
  policyMode: DirectorPolicyMode;
  updatedAt: string;
  recentEvents: DirectorRuntimeProjectionEvent[];
  usageSummary?: DirectorLlmUsageSummary | null;
  recentUsage?: DirectorLlmUsageRecordSummary[];
  stepUsage?: DirectorStepUsageSummary[];
  promptUsage?: DirectorPromptUsageSummary[];
  circuitBreaker?: DirectorCircuitBreakerState | null;
}

export interface DirectorRuntimeEventHistoryResponse {
  events: DirectorRuntimeProjectionEvent[];
  totalCount: number;
  limit: number;
}

export type DirectorBookAutomationStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_recovery"
  | "blocked"
  | "failed"
  | "cancelled"
  | "completed";

export type DirectorBookAutomationDisplayState =
  | "processing"
  | "needs_confirmation"
  | "paused"
  | "needs_attention"
  | "completed"
  | "idle";

export type DirectorBookAutomationActionType =
  | "open_novel"
  | "open_details"
  | "continue"
  | "auto_execute_range"
  | "confirm_candidate"
  | "open_chapter"
  | "open_quality_repair"
  | "retry"
  | "cancel";

export interface DirectorBookAutomationActionTarget {
  novelId?: string | null;
  taskId?: string | null;
  chapterId?: string | null;
  tab?: "basic" | "story_macro" | "outline" | "structured" | "chapter" | "pipeline" | "character" | "history" | null;
  href?: string | null;
}

export interface DirectorBookAutomationAction {
  type: DirectorBookAutomationActionType;
  label: string;
  target: DirectorBookAutomationActionTarget;
  commandPayload?: {
    taskId?: string | null;
    continuationMode?: "resume" | "auto_execute_range" | null;
  } | null;
  emphasis?: "primary" | "secondary" | "destructive";
}

export interface DirectorBookAutomationFocusNovel {
  id: string;
  title: string;
  href: string;
}

export type DirectorBookAutomationTimelineItemType =
  | "task"
  | "command"
  | "step"
  | "event"
  | "approval"
  | "usage";

export interface DirectorBookAutomationTimelineItem {
  id: string;
  type: DirectorBookAutomationTimelineItemType;
  title: string;
  detail?: string | null;
  status?: string | null;
  taskId?: string | null;
  runId?: string | null;
  nodeKey?: string | null;
  commandType?: DirectorRunCommandType | string | null;
  artifactType?: DirectorArtifactType | string | null;
  severity?: DirectorEvent["severity"];
  durationMs?: number | null;
  usage?: DirectorLlmUsageSummary | null;
  attributionStatus?: DirectorUsageAttributionStatus | string | null;
  occurredAt: string;
}

export interface DirectorBookAutomationTaskSummary {
  id: string;
  title: string;
  status: string;
  progress: number;
  currentStage?: string | null;
  currentItemKey?: string | null;
  currentItemLabel?: string | null;
  checkpointType?: string | null;
  checkpointSummary?: string | null;
  pendingManualRecovery: boolean;
  lastError?: string | null;
  updatedAt: string;
}

export interface DirectorBookAutomationArtifactSummary {
  activeCount: number;
  staleCount: number;
  protectedUserContentCount: number;
  repairTicketCount: number;
  dependencyCount?: number;
  affectedChapterCount?: number;
  affectedChapterIds?: string[];
  byType?: DirectorBookAutomationArtifactTypeSummary[];
  recentArtifacts?: DirectorBookAutomationRecentArtifact[];
  recentStaleArtifacts?: DirectorBookAutomationRecentArtifact[];
  recentRepairArtifacts?: DirectorBookAutomationRecentArtifact[];
  recentVersionedArtifacts?: DirectorBookAutomationRecentArtifact[];
}

export interface DirectorBookAutomationArtifactTypeSummary {
  artifactType: DirectorArtifactType | string;
  totalCount: number;
  activeCount: number;
  staleCount: number;
  protectedUserContentCount: number;
  dependencyCount: number;
  latestUpdatedAt?: string | null;
}

export interface DirectorBookAutomationRecentArtifact {
  id: string;
  artifactType: DirectorArtifactType | string;
  targetType: DirectorArtifactTargetType | string;
  targetId?: string | null;
  status: DirectorArtifactStatus | string;
  source?: DirectorArtifactSource | string | null;
  version?: number | null;
  protectedUserContent?: boolean | null;
  dependencyCount: number;
  contentHash?: string | null;
  updatedAt?: string | null;
}

export type DirectorWorkerDerivedState =
  | "idle"
  | "queued_waiting_worker"
  | "leased_starting"
  | "running_step"
  | "waiting_gate"
  | "auto_recovering"
  | "cancelled"
  | "failed_recoverable"
  | "failed_hard"
  | "succeeded";

export type DirectorWorkerNextAction =
  | "none"
  | "wait_for_worker"
  | "wait_for_lease_start"
  | "continue_running"
  | "recover_stale_command"
  | "requires_user_action";

export interface DirectorWorkerHealthSummary {
  derivedState: DirectorWorkerDerivedState;
  message?: string | null;
  queuedCommandCount: number;
  leasedCommandCount: number;
  runningCommandCount: number;
  staleCommandCount: number;
  oldestQueuedAt?: string | null;
  oldestQueuedWaitMs?: number | null;
  currentCommandId?: string | null;
  currentCommandType?: DirectorRunCommandType | string | null;
  currentWorkerId?: string | null;
  currentSlotId?: string | null;
  currentExecutionId?: string | null;
  currentExecutionStatus?: string | null;
  currentLeaseExpiresAt?: string | null;
  blockedReason?: string | null;
  lastErrorMessage?: string | null;
  nextAction?: DirectorWorkerNextAction;
  lastCommandAt?: string | null;
}

export interface DirectorBookAutomationProjection {
  novelId: string;
  focusNovel: DirectorBookAutomationFocusNovel;
  latestTask?: DirectorBookAutomationTaskSummary | null;
  latestRunId?: string | null;
  status: DirectorBookAutomationStatus;
  displayState: DirectorBookAutomationDisplayState;
  runMode?: string | null;
  policyMode?: DirectorPolicyMode | null;
  headline: string;
  userHeadline: string;
  detail?: string | null;
  userReason?: string | null;
  currentStage?: string | null;
  currentLabel?: string | null;
  requiresUserAction: boolean;
  blockedReason?: string | null;
  nextActionLabel?: string | null;
  primaryAction?: DirectorBookAutomationAction | null;
  secondaryActions?: DirectorBookAutomationAction[];
  automationSummary?: string | null;
  progressSummary?: string | null;
  artifactSummary: DirectorBookAutomationArtifactSummary;
  usageSummary?: DirectorLlmUsageSummary | null;
  recentUsage?: DirectorLlmUsageRecordSummary[];
  stepUsage?: DirectorStepUsageSummary[];
  promptUsage?: DirectorPromptUsageSummary[];
  circuitBreaker?: DirectorCircuitBreakerState | null;
  workerHealth?: DirectorWorkerHealthSummary | null;
  activeCommandCount: number;
  pendingCommandCount: number;
  autoApprovalRecordCount: number;
  latestEventAt?: string | null;
  updatedAt: string;
  dashboardView?: DirectorDashboardView | null;
  runtimeProjection?: DirectorRuntimeProjection | null;
  timeline: DirectorBookAutomationTimelineItem[];
}

export interface DirectorBookAutomationProjectionResponse {
  projection: DirectorBookAutomationProjection;
}

export interface DirectorRuntimeSnapshotResponse {
  snapshot: DirectorRuntimeSnapshot | null;
  projection?: DirectorRuntimeProjection | null;
}
