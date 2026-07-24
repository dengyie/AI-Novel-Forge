/**
 * L1 Frontend — Chunker（M4）
 *
 * 定位（借鉴 CosyVoice frontend：`split → normalize → sanitize → assemble model_input`）：
 *   - 段（`AudiobookDialogueSegment`）→ TTS 作业（`ChunkJob`）的**唯一入口**；
 *   - 内嵌 sanitize（收编 `diarize/ttsTextSanitize`）与 TextNormalizer（当前透传）；
 *   - 保持 `expandSegmentsToChunkJobs` / `coalesceSegmentsBySpeaker` / `splitTextForTts`
 *     的旧公共签名与语义，供旧 caller（annotate/pipeline 等）与门禁 test 零改。
 *
 * 与旧实现的等价性（M4 交付门）：
 *   - **同输入 →** 逐 chunk `text` 与顺序 byte-identical；
 *   - **同 segment stream →** `chunkLayoutFingerprint` 保持稳定（hash 输入不变）。
 *
 * 位置：`server/src/services/audiobook/frontend/chunker.ts`
 * 收编来源：
 *   - `server/src/services/audiobook/audiobookChunk.ts`（原实现，逐字节转移）
 *   - `server/src/services/audiobook/diarize/ttsTextSanitize.ts`（`sanitizeTtsChunkText` 内联复用）
 */

import {
  AUDIOBOOK_CHUNK_MAX_CHARS,
  type AudiobookDialogueSegment,
} from "@ai-novel/shared/types/audiobook";
import { speakerKeyFromSegment } from "../audiobookGap";
import { shouldSynthesizeSegment } from "../diarize/renderPolicy";
import { sanitizeTtsChunkText } from "../diarize/ttsTextSanitize";
import { normalizeTtsChunkText } from "./textNormalizer";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export interface ChunkJob {
  segment: AudiobookDialogueSegment;
  text: string;
  globalChunkIndex: number;
}

// ---------------------------------------------------------------------------
// 分句 / split
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 合并 / coalesce（group_by_speaker）
// ---------------------------------------------------------------------------

/**
 * 同说话人连续段合并（group_by_speaker），再按 maxChars 切 TTS 块。
 * 合并条件：speakerKey 相同，且 ttsMode / voice / refAudioPath / deliveryMergeKey 一致。
 * deliveryMergeKey 缺省时回退 style+designPrompt 字符串全等（兼容旧 annotations）。
 * 合并后 index 重排；文本用换行拼接，避免两句黏连；style/design 取段首。
 */
export function coalesceSegmentsBySpeaker(
  segments: AudiobookDialogueSegment[],
): AudiobookDialogueSegment[] {
  const merged: AudiobookDialogueSegment[] = [];
  for (const segment of segments) {
    // skip 通道不参与合并与合成
    if (!shouldSynthesizeSegment(segment)) {
      continue;
    }
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

// ---------------------------------------------------------------------------
// 主入口：段 → chunk 作业
// ---------------------------------------------------------------------------

/**
 * 段 → TTS chunk 作业：过滤 skip → group_by_speaker 合并 → split → TN 归一 → sanitize。
 *
 * TN 目前透传，为读音词典/方言保留位；不影响 chunk text 与 fingerprint。
 */
export function expandSegmentsToChunkJobs(segments: AudiobookDialogueSegment[]): ChunkJob[] {
  const coalesced = coalesceSegmentsBySpeaker(segments);
  const items: ChunkJob[] = [];
  let globalChunkIndex = 0;
  for (const segment of coalesced) {
    const pieces = splitTextForTts(segment.text);
    if (pieces.length === 0) {
      continue;
    }
    for (const raw of pieces) {
      const normalized = normalizeTtsChunkText(raw, {
        speakerKey: speakerKeyFromSegment(segment),
      });
      const text = sanitizeTtsChunkText(normalized);
      if (!text) {
        continue;
      }
      items.push({ segment, text, globalChunkIndex });
      globalChunkIndex += 1;
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function canMergeSegments(
  prev: AudiobookDialogueSegment,
  next: AudiobookDialogueSegment,
): boolean {
  // 不同通道不合并（speech 与 phone 等）
  if ((prev.segmentKind ?? null) !== (next.segmentKind ?? null)) {
    return false;
  }
  if ((prev.renderPolicy ?? null) !== (next.renderPolicy ?? null)) {
    return false;
  }
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
  if ((prev.refAudioPath ?? "").trim() !== (next.refAudioPath ?? "").trim()) {
    return false;
  }

  // D7：两侧都有 mergeKey 才用桶；仅一侧有 key 时回退 style/design 全等（防 undefined??"none" 误合并）
  const prevKey = prev.deliveryMergeKey;
  const nextKey = next.deliveryMergeKey;
  const prevHasKey = prevKey != null && String(prevKey).length > 0;
  const nextHasKey = nextKey != null && String(nextKey).length > 0;
  if (prevHasKey && nextHasKey) {
    return prevKey === nextKey;
  }
  if ((prev.style ?? "").trim() !== (next.style ?? "").trim()) {
    return false;
  }
  if ((prev.designPrompt ?? "").trim() !== (next.designPrompt ?? "").trim()) {
    return false;
  }
  return true;
}

function findPreferSplit(window: string): number {
  // 硬断：句号/问叹/分号/换行 — 优先保留句级气口，避免长对白在逗号处打断情绪弧
  const hardBreaks = ["\n", "。", "！", "？", "；", "!", "?", ";", "…"];
  for (const mark of hardBreaks) {
    const idx = window.lastIndexOf(mark);
    if (idx > 0) {
      return idx + mark.length;
    }
  }

  // 软断仅在窗口后 55% 且不靠前：减少「情绪半句」切开
  const softBreaks = ["，", ",", "、", " "];
  const softMin = Math.floor(window.length * 0.55);
  for (const mark of softBreaks) {
    const idx = window.lastIndexOf(mark);
    if (idx >= softMin) {
      return idx + mark.length;
    }
  }

  return -1;
}
