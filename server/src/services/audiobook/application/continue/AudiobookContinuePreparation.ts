import type { AudiobookChapterReprocessMode } from "@ai-novel/shared/types/audiobook";
import {
  wipeChapterAudioArtifacts,
  wipeFullBookAudioArtifacts,
} from "../../audiobookPaths";

export interface AudiobookContinuePreparationIntent {
  parentTaskId: string;
  parentGenerationToken: string | null;
  mode: Extract<AudiobookChapterReprocessMode, "resynthesize"> | null;
}

function parseProgressEnvelope(json: string | null | undefined): Record<string, unknown> {
  if (!json?.trim()) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Runtime-validate the durable parent/generation fence carried by a hidden continue child. */
export function readContinuePreparationIntent(
  json: string | null | undefined,
): AudiobookContinuePreparationIntent | null {
  const progress = parseProgressEnvelope(json);
  const parentTaskId = typeof progress.parentTaskId === "string"
    ? progress.parentTaskId.trim()
    : "";
  if (!parentTaskId) return null;
  const parentGenerationToken = typeof progress.parentGenerationToken === "string"
    ? progress.parentGenerationToken.trim() || null
    : null;
  return {
    parentTaskId,
    parentGenerationToken,
    mode: progress.mode === "resynthesize" ? "resynthesize" : null,
  };
}

/** Preserve the continuation identity while onProgress replaces the rest of progressJson. */
export function projectContinuePreparationEnvelope(
  json: string | null | undefined,
): Record<string, unknown> {
  const progress = parseProgressEnvelope(json);
  const intent = readContinuePreparationIntent(json);
  if (!intent) return {};
  return {
    ...(progress.hidden === true ? { hidden: true } : {}),
    parentTaskId: intent.parentTaskId,
    ...(intent.parentGenerationToken
      ? { parentGenerationToken: intent.parentGenerationToken }
      : {}),
    mode: intent.mode,
  };
}

/**
 * Invalidate every shared full-book artifact before a continuation can inspect cache state.
 * A resynthesis additionally removes the requested chapter artifacts. All deletions are
 * idempotent but strict: only ENOENT is accepted, so stale output cannot become a cache hit.
 */
export function prepareContinueArtifacts(input: {
  taskDir: string;
  chapterIds: string[];
  mode: AudiobookContinuePreparationIntent["mode"];
}): void {
  if (input.mode === "resynthesize") {
    for (const chapterId of input.chapterIds) {
      wipeChapterAudioArtifacts(input.taskDir, chapterId);
    }
    return;
  }
  wipeFullBookAudioArtifacts(input.taskDir);
}

/** Preserve unrelated parent progress while making failed requested chapters retryable. */
export function withContinuePreparationFailure(
  json: string | null | undefined,
  chapterIds: string[],
): string {
  const progress = parseProgressEnvelope(json);
  const existing = Array.isArray(progress.failedContinueChapters)
    ? progress.failedContinueChapters.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    )
    : [];
  return JSON.stringify({
    ...progress,
    failedContinueChapters: Array.from(new Set([...existing, ...chapterIds])),
  });
}
