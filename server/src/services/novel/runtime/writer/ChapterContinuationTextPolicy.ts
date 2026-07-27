import { buildNGramSet, jaccardSimilarity } from "@ai-novel/shared/utils/textSimilarity";
import { resolveTargetWordRange } from "../../../../prompting/prompts/novel/chapterLayeredContext";

export const CONTINUATION_ECHO_SIMILARITY_THRESHOLD = 0.45;
export const LENGTH_RECOVERY_MIN_USEFUL_DELTA_CHARS = 80;
const MIN_CHAR_OVERLAP = 12;

export function countChapterCharacters(content: string): number {
  return content.replace(/\s+/g, "").trim().length;
}

export function buildLengthInstruction(targetWordCount?: number | null): {
  targetWordCount: number | null;
  minWordCount: number | null;
  maxWordCount: number | null;
  instruction: string;
} {
  const range = resolveTargetWordRange(targetWordCount);
  if (range.targetWordCount == null) {
    return {
      ...range,
      instruction: "Write a complete readable chapter with enough concrete events and scene substance; do not end abruptly or obviously too short.",
    };
  }
  return {
    ...range,
    instruction: `Write about ${range.targetWordCount} Chinese characters. Acceptable range: ${range.minWordCount}-${range.maxWordCount}. Do not end clearly below the minimum.`,
  };
}

export function buildDraftContinuationBlock(
  content: string,
  targetWordCount: number,
  minWordCount: number,
): string {
  const trimmed = content.trim();
  const excerpt = trimmed.length > 1400 ? trimmed.slice(-1400) : trimmed;
  return [
    `Current saved draft length: ${countChapterCharacters(trimmed)} Chinese characters.`,
    `Target length: about ${targetWordCount} Chinese characters. Minimum acceptable length: ${minWordCount}.`,
    "Continue from the existing ending. Do not restart the chapter. Do not repeat already written events.",
    "Write only Chinese narrative prose. No English meta commentary, writing plans, or task checklists.",
    "Do not pad with pure atmosphere, weather loops, or repeated sensory description without new plot/relationship movement.",
    "Current draft tail (continue after this):",
    excerpt || "none",
  ].join("\n");
}

function longestSuffixPrefixOverlap(draftTail: string, appended: string): number {
  const maxLen = Math.min(draftTail.length, appended.length, 600);
  for (let size = maxLen; size >= MIN_CHAR_OVERLAP; size -= 1) {
    if (draftTail.endsWith(appended.slice(0, size))) return size;
  }
  return 0;
}

export function trimContinuationOverlap(draftTail: string, appended: string): string {
  const appendedLines = appended.split("\n");
  const tailLines = draftTail.split("\n").filter((line) => line.trim().length > 0);
  const maxOverlap = Math.min(appendedLines.length, tailLines.length);
  let overlap = 0;
  for (let size = maxOverlap; size > 0; size -= 1) {
    const tailSlice = tailLines.slice(-size).map((line) => line.trim());
    const headSlice = appendedLines.slice(0, size).map((line) => line.trim());
    if (tailSlice.every((line, index) => line.length > 0 && line === headSlice[index])) {
      overlap = size;
      break;
    }
  }
  if (overlap > 0) return appendedLines.slice(overlap).join("\n").trim();

  const normalizedTail = draftTail.replace(/\s+/g, "");
  const normalizedAppended = appended.replace(/\s+/g, "");
  const charOverlap = longestSuffixPrefixOverlap(normalizedTail, normalizedAppended);
  if (charOverlap > 0) {
    let consumed = 0;
    let cutIndex = 0;
    while (cutIndex < appended.length && consumed < charOverlap) {
      if (!/\s/.test(appended[cutIndex])) consumed += 1;
      cutIndex += 1;
    }
    return appended.slice(cutIndex).trim();
  }
  return appended.trim();
}

export function continuationEchoSimilarity(draftTail: string, appended: string): number {
  if (!draftTail.trim() || !appended.trim()) return 0;
  return jaccardSimilarity(buildNGramSet(draftTail), buildNGramSet(appended));
}
