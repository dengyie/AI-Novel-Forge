import type { LLMProvider } from "../llm";
import type {
  DirectorArtifactRef,
  DirectorArtifactType,
} from "./artifacts";

export interface DirectorWorkspaceAnalysisResponse {
  analysis: DirectorWorkspaceAnalysis;
}

export type DirectorManualEditImpactLevel = "none" | "low" | "medium" | "high";

export type DirectorManualEditRepairAction =
  | "continue_chapter_execution"
  | "review_recent_chapters"
  | "update_continuity_state"
  | "repair_scope"
  | "ask_user_confirmation";

export interface DirectorManualEditChangedChapter {
  chapterId: string;
  title: string;
  order: number;
  changedAt?: string | null;
  contentHash?: string | null;
  previousContentHash?: string | null;
  relatedArtifactIds: string[];
}

export interface DirectorManualEditRepairStep {
  action: DirectorManualEditRepairAction;
  label: string;
  reason: string;
  affectedScope?: string | null;
  requiresApproval: boolean;
}

export interface AiManualEditImpactDecision {
  impactLevel: DirectorManualEditImpactLevel;
  affectedArtifactIds: string[];
  minimalRepairPath: DirectorManualEditRepairStep[];
  safeToContinue: boolean;
  requiresApproval: boolean;
  summary: string;
  riskNotes: string[];
  evidenceRefs: string[];
  confidence: number;
}

export interface DirectorManualEditInventory {
  novelId: string;
  changedChapters: DirectorManualEditChangedChapter[];
  comparedAgainstTaskId?: string | null;
  generatedAt: string;
}

export interface DirectorManualEditImpact extends AiManualEditImpactDecision {
  novelId: string;
  changedChapters: DirectorManualEditChangedChapter[];
  affectedArtifacts: DirectorArtifactRef[];
  generatedAt: string;
  prompt?: {
    promptId: string;
    promptVersion: string;
    provider?: LLMProvider;
    model?: string;
  } | null;
}
export interface DirectorManualEditImpactResponse {
  impact: DirectorManualEditImpact;
}

export type DirectorProductionStage =
  | "empty"
  | "has_seed"
  | "has_contract"
  | "has_macro"
  | "has_characters"
  | "has_volume_plan"
  | "has_chapter_plan"
  | "has_drafts"
  | "needs_repair"
  | "unknown";

export type DirectorNextActionType =
  | "generate_candidates"
  | "create_book_contract"
  | "complete_story_macro"
  | "prepare_characters"
  | "build_volume_strategy"
  | "build_chapter_tasks"
  | "continue_chapter_execution"
  | "review_recent_chapters"
  | "repair_scope"
  | "ask_user_confirmation";

export interface DirectorNextAction {
  action: DirectorNextActionType;
  reason: string;
  affectedScope?: string | null;
  riskLevel: "low" | "medium" | "high";
}

export interface DirectorWorkspaceInventory {
  novelId: string;
  novelTitle: string;
  hasBookContract: boolean;
  hasStoryMacro: boolean;
  hasCharacters: boolean;
  hasVolumeStrategy: boolean;
  hasChapterPlan: boolean;
  chapterCount: number;
  draftedChapterCount: number;
  approvedChapterCount: number;
  pendingRepairChapterCount: number;
  hasActivePipelineJob: boolean;
  hasActiveDirectorRun: boolean;
  hasWorldBinding: boolean;
  hasSourceKnowledge: boolean;
  hasContinuationAnalysis: boolean;
  latestDirectorTaskId?: string | null;
  activeDirectorTaskId?: string | null;
  activePipelineJobId?: string | null;
  missingArtifactTypes: DirectorArtifactType[];
  staleArtifacts: DirectorArtifactRef[];
  protectedUserContentArtifacts: DirectorArtifactRef[];
  needsRepairArtifacts: DirectorArtifactRef[];
  artifacts: DirectorArtifactRef[];
}

export interface AiWorkspaceInterpretation {
  productionStage: DirectorProductionStage;
  missingArtifacts: DirectorArtifactType[];
  staleArtifacts: DirectorArtifactType[];
  protectedUserContent: string[];
  recommendedAction: DirectorNextAction;
  confidence: number;
  evidenceRefs: string[];
  summary: string;
  riskNotes: string[];
}

export interface DirectorWorkspaceAnalysis {
  novelId: string;
  inventory: DirectorWorkspaceInventory;
  interpretation?: AiWorkspaceInterpretation | null;
  manualEditImpact?: DirectorManualEditImpact | null;
  recommendation?: DirectorNextAction | null;
  confidence: number;
  evidenceRefs: string[];
  generatedAt: string;
  prompt?: {
    promptId: string;
    promptVersion: string;
    provider?: LLMProvider;
    model?: string;
  } | null;
}
