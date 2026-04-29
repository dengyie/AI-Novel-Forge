import { createHash } from "node:crypto";

type Nullable<T> = T | null | undefined;

export interface DirectorRecoverySampleTaskRow {
  id: string;
  novelId?: string | null;
  status: string;
  pendingManualRecovery?: boolean | null;
  checkpointType?: string | null;
  currentStage?: string | null;
  currentItemKey?: string | null;
  currentItemLabel?: string | null;
  resumeTargetJson?: string | null;
  seedPayloadJson?: string | null;
  lastError?: string | null;
  updatedAt?: Date | string | null;
}

export interface DirectorRecoverySampleCommandRow {
  id: string;
  taskId: string;
  novelId?: string | null;
  commandType: string;
  status: string;
  payloadJson?: string | null;
  updatedAt?: Date | string | null;
}

export interface DirectorRecoverySampleJobRow {
  id: string;
  novelId?: string | null;
  status: string;
  currentStage?: string | null;
  currentItemLabel?: string | null;
  startOrder?: number | null;
  endOrder?: number | null;
  completedCount?: number | null;
  totalCount?: number | null;
  updatedAt?: Date | string | null;
}

export interface DirectorRecoverySampleArtifactRow {
  id: string;
  novelId: string;
  artifactType: string;
  targetType: string;
  targetId?: string | null;
  version: number;
  status: string;
  source: string;
  contentTable: string;
  contentId: string;
  contentHash?: string | null;
  protectedUserContent?: boolean | null;
  updatedAt?: Date | string | null;
}

export interface DirectorRecoverySampleChapterRow {
  id: string;
  novelId: string;
  order: number;
  title?: string | null;
  content?: string | null;
  updatedAt?: Date | string | null;
}

export interface DirectorRecoverySampleAuditInput {
  tasks: DirectorRecoverySampleTaskRow[];
  commands: DirectorRecoverySampleCommandRow[];
  jobs: DirectorRecoverySampleJobRow[];
  artifacts: DirectorRecoverySampleArtifactRow[];
  chapters: DirectorRecoverySampleChapterRow[];
  draftBaselineArtifacts?: DirectorRecoverySampleArtifactRow[];
  draftChapters?: DirectorRecoverySampleChapterRow[];
}

export interface DirectorRecoverySampleTask {
  id: string;
  novelId: string | null;
  status: string;
  pendingManualRecovery: boolean;
  checkpointType: string | null;
  currentStage: string | null;
  currentItemKey: string | null;
  currentItemLabel: string | null;
  runMode: string | null;
  directorPhase: string | null;
  autoExecutionMode: string | null;
  autoExecutionNext: number | null;
  resumeStage: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface DirectorRecoverySampleAudit {
  counts: {
    autoDirectorTasks: number;
    takeoverCommands: number;
    recoveryTasks: number;
    chapterBatchTasks: number;
    waitingTasks: number;
    contextlessTakeoverRecoveryTasks: number;
    protectedOrStaleArtifacts: number;
    manualEditCandidates: number;
    manualEditHashChanged: number;
    draftBaselineArtifacts: number;
    untrackedDraftChapters: number;
    generationJobs: number;
  };
  samples: {
    takeoverCommands: Array<{
      id: string;
      taskId: string;
      novelId: string | null;
      status: string;
      updatedAt: string | null;
    }>;
    recoveryTasks: DirectorRecoverySampleTask[];
    chapterBatchTasks: DirectorRecoverySampleTask[];
    waitingTasks: DirectorRecoverySampleTask[];
    contextlessTakeoverRecoveryTasks: DirectorRecoverySampleTask[];
    activeOrRecentJobs: Array<{
      id: string;
      novelId: string | null;
      status: string;
      currentStage: string | null;
      currentItemLabel: string | null;
      startOrder: number | null;
      endOrder: number | null;
      completedCount: number | null;
      totalCount: number | null;
      updatedAt: string | null;
    }>;
    manualEditCandidates: Array<{
      artifactId: string;
      novelId: string;
      chapterId: string;
      chapterOrder: number | null;
      chapterTitle: string | null;
      artifactType: string;
      source: string;
      status: string;
      protectedUserContent: boolean | null;
      hashChanged: boolean;
      updatedAt: string | null;
    }>;
    untrackedDraftChapters: Array<{
      novelId: string;
      chapterId: string;
      chapterOrder: number;
      chapterTitle: string | null;
      reason: string;
      updatedAt: string | null;
    }>;
  };
}

function parseJson(value: Nullable<string>): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function iso(value: Nullable<Date | string>): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasObjectValue(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableContentHash(value: Nullable<string>): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  return createHash("sha256").update(normalized).digest("hex");
}

function compactTask(task: DirectorRecoverySampleTaskRow): DirectorRecoverySampleTask {
  const seed = parseJson(task.seedPayloadJson);
  const resume = parseJson(task.resumeTargetJson);
  const directorInput = readObject(seed.directorInput);
  const directorSession = readObject(seed.directorSession);
  const autoExecution = readObject(seed.autoExecution);
  const seedResumeTarget = readObject(seed.resumeTarget);
  return {
    id: task.id,
    novelId: task.novelId ?? null,
    status: task.status,
    pendingManualRecovery: task.pendingManualRecovery === true,
    checkpointType: task.checkpointType ?? null,
    currentStage: task.currentStage ?? null,
    currentItemKey: task.currentItemKey ?? null,
    currentItemLabel: task.currentItemLabel ?? null,
    runMode: readString(directorInput.runMode) ?? readString(seed.runMode) ?? readString(directorSession.runMode),
    directorPhase: readString(directorSession.phase),
    autoExecutionMode: readString(autoExecution.mode),
    autoExecutionNext: readNumber(autoExecution.nextChapterOrder),
    resumeStage: readString(resume.stage) ?? readString(seedResumeTarget.stage),
    lastError: task.lastError ? task.lastError.slice(0, 160) : null,
    updatedAt: iso(task.updatedAt),
  };
}

function isRecoveryTask(task: DirectorRecoverySampleTask): boolean {
  return task.pendingManualRecovery || task.status === "failed" || task.status === "cancelled";
}

function isChapterBatchTask(task: DirectorRecoverySampleTask): boolean {
  return task.currentStage === "chapter_execution"
    || task.currentStage === "quality_repair"
    || Boolean(task.autoExecutionMode)
    || task.checkpointType === "front10_ready"
    || task.checkpointType === "chapter_batch_ready"
    || task.checkpointType === "replan_required";
}

export function buildDirectorRecoverySampleAudit(
  input: DirectorRecoverySampleAuditInput,
): DirectorRecoverySampleAudit {
  const tasks = input.tasks.map(compactTask);
  const takeoverCommands = input.commands.filter((command) => command.commandType === "takeover");
  const recoveryTasks = tasks.filter(isRecoveryTask);
  const chapterBatchTasks = tasks.filter(isChapterBatchTask);
  const waitingTasks = tasks.filter((task) => task.status === "waiting_approval");
  const takeoverRequestTaskIds = new Set(
    input.commands
      .filter((command) => command.commandType === "takeover")
      .filter((command) => hasObjectValue(parseJson(command.payloadJson).takeoverRequest))
      .map((command) => command.taskId),
  );
  const contextlessTakeoverTaskIds = new Set(
    input.tasks
      .filter((task) => takeoverRequestTaskIds.has(task.id))
      .filter((task) => !hasObjectValue(parseJson(task.seedPayloadJson).directorInput))
      .map((task) => task.id),
  );
  const contextlessTakeoverRecoveryTasks = tasks.filter((task) => contextlessTakeoverTaskIds.has(task.id));
  const chapterById = new Map(input.chapters.map((chapter) => [chapter.id, chapter]));
  const manualEditCandidates = input.artifacts
    .filter((artifact) => artifact.contentTable === "Chapter" && artifact.contentId)
    .map((artifact) => {
      const chapter = chapterById.get(artifact.contentId);
      const currentHash = stableContentHash(chapter?.content);
      return {
        artifactId: artifact.id,
        novelId: artifact.novelId,
        chapterId: artifact.contentId,
        chapterOrder: chapter?.order ?? null,
        chapterTitle: chapter?.title ?? null,
        artifactType: artifact.artifactType,
        source: artifact.source,
        status: artifact.status,
        protectedUserContent: artifact.protectedUserContent ?? null,
        hashChanged: Boolean(artifact.contentHash && currentHash && artifact.contentHash !== currentHash),
        updatedAt: iso(artifact.updatedAt),
      };
    });
  const draftBaselineArtifacts = input.draftBaselineArtifacts ?? input.artifacts;
  const trackedDraftChapterIds = new Set(
    draftBaselineArtifacts
      .filter((artifact) => artifact.artifactType === "chapter_draft" && artifact.contentTable === "Chapter")
      .map((artifact) => artifact.contentId),
  );
  const untrackedDraftChapters = (input.draftChapters ?? [])
    .filter((chapter) => chapter.content?.trim() && !trackedDraftChapterIds.has(chapter.id))
    .map((chapter) => ({
      novelId: chapter.novelId,
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      chapterTitle: chapter.title ?? null,
      reason: "chapter_draft ledger baseline is missing",
      updatedAt: iso(chapter.updatedAt),
    }));

  return {
    counts: {
      autoDirectorTasks: tasks.length,
      takeoverCommands: takeoverCommands.length,
      recoveryTasks: recoveryTasks.length,
      chapterBatchTasks: chapterBatchTasks.length,
      waitingTasks: waitingTasks.length,
      contextlessTakeoverRecoveryTasks: contextlessTakeoverRecoveryTasks.length,
      protectedOrStaleArtifacts: input.artifacts.length,
      manualEditCandidates: manualEditCandidates.length,
      manualEditHashChanged: manualEditCandidates.filter((candidate) => candidate.hashChanged).length,
      draftBaselineArtifacts: draftBaselineArtifacts.length,
      untrackedDraftChapters: untrackedDraftChapters.length,
      generationJobs: input.jobs.length,
    },
    samples: {
      takeoverCommands: takeoverCommands.slice(0, 5).map((command) => ({
        id: command.id,
        taskId: command.taskId,
        novelId: command.novelId ?? null,
        status: command.status,
        updatedAt: iso(command.updatedAt),
      })),
      recoveryTasks: recoveryTasks.slice(0, 8),
      chapterBatchTasks: chapterBatchTasks.slice(0, 8),
      waitingTasks: waitingTasks.slice(0, 8),
      contextlessTakeoverRecoveryTasks: contextlessTakeoverRecoveryTasks.slice(0, 8),
      activeOrRecentJobs: input.jobs.slice(0, 8).map((job) => ({
        id: job.id,
        novelId: job.novelId ?? null,
        status: job.status,
        currentStage: job.currentStage ?? null,
        currentItemLabel: job.currentItemLabel ?? null,
        startOrder: job.startOrder ?? null,
        endOrder: job.endOrder ?? null,
        completedCount: job.completedCount ?? null,
        totalCount: job.totalCount ?? null,
        updatedAt: iso(job.updatedAt),
      })),
      manualEditCandidates: manualEditCandidates.slice(0, 12),
      untrackedDraftChapters: untrackedDraftChapters.slice(0, 12),
    },
  };
}
