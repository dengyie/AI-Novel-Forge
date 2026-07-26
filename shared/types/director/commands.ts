export const DIRECTOR_RUN_COMMAND_TYPES = [
  "generate_candidates",
  "refine_candidates",
  "patch_candidate",
  "refine_titles",
  "confirm_candidate",
  "continue",
  "resume_from_checkpoint",
  "retry",
  "takeover",
  "approve_gate",
  "policy_update",
  "workspace_analysis",
  "manual_edit_impact",
  "repair_chapter_titles",
  "cancel",
] as const;

export type DirectorRunCommandType = typeof DIRECTOR_RUN_COMMAND_TYPES[number];

export const DIRECTOR_RUN_COMMAND_STATUSES = [
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "stale",
] as const;

export type DirectorRunCommandStatus = typeof DIRECTOR_RUN_COMMAND_STATUSES[number];

export interface DirectorCommandAcceptedResponse {
  commandId: string;
  taskId: string;
  novelId?: string | null;
  commandType: DirectorRunCommandType;
  status: DirectorRunCommandStatus;
  leaseExpiresAt?: string | null;
  runtimeId?: string | null;
  runtimeStatus?: string | null;
  projectionUrl?: string | null;
}

export interface DirectorCommandResultResponse<T = unknown> {
  commandId: string;
  taskId: string;
  commandType: DirectorRunCommandType | string;
  status: DirectorRunCommandStatus | string;
  result?: T | null;
  errorMessage?: string | null;
}
