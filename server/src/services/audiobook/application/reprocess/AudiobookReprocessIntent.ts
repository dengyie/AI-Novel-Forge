import type { AudiobookChapterReprocessMode } from "@ai-novel/shared/types/audiobook";

export interface AudiobookReprocessIntent {
  chapterId: string;
  mode: AudiobookChapterReprocessMode;
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

/** Runtime-validate the transient workflow marker stored inside progressJson. */
export function readReprocessIntent(
  json: string | null | undefined,
): AudiobookReprocessIntent | null {
  const raw = parseProgressEnvelope(json).reprocess;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const chapterId = typeof value.chapterId === "string" ? value.chapterId.trim() : "";
  const mode = value.mode === "reannotate" || value.mode === "resynthesize"
    ? value.mode
    : null;
  if (!chapterId || !mode) return null;
  return { chapterId, mode };
}

/** Preserve unrelated progress fields while recording the exact idempotent cleanup intent. */
export function withReprocessIntent(
  json: string | null | undefined,
  intent: AudiobookReprocessIntent,
): string {
  return JSON.stringify({
    ...parseProgressEnvelope(json),
    reprocess: intent,
  });
}
