import { createHash } from "node:crypto";
import type { NovelFactEntry } from "../fact/NovelFactService";

export interface ChapterPlanFactRefresh { fingerprint: string }

export function fingerprintPlanningFacts(facts: Pick<NovelFactEntry, "chapterOrder" | "category" | "text">[]): string {
  const canonical = facts.map(({ chapterOrder, category, text }) =>
    JSON.stringify([chapterOrder, category, text.trim()])).sort();
  return createHash("sha256").update(JSON.stringify([...new Set(canonical)])).digest("hex");
}

function readMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function readPlanningFactFingerprint(raw: string | null | undefined): string | null {
  const value = readMetadata(raw).jitPlanning;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fingerprint = (value as Record<string, unknown>).factFingerprint;
  return typeof fingerprint === "string" ? fingerprint : null;
}

export function recordPlanningFactFingerprint(raw: string | null | undefined, fingerprint: string): string {
  return JSON.stringify({ ...readMetadata(raw), jitPlanning: { factFingerprint: fingerprint } });
}
