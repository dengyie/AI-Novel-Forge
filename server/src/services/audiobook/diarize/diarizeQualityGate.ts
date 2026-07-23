import type {
  AudiobookChapterAnnotation,
  AudiobookDialogueSegment,
  AudiobookDiarizeChapterStats,
  AudiobookQualityFlag,
} from "@ai-novel/shared/types/audiobook";
import { resolveSegmentChannel } from "./renderPolicy";
import { runRuleSpanPass, type RuleSpan } from "./ruleSpanPass";

export interface DiarizeGateThresholds {
  minSpokenQuoteCoverage: number;
  maxUnresolvedRatio: number;
}

export const DEFAULT_DIARIZE_GATE: DiarizeGateThresholds = {
  minSpokenQuoteCoverage: 0.85,
  maxUnresolvedRatio: 0.15,
};

function normalizeLoose(text: string): string {
  return text.replace(/\s+/g, "").trim();
}

/**
 * span 文本是否被某段覆盖（子串双向，宽松）。
 */
export function spanCoveredBySegments(
  span: RuleSpan,
  segments: AudiobookDialogueSegment[],
): { covered: boolean; asSkipChannel: boolean } {
  const needle = normalizeLoose(span.text);
  if (!needle) return { covered: true, asSkipChannel: false };

  for (const seg of segments) {
    const hay = normalizeLoose(seg.text);
    if (!hay) continue;
    if (!hay.includes(needle) && !needle.includes(hay)) continue;

    const { segmentKind, renderPolicy } = resolveSegmentChannel(seg);
    if (!span.shouldSpeak) {
      // 通道 skip 类：正确处置 = skip 或对应 kind
      if (
        renderPolicy === "skip"
        || segmentKind === "typed"
        || segmentKind === "chat"
        || segmentKind === "on_screen"
      ) {
        return { covered: true, asSkipChannel: true };
      }
      // 被错误念出也算「覆盖到了文本」，但 asSkipChannel=false 供审计
      return { covered: true, asSkipChannel: false };
    }

    // 应出声：需落在可合成的 speech/phone/broadcast/quote_read 角色或旁白电话等
    if (renderPolicy === "skip") {
      continue;
    }
    if (
      segmentKind === "speech"
      || segmentKind === "phone"
      || segmentKind === "broadcast"
      || segmentKind === "quote_read"
      || (seg.speakerKind === "character" && !segmentKind)
    ) {
      return { covered: true, asSkipChannel: false };
    }
    // 落在 narration 不算 spoken 覆盖
  }
  return { covered: false, asSkipChannel: false };
}

export function computeDiarizeChapterStats(input: {
  content: string;
  segments: AudiobookDialogueSegment[];
  wholeChapterNarratorFallback?: boolean;
  assemblySource?: AudiobookDiarizeChapterStats["assemblySource"];
  thresholds?: Partial<DiarizeGateThresholds>;
}): AudiobookDiarizeChapterStats {
  const gate = { ...DEFAULT_DIARIZE_GATE, ...input.thresholds };
  const pass = runRuleSpanPass(input.content);
  const fallback = input.wholeChapterNarratorFallback === true;

  let quoteCoveredCount = 0;
  let spokenQuoteCoveredCount = 0;
  let typedSkippedCount = 0;
  let chatSkippedCount = 0;
  let onScreenSkippedCount = 0;
  let speechCharacterCount = 0;
  let narrationCount = 0;
  let unresolvedSpeakerCount = 0;

  for (const seg of input.segments) {
    const { segmentKind, renderPolicy } = resolveSegmentChannel(seg);
    if (seg.speakerUnresolved) unresolvedSpeakerCount += 1;
    if (segmentKind === "narration" || (seg.speakerKind === "narrator" && !seg.segmentKind)) {
      narrationCount += 1;
    }
    if (seg.speakerKind === "character" && renderPolicy !== "skip") {
      speechCharacterCount += 1;
    }
    if (renderPolicy === "skip") {
      if (segmentKind === "typed") typedSkippedCount += 1;
      if (segmentKind === "chat") chatSkippedCount += 1;
      if (segmentKind === "on_screen") onScreenSkippedCount += 1;
    }
  }

  const quoteLike = pass.spans.filter((s) =>
    s.kind === "quote" || s.kind === "typed" || s.kind === "chat"
    || s.kind === "on_screen" || s.kind === "phone"
  );
  for (const span of quoteLike) {
    const { covered } = spanCoveredBySegments(span, input.segments);
    if (covered) quoteCoveredCount += 1;
    if (span.shouldSpeak) {
      const spoken = spanCoveredBySegments(span, input.segments);
      // 应出声：需 covered 且非纯 skip 错置——spanCoveredBySegments 对 shouldSpeak 已要求 tts speech*
      if (spoken.covered) spokenQuoteCoveredCount += 1;
    }
  }

  const quoteSpanCount = quoteLike.length;
  const spokenQuoteSpanCount = pass.spokenQuoteSpanCount;
  const quoteCoverage = quoteSpanCount === 0 ? 1 : quoteCoveredCount / quoteSpanCount;
  const spokenQuoteCoverage =
    spokenQuoteSpanCount === 0 ? 1 : spokenQuoteCoveredCount / spokenQuoteSpanCount;

  const failReasons: string[] = [];
  if (fallback) {
    failReasons.push("whole_chapter_narrator_fallback");
  }
  if (spokenQuoteSpanCount > 0 && spokenQuoteCoverage < gate.minSpokenQuoteCoverage) {
    failReasons.push(
      `spoken_quote_coverage ${spokenQuoteCoverage.toFixed(2)} < ${gate.minSpokenQuoteCoverage}`,
    );
  }
  if (speechCharacterCount > 0) {
    const ratio = unresolvedSpeakerCount / speechCharacterCount;
    if (ratio > gate.maxUnresolvedRatio) {
      failReasons.push(
        `unresolved_ratio ${ratio.toFixed(2)} > ${gate.maxUnresolvedRatio}`,
      );
    }
  }

  const castOk = failReasons.length === 0;

  return {
    quoteSpanCount,
    quoteCoveredCount,
    quoteCoverage: round4(quoteCoverage),
    spokenQuoteCoverage: round4(spokenQuoteCoverage),
    spokenQuoteSpanCount,
    spokenQuoteCoveredCount,
    typedSkippedCount,
    chatSkippedCount,
    onScreenSkippedCount,
    speechCharacterCount,
    narrationCount,
    unresolvedSpeakerCount,
    wholeChapterNarratorFallback: fallback,
    castOk,
    failReasons: failReasons.length ? failReasons : undefined,
    assemblySource: input.assemblySource ?? null,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function collectTaskQualityFlags(
  annotations: AudiobookChapterAnnotation[],
): AudiobookQualityFlag[] {
  const flags = new Set<AudiobookQualityFlag>();
  let anyDegraded = false;
  let anyOk = false;

  for (const ann of annotations) {
    const stats = ann.diarizeStats;
    const fallback =
      ann.wholeChapterNarratorFallback === true
      || stats?.wholeChapterNarratorFallback === true
      || Boolean(ann.error?.trim());
    if (fallback) {
      flags.add("narrator_fallback");
      anyDegraded = true;
    }
    if (stats) {
      if (stats.castOk) anyOk = true;
      else anyDegraded = true;
      if (
        stats.spokenQuoteSpanCount > 0
        && stats.spokenQuoteCoverage < DEFAULT_DIARIZE_GATE.minSpokenQuoteCoverage
      ) {
        flags.add("low_quote_coverage");
        anyDegraded = true;
      }
      if (
        stats.speechCharacterCount > 0
        && stats.unresolvedSpeakerCount / stats.speechCharacterCount
          > DEFAULT_DIARIZE_GATE.maxUnresolvedRatio
      ) {
        flags.add("high_unresolved");
        anyDegraded = true;
      }
    } else if (!fallback && ann.segments.some((s) => s.speakerKind === "character")) {
      anyOk = true;
    }
  }

  if (anyDegraded) flags.add("cast_degraded");
  else if (annotations.length > 0) flags.add("cast_ok");
  if (anyOk && anyDegraded) {
    // 部分章 ok 仍 degraded
    flags.add("cast_degraded");
    flags.delete("cast_ok");
  }

  return [...flags];
}

export function buildQualityCompletionLabel(input: {
  qualityFlags: AudiobookQualityFlag[];
  narratorFallbackCount: number;
  m4bReady: boolean;
  m4bNote?: string;
}): string {
  const m4b = input.m4bReady
    ? "，含 m4b"
    : input.m4bNote
      ? `；${input.m4bNote}`
      : "";
  if (input.qualityFlags.includes("narrator_fallback") || input.narratorFallbackCount > 0) {
    return `完成（降级：${input.narratorFallbackCount || "?"} 章旁白回退${m4b}）`;
  }
  if (input.qualityFlags.includes("low_quote_coverage")) {
    return `完成（降级：对白覆盖不足${m4b}）`;
  }
  if (input.qualityFlags.includes("high_unresolved")) {
    return `完成（降级：未匹配角色偏多${m4b}）`;
  }
  if (input.qualityFlags.includes("cast_degraded")) {
    return `完成（降级${m4b}）`;
  }
  if (input.m4bReady) return "有声书生成完成（多角色，含 m4b）";
  return "有声书生成完成（多角色）";
}

/** 整章旁白回退判定（兼容仅有 error 的旧数据） */
export function isWholeChapterNarratorFallback(
  annotation: AudiobookChapterAnnotation,
): boolean {
  if (annotation.wholeChapterNarratorFallback === true) return true;
  if (annotation.diarizeStats?.wholeChapterNarratorFallback === true) return true;
  if (annotation.error?.trim()) return true;
  return false;
}
