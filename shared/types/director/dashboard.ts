import type {
  DirectorArtifactRef,
  DirectorArtifactTargetType,
} from "./artifacts";
import type {
  DirectorEvent,
  DirectorRuntimeSnapshot,
  DirectorStepBlocker,
} from "./runtime";
import type {
  DirectorChapterExecutionProgressSummary,
  DirectorRuntimeProjection,
  DirectorRuntimeProjectionStatus,
  DirectorTaskFactSummary,
} from "./projections";
import type { DirectorBudgetLedgerSummary } from "../novelDirector";

export interface DirectorTaskShell {
  id: string;
  novelId?: string | null;
  status: string;
  currentStage?: string | null;
  currentItemKey?: string | null;
  currentItemLabel?: string | null;
  progress?: number | null;
  checkpointType?: string | null;
  checkpointSummary?: string | null;
  lastError?: string | null;
  pendingManualRecovery?: boolean | null;
  cancelRequestedAt?: string | null;
}

export type DirectorDisplayStageKey =
  | "project_setup"
  | "story_planning"
  | "character_setup"
  | "volume_strategy"
  | "structured_outline"
  | "chapter_execution"
  | "quality_repair";

export type DirectorDisplayMode =
  | "idle"
  | "running"
  | "waiting"
  | "needs_recovery"
  | "failed"
  | "completed";

export type DirectorDisplayStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "attention";

export interface DirectorDisplayStep {
  key: DirectorDisplayStageKey;
  label: string;
  status: DirectorDisplayStepStatus;
  isCurrent: boolean;
}

export interface DirectorDisplayState {
  stageKey: DirectorDisplayStageKey;
  stageLabel: string;
  stepIndex: number;
  totalSteps: number;
  mode: DirectorDisplayMode;
  headline: string;
  description: string;
  currentAction: string;
  checkpointLabel: string;
  progressPercent: number;
  nextActionLabel?: string | null;
  currentFactStepId?: string | null;
  currentFactStepLabel?: string | null;
  currentFactDescription?: string | null;
  requiresUserAction: boolean;
  isLiveRunning: boolean;
  needsRecovery: boolean;
  steps: DirectorDisplayStep[];
}

export type DirectorDashboardMode =
  | "idle"
  | "queued"
  | "running"
  | "waiting_user"
  | "recovering"
  | "failed"
  | "completed";

export type DirectorDashboardProgressSource =
  | "task_live"
  | "worker_live"
  | "chapter_facts"
  | "checkpoint"
  | "runtime_projection"
  | "fallback";

export type DirectorDashboardActionType =
  | "confirm_and_continue"
  | "background_continue"
  | "open_task_center"
  | "resume_from_checkpoint"
  | "retry";

export interface DirectorDashboardAction {
  type: DirectorDashboardActionType;
  label: string;
  emphasis: "primary" | "secondary" | "destructive";
}

export interface DirectorDashboardDiagnostic {
  code: string;
  label: string;
  detail?: string | null;
  level: "info" | "warning" | "danger";
  source: "task" | "projection" | "facts" | "worker" | "artifact";
}

export interface DirectorDashboardSourceTrace {
  taskStatus?: string | null;
  projectionStatus?: DirectorRuntimeProjectionStatus | null;
  commandStatus?: string | null;
  activeStepStatus?: string | null;
  checkpointType?: string | null;
  progressSource: DirectorDashboardProgressSource;
}

export interface DirectorDashboardView {
  mode: DirectorDashboardMode;
  statusLabel: string;
  headline: string;
  description: string;
  currentAction: string | null;
  progressPercent: number;
  progressSource: DirectorDashboardProgressSource;
  requiresUserAction: boolean;
  userActionReason?: string | null;
  primaryAction?: DirectorDashboardAction | null;
  secondaryActions: DirectorDashboardAction[];
  stageKey: DirectorDisplayStageKey;
  stageLabel: string;
  stepIndex: number;
  totalSteps: number;
  steps: DirectorDisplayStep[];
  diagnostics: DirectorDashboardDiagnostic[];
  sourceTrace: DirectorDashboardSourceTrace;
  budgetLedgerSummary?: DirectorBudgetLedgerSummary | null;
}

export interface DirectorTaskSnapshot {
  task: DirectorTaskShell;
  run: {
    id: string;
    novelId?: string | null;
    entrypoint?: string | null;
  } | null;
  activeStep: {
    idempotencyKey: string;
    nodeKey: string;
    label: string;
    status: string;
  } | null;
  latestCommand: {
    id: string;
    commandType: string;
    status: string;
  } | null;
  runtime: DirectorRuntimeSnapshot | null;
  projection: DirectorRuntimeProjection | null;
  recentEvents: DirectorEvent[];
  artifacts: DirectorArtifactRef[];
  currentFactStepId?: string | null;
  currentFactStepLabel?: string | null;
  currentFactEvidence?: Record<string, unknown> | null;
  factSummary?: DirectorTaskFactSummary | null;
  chapterProgress?: DirectorChapterExecutionProgressSummary | null;
  displayState: DirectorDisplayState;
  dashboardView: DirectorDashboardView;
  nextActions: string[];
}

export interface DirectorTaskSnapshotResponse {
  snapshot: DirectorTaskSnapshot | null;
}

export interface DirectorTaskFactInspectionStep {
  stepId: string;
  label: string;
  stage: string;
  targetType: DirectorArtifactTargetType;
  ready: boolean;
  completed: boolean;
  completenessRatio: number;
  nextAction?: string | null;
  resumeFrom?: string | null;
  blockers: DirectorStepBlocker[];
  evidence?: Record<string, unknown>;
  producedArtifacts?: DirectorArtifactRef[];
  progress?: {
    status: string;
    ratio: number;
    label: string;
    nextAction?: string | null;
    evidence?: Record<string, unknown>;
  } | null;
  inspectError?: string | null;
  isCurrentFactStep?: boolean;
  isActiveRuntimeStep?: boolean;
}

export interface DirectorTaskFactInspection {
  taskId: string;
  novelId?: string | null;
  currentFactStepId?: string | null;
  currentFactStepLabel?: string | null;
  currentFactEvidence?: Record<string, unknown> | null;
  factSummary?: DirectorTaskFactSummary | null;
  steps: DirectorTaskFactInspectionStep[];
}

export interface DirectorTaskFactInspectionResponse {
  inspection: DirectorTaskFactInspection | null;
}
