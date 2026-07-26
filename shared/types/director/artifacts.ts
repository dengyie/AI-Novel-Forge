export const DIRECTOR_ARTIFACT_TYPES = [
  "book_contract",
  "story_macro",
  "character_cast",
  "volume_strategy",
  "chapter_task_sheet",
  "chapter_draft",
  "audit_report",
  "repair_ticket",
  "reader_promise",
  "character_governance_state",
  "world_skeleton",
  "source_knowledge_pack",
  "chapter_retention_contract",
  "continuity_state",
  "rolling_window_review",
] as const;

export type DirectorArtifactType = typeof DIRECTOR_ARTIFACT_TYPES[number];

export type DirectorArtifactTargetType = "novel" | "volume" | "chapter" | "global";

export type DirectorArtifactStatus = "draft" | "active" | "superseded" | "stale" | "rejected";

export type DirectorArtifactSource =
  | "ai_generated"
  | "user_edited"
  | "auto_repaired"
  | "imported"
  | "backfilled";

export interface DirectorArtifactRef {
  id: string;
  novelId: string;
  runId?: string | null;
  artifactType: DirectorArtifactType;
  targetType: DirectorArtifactTargetType;
  targetId?: string | null;
  version: number;
  status: DirectorArtifactStatus;
  source: DirectorArtifactSource;
  contentRef: {
    table: string;
    id: string;
  };
  contentHash?: string | null;
  schemaVersion: string;
  promptAssetKey?: string | null;
  promptVersion?: string | null;
  modelRoute?: string | null;
  sourceStepRunId?: string | null;
  protectedUserContent?: boolean | null;
  dependsOn?: Array<{
    artifactId: string;
    version?: number | null;
  }>;
  updatedAt?: string | null;
}

export interface DirectorArtifactVersionRef {
  artifactId: string;
  version?: number | null;
}
