import { AUDIOBOOK_CHUNK_MAX_CHARS } from "@ai-novel/shared/types/audiobook";

/**
 * 将一段旁白/对白切成 ≤maxChars 的 TTS 块。
 * 优先在句号/问号/叹号/分号/换行处断开，其次逗号，最后硬切。
 */
export function splitTextForTts(
  text: string,
  maxChars: number = AUDIOBOOK_CHUNK_MAX_CHARS,
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  if (maxChars < 1) {
    throw new Error("maxChars must be >= 1");
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    let splitAt = findPreferSplit(window);
    if (splitAt <= 0) {
      splitAt = maxChars;
    }
    const piece = remaining.slice(0, splitAt).trim();
    if (piece) {
      chunks.push(piece);
    }
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findPreferSplit(window: string): number {
  const hardBreaks = ["\n", "。", "！", "？", "；", "!", "?", ";", "…"];
  for (const mark of hardBreaks) {
    const idx = window.lastIndexOf(mark);
    if (idx > 0) {
      return idx + mark.length;
    }
  }

  const softBreaks = ["，", ",", "、", " "];
  for (const mark of softBreaks) {
    const idx = window.lastIndexOf(mark);
    if (idx > Math.floor(window.length * 0.4)) {
      return idx + mark.length;
    }
  }

  return -1;
}
