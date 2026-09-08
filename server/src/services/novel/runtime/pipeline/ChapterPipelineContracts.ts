import type { ContentProvenance } from "@ai-novel/shared/types/canonicalState";
import type { ChapterRuntimePackage, GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import type { ChapterChineseProseGateError } from "../chapterChineseProseGateError";
import type { ChapterEmptyContentError } from "../chapterEmptyContentError";
import type { ChapterRuntimeRequestInput } from "../chapterRuntimeSchema";
import type { CommittedChapterContent } from "../content/ChapterContentCommitTypes";

export interface PipelineRuntimeHooks {
  onCheckCancelled?: () => Promise<void>;
  onStageChange?: (stage: "generating_chapters" | "reviewing" | "repairing") => Promise<void>;
  onEmptyContent?: (event: PipelineEmptyContentEvent) => Promise<void>;
  onChineseProseGate?: (event: PipelineChineseProseGateEvent) => Promise<void>;
  onWriterTransportRetry?: (event: PipelineWriterTransportRetryEvent) => Promise<void>;
}

export interface PipelineEmptyContentEvent {
  attempt: number;
  willRetry: boolean;
  error: ChapterEmptyContentError;
  contentLength: number;
  rawContentLength: number;
}

export interface PipelineChineseProseGateEvent {
  attempt: number;
  willRetry: boolean;
  error: ChapterChineseProseGateError;
  reason?: string;
  rawContentLength: number;
}

export interface PipelineWriterTransportRetryEvent {
  attempt: number;
  willRetry: boolean;
  error: unknown;
  message: string;
}

export interface PipelineRuntimeInput extends ChapterRuntimeRequestInput {
  maxRetries?: number;
  autoReview?: boolean;
  autoRepair?: boolean;
  auditMode?: "light" | "full" | "repair_only";
  qualityThreshold?: number;
  repairMode?: "detect_only" | "light_repair" | "heavy_repair" | "continuity_only" | "character_only" | "ending_only";
  runMode?: "fast" | "polish";
  signal?: AbortSignal;
}

export interface QualityDebtAttribution {
  firstFailureIssueCodes: string[];
  secondFailureIssueCodes: string[];
  firstFailureClassificationCode: string | null;
  patchAnchorFailed: boolean;
  sameObligationRepeated: boolean;
  planMisaligned: boolean;
  lengthVsContentDrift: boolean;
  missingObligationKinds: string[];
  budgetActionsConsumed?: Array<"patch_repair" | "chapter_rewrite" | "window_replan">;
  degradedProposalRouting?: {
    contentProvenance: "debt";
    routedToPendingReview: true;
    proposalTypes: Array<"character_state_update" | "character_resource_update">;
    fields: Array<"currentState" | "currentGoal" | "characterResource">;
  };
}

export interface PipelineRuntimeResult {
  reviewExecuted: boolean;
  pass: boolean;
  score: QualityScore;
  issues: ReviewIssue[];
  runtimePackage: ChapterRuntimePackage | null;
  retryCountUsed: number;
  contentRevision: number;
  recoverableRepairFailure?: PipelineRecoverableRepairFailure | null;
  qualityDebtAttribution?: QualityDebtAttribution | null;
}

export interface FinalizedRuntimeResult {
  finalContent: string;
  runtimePackage: ChapterRuntimePackage;
  contentRevision: number;
}

export interface PipelineRecoverableRepairFailure {
  chapterId: string;
  message: string;
  repairMode: NonNullable<PipelineRuntimeInput["repairMode"]>;
  failureTypes: string[];
  occurredAt: string;
}

export interface AssembledRuntimeChapter {
  novel: { id: string; title: string };
  chapter: {
    id: string;
    title: string;
    order: number;
    content: string | null;
    contentRevision: number;
    expectation: string | null;
    riskFlags?: string | null;
  };
  contextPackage: GenerationContextPackage;
}

export interface RunPipelineChapterDeps {
  validateRequest: (input: ChapterRuntimeRequestInput) => ChapterRuntimeRequestInput;
  ensureNovelCharacters: (novelId: string, actionName: string, minCount?: number) => Promise<void>;
  assemble: (novelId: string, chapterId: string, request: ChapterRuntimeRequestInput) => Promise<AssembledRuntimeChapter>;
  generateDraftFromWriter: (input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    assembled: AssembledRuntimeChapter;
    signal?: AbortSignal;
    emptyContentAttempt?: number;
  }) => Promise<{
    content: string;
    lengthControl?: ChapterRuntimePackage["lengthControl"];
    artifactsAlreadySynced?: boolean;
    contentRevision?: number;
  }>;
  saveDraftAndArtifacts: (
    novelId: string,
    chapterId: string,
    content: string,
    generationState: "drafted",
    options: {
      expectedContentRevision: number;
      scheduleBackgroundSync?: boolean;
      artifactSyncMode?: PipelineRuntimeInput["artifactSyncMode"];
      syncArtifacts?: boolean;
    },
  ) => Promise<CommittedChapterContent>;
  commitRepairContent: (
    novelId: string,
    chapterId: string,
    content: string,
    expectedContentRevision: number,
  ) => Promise<CommittedChapterContent>;
  syncFinalChapterArtifacts: (
    novelId: string,
    chapterId: string,
    content: string,
    options?: {
      artifactSyncMode?: PipelineRuntimeInput["artifactSyncMode"];
      contentProvenance?: ContentProvenance;
    },
  ) => Promise<void>;
  finalizeChapterContent: (input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    contextPackage: GenerationContextPackage;
    content: string;
    expectedContentRevision: number;
    lengthControl?: ChapterRuntimePackage["lengthControl"];
    runId: string | null;
    startMs: number | null;
    signal?: AbortSignal;
  }) => Promise<FinalizedRuntimeResult>;
  markChapterGenerationState: (
    chapterId: string,
    generationState: "reviewed" | "approved",
    expectedContentRevision: number,
    options?: { literaryPass?: boolean; styleClear?: boolean },
  ) => Promise<void>;
  markChapterNeedsRepair: (chapterId: string, expectedContentRevision: number) => Promise<void>;
}
