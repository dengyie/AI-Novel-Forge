import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

export const M4B_ENCODING_LABEL = "有声书生成完成（m4b 后台封装中）";
export const M4B_DONE_LABEL = "有声书生成完成（含 m4b）";

export type BackgroundM4bState = "encoding" | "ready" | "skipped" | "failed";
export type TerminalM4bState = Exclude<BackgroundM4bState, "encoding">;

export function newM4bGenerationToken(): string {
  return randomUUID();
}

/** Exact CAS predicate, including legacy null/empty values from pre-migration rows. */
export function m4bGenerationWhere(
  token: string | null | undefined,
): Prisma.AudiobookTaskWhereInput {
  if (token === undefined) return {};
  return { m4bGenerationToken: token } as unknown as Prisma.AudiobookTaskWhereInput;
}

/** `encoding` is the only durable state that startup recovery schedules. */
export function readBackgroundM4bState(
  resultJson: string | null | undefined,
): BackgroundM4bState | null {
  if (!resultJson?.trim()) return null;
  try {
    const parsed = JSON.parse(resultJson) as { m4b?: { status?: unknown } };
    const status = parsed?.m4b?.status;
    return status === "encoding" || status === "ready" || status === "skipped" || status === "failed"
      ? status
      : null;
  } catch {
    return null;
  }
}

/** Summary projection intentionally hides the in-progress encoding marker. */
export function readTerminalM4bState(
  resultJson: string | null | undefined,
): TerminalM4bState | null {
  const state = readBackgroundM4bState(resultJson);
  return state === "ready" || state === "skipped" || state === "failed" ? state : null;
}

/** Invalidate only the derived m4b projection while retaining task diagnostics. */
export function removeM4bFromResultJson(
  resultJson: string | null | undefined,
): string | null {
  if (resultJson == null || !resultJson.trim()) return resultJson ?? null;
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return resultJson;
    const { m4b: _removed, ...rest } = parsed as Record<string, unknown> & { m4b?: unknown };
    return JSON.stringify(rest);
  } catch {
    // Preserve corrupt legacy data verbatim. It has no readable m4b projection,
    // and discarding unrelated diagnostics would make recovery less observable.
    return resultJson;
  }
}

/** Preserve non-m4b result fields while replacing the complete terminal projection. */
export function mergeM4bIntoResultJson(
  resultJson: string | null | undefined,
  m4b: {
    status: TerminalM4bState;
    path?: string | null;
    reason?: string | null;
    bytes?: number | null;
    chapterCount?: number | null;
  },
): string {
  let base: Record<string, unknown> = {};
  if (resultJson?.trim()) {
    try {
      const parsed = JSON.parse(resultJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // A valid structured m4b terminal state is more useful than corrupt legacy JSON.
    }
  }
  return JSON.stringify({
    ...base,
    m4b: {
      status: m4b.status,
      path: m4b.path ?? null,
      reason: m4b.reason ?? null,
      bytes: m4b.bytes ?? null,
      chapterCount: m4b.chapterCount ?? null,
    },
  });
}

/** Preserve existing m4b metadata while marking only its state as in progress. */
export function markM4bEncodingInResultJson(resultJson: string | null | undefined): string {
  let base: Record<string, unknown> = {};
  if (resultJson?.trim()) {
    try {
      const parsed = JSON.parse(resultJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // Rebuild from the durable marker when legacy JSON is corrupt.
    }
  }
  return JSON.stringify({
    ...base,
    m4b: {
      ...(typeof base.m4b === "object" && base.m4b ? base.m4b as Record<string, unknown> : {}),
      status: "encoding",
    },
  });
}
