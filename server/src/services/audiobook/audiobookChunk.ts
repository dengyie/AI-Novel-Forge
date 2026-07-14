import {
  AUDIOBOOK_CHUNK_MAX_CHARS,
  type AudiobookDialogueSegment,
} from "@ai-novel/shared/types/audiobook";
import { speakerKeyFromSegment } from "./audiobookGap";

/**
 * 将一段旁白/对白切成 ≤maxChars 的 TTS 块。
 * 优先在句号/问号/叹号/分号/换行处断开，其次逗号，最后硬切。
 * 切片不丢弃中间空白，chunks.join("") 可还原 trim 后的原文。
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
    const piece = remaining.slice(0, splitAt);
    if (piece.length > 0) {
      chunks.push(piece);
    }
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * 同说话人连续段合并（group_by_speaker），再按 maxChars 切 TTS 块。
 * 合并条件：speakerKey 相同，且 ttsMode / voice / style / designPrompt / refAudioPath 一致。
 * 合并后 index 重排；文本用换行拼接，避免两句黏连。
 */
export function coalesceSegmentsBySpeaker(
  segments: AudiobookDialogueSegment[],
): AudiobookDialogueSegment[] {
  const merged: AudiobookDialogueSegment[] = [];
  for (const segment of segments) {
    const text = segment.text.replace(/\r\n/g, "\n").trim();
    if (!text) {
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev && canMergeSegments(prev, segment)) {
      prev.text = `${prev.text}\n${text}`;
      continue;
    }
    merged.push({
      ...segment,
      text,
      index: merged.length,
    });
  }
  return merged;
}

/**
 * 段 → TTS chunk 作业：先 group_by_speaker 合并，再 splitTextForTts。
 */
export function expandSegmentsToChunkJobs(segments: AudiobookDialogueSegment[]): Array<{
  segment: AudiobookDialogueSegment;
  text: string;
  globalChunkIndex: number;
}> {
  const coalesced = coalesceSegmentsBySpeaker(segments);
  const items: Array<{ segment: AudiobookDialogueSegment; text: string; globalChunkIndex: number }> = [];
  let globalChunkIndex = 0;
  for (const segment of coalesced) {
    const pieces = splitTextForTts(segment.text);
    if (pieces.length === 0) {
      continue;
    }
    for (const text of pieces) {
      items.push({ segment, text, globalChunkIndex });
      globalChunkIndex += 1;
    }
  }
  return items;
}

function canMergeSegments(
  prev: AudiobookDialogueSegment,
  next: AudiobookDialogueSegment,
): boolean {
  if (speakerKeyFromSegment(prev) !== speakerKeyFromSegment(next)) {
    return false;
  }
  const modeA = (prev.ttsMode?.trim() || "preset");
  const modeB = (next.ttsMode?.trim() || "preset");
  if (modeA !== modeB) {
    return false;
  }
  if ((prev.voice ?? "").trim() !== (next.voice ?? "").trim()) {
    return false;
  }
  if ((prev.style ?? "").trim() !== (next.style ?? "").trim()) {
    return false;
  }
  if ((prev.designPrompt ?? "").trim() !== (next.designPrompt ?? "").trim()) {
    return false;
  }
  if ((prev.refAudioPath ?? "").trim() !== (next.refAudioPath ?? "").trim()) {
    return false;
  }
  return true;
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
