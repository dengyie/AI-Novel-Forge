/**
 * LLM diarize 后置修复：
 * 1) 误标 skip（把应出声对白标成 on_screen/chat）→ 纠正为 speech/phone
 * 2) 应出声 quote 未被任何 tts 段覆盖 → 用规则 span 补洞
 *
 * 在 overlayChannelSkips **之前**跑纠正；补洞在 overlay **之后**再跑一轮覆盖检查也可，
 * 默认管线：materialize → repairFalseChannelSkips → overlayChannelSkips → fillUncoveredSpokenQuotes
 */

import type {
  AudiobookCharacterVoiceConfig,
  AudiobookDialogueSegment,
  AudiobookNarratorConfig,
  AudiobookSegmentKind,
} from "@ai-novel/shared/types/audiobook";
import { spanCoveredBySegments } from "./diarizeQualityGate";
import { defaultRenderPolicyForKind } from "./renderPolicy";
import { runRuleSpanPass, type RuleSpan } from "./ruleSpanPass";
import {
  guestStyleForUnresolvedName,
  pickGuestPresetVoice,
} from "./guestVoice";

function norm(s: string): string {
  return s.replace(/\s+/g, "").trim();
}

function textLooselyMatches(segText: string, spanText: string): boolean {
  const a = norm(segText);
  const b = norm(spanText);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.length >= 2 && a.includes(b) && b.length / a.length >= 0.7) return true;
  if (a.length >= 2 && b.includes(a) && a.length / b.length >= 0.7) return true;
  return false;
}

function findSpokenSpanForSeg(
  seg: AudiobookDialogueSegment,
  spokenSpans: RuleSpan[],
): RuleSpan | null {
  for (const span of spokenSpans) {
    if (textLooselyMatches(seg.text, span.text)) return span;
  }
  return null;
}

/**
 * 纠正：LLM 把应出声 quote 标成 typed/chat/on_screen(skip)。
 * 规则 span shouldSpeak=true 时升级为 speech 或 phone，恢复 tts。
 */
export function repairFalseChannelSkips(
  content: string,
  segments: AudiobookDialogueSegment[],
  narrator?: AudiobookNarratorConfig | null,
): AudiobookDialogueSegment[] {
  if (segments.length === 0) return segments;
  const pass = runRuleSpanPass(content);
  const spoken = pass.spans.filter((s) => s.shouldSpeak);
  if (spoken.length === 0) return segments;

  const narrVoice = narrator?.voice ?? "茉莉";
  const narrStyle = narrator?.style ?? null;

  return segments.map((seg) => {
    const kind = seg.segmentKind;
    // 只纠 on_screen：typed/chat 有强线索，且短词（如「收到」）易与别处 speech 误配
    if (!(seg.renderPolicy === "skip" && kind === "on_screen")) return seg;

    const span = findSpokenSpanForSeg(seg, spoken);
    if (!span) return seg;
    // 规则侧若该 quote 实为 skip 通道，不升级
    if (span.kind === "typed" || span.kind === "chat" || span.kind === "on_screen") {
      return seg;
    }

    const nextKind: AudiobookSegmentKind =
      span.kind === "phone" ? "phone" : "speech";
    const name =
      (span.speakerHint ?? seg.unresolvedSpeakerName ?? seg.speakerLabel ?? "")
        .trim();
    const label =
      name && name !== "屏幕" && name !== "消息" && name !== "打字"
        ? name
        : "旁白";
    const guestVoice = pickGuestPresetVoice(
      label === "旁白" ? span.speakerHint : label,
      narrVoice,
    );
    const useGuest = Boolean(span.speakerHint?.trim()) && label !== "旁白";

    return {
      ...seg,
      segmentKind: nextKind,
      renderPolicy: "tts",
      channelHint: span.channelHint ?? nextKind,
      // 保留原 character 归属（若有）；否则 narrator + 可选 guest
      speakerKind: seg.characterId ? "character" as const : "narrator" as const,
      characterId: seg.characterId ?? null,
      speakerLabel: seg.characterId
        ? (seg.speakerLabel || label)
        : label,
      speakerUnresolved: seg.characterId
        ? false
        : (useGuest || Boolean(span.speakerHint?.trim())),
      unresolvedSpeakerName: seg.characterId
        ? null
        : (span.speakerHint?.trim() || null),
      ttsMode: seg.characterId ? (seg.ttsMode || "preset") : "preset" as const,
      voice: seg.characterId
        ? (seg.voice || narrVoice)
        : (useGuest ? guestVoice : narrVoice),
      style: seg.characterId
        ? (seg.style ?? narrStyle ?? null)
        : (useGuest
          ? guestStyleForUnresolvedName(span.speakerHint)
          : (narrStyle ?? seg.style)),
      baseStyle: seg.characterId
        ? (seg.baseStyle ?? seg.style ?? narrStyle ?? null)
        : (useGuest
          ? guestStyleForUnresolvedName(span.speakerHint)
          : (narrStyle ?? seg.baseStyle)),
      baseDesignPrompt: seg.characterId ? (seg.baseDesignPrompt ?? null) : null,
      designPrompt: seg.characterId ? (seg.designPrompt ?? null) : null,
      delivery: null,
      deliveryMergeKey: "none",
      quoteSpanIds: Array.from(
        new Set([...(seg.quoteSpanIds ?? []), span.id]),
      ),
      diarizeConfidence: Math.min(seg.diarizeConfidence ?? 0.7, 0.65),
    };
  });
}

function contentOffset(content: string, text: string): number {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return Number.MAX_SAFE_INTEGER;
  const candidates = [t, `「${t}」`, `“${t}”`, `"${t}"`, `『${t}』`];
  let best = -1;
  for (const c of candidates) {
    const at = content.indexOf(c);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  if (best >= 0) return best;
  const n = norm(t);
  const hay = norm(content);
  const at = hay.indexOf(n);
  return at >= 0 ? at : Number.MAX_SAFE_INTEGER;
}

function buildSpeechFromSpan(input: {
  span: RuleSpan;
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
  index: number;
}): AudiobookDialogueSegment {
  const text = input.span.text.replace(/\r\n/g, "\n").trim();
  const kind: AudiobookSegmentKind =
    input.span.kind === "phone" ? "phone" : "speech";
  const hint = input.span.speakerHint?.trim() || null;

  // 轻量角色匹配（与 materialize 一致的别名/精确）
  let matched: AudiobookCharacterVoiceConfig | null = null;
  if (hint) {
    const normName = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    for (const item of input.characterVoices) {
      const names = [item.characterName, ...(item.speakerAliases ?? [])]
        .map((n) => n?.trim())
        .filter((n): n is string => Boolean(n));
      if (names.some((n) => n === hint || normName(n) === normName(hint))) {
        matched = item;
        break;
      }
    }
  }

  if (matched) {
    const mode = matched.ttsMode?.trim() || "preset";
    const ttsMode = mode === "design" || mode === "clone" ? mode : "preset";
    return {
      index: input.index,
      speakerKind: "character",
      characterId: matched.characterId,
      speakerLabel: matched.characterName,
      text,
      segmentKind: kind,
      renderPolicy: "tts",
      channelHint: input.span.channelHint ?? kind,
      quoteSpanIds: [input.span.id],
      ttsMode,
      voice: matched.ttsVoice?.trim() || "",
      style: matched.ttsStyle ?? input.narrator.style,
      baseStyle: matched.ttsStyle ?? input.narrator.style,
      baseDesignPrompt: matched.ttsDesignPrompt ?? null,
      designPrompt: matched.ttsDesignPrompt ?? null,
      refAudioPath: matched.ttsRefAudioPath ?? null,
      delivery: null,
      deliveryMergeKey: "none",
      diarizeConfidence: 0.55,
    };
  }

  const guestVoice = pickGuestPresetVoice(hint, input.narrator.voice);
  const useGuest = Boolean(hint);
  return {
    index: input.index,
    speakerKind: "narrator",
    characterId: null,
    speakerLabel: hint || "旁白",
    text,
    segmentKind: kind,
    renderPolicy: defaultRenderPolicyForKind(kind),
    channelHint: input.span.channelHint ?? "quote_fill",
    quoteSpanIds: [input.span.id],
    ttsMode: "preset",
    voice: useGuest ? guestVoice : input.narrator.voice,
    style: useGuest
      ? guestStyleForUnresolvedName(hint)
      : input.narrator.style,
    baseStyle: useGuest
      ? guestStyleForUnresolvedName(hint)
      : input.narrator.style,
    delivery: null,
    deliveryMergeKey: "none",
    speakerUnresolved: true,
    unresolvedSpeakerName: hint,
    diarizeConfidence: 0.45,
  };
}

/**
 * 规则 shouldSpeak quote 未被 tts speech/phone 覆盖时补段。
 * 按正文偏移插入，避免只 append 打乱听序。
 */
export function fillUncoveredSpokenQuotes(input: {
  content: string;
  segments: AudiobookDialogueSegment[];
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
}): AudiobookDialogueSegment[] {
  const content = input.content.replace(/\r\n/g, "\n");
  const pass = runRuleSpanPass(content);
  const spoken = pass.spans.filter((s) => s.shouldSpeak);
  if (spoken.length === 0) {
    return input.segments.map((s, i) => ({ ...s, index: i }));
  }

  const missing = spoken.filter((span) => {
    const { covered } = spanCoveredBySegments(span, input.segments);
    return !covered;
  });
  if (missing.length === 0) {
    return input.segments.map((s, i) => ({ ...s, index: i }));
  }

  type Placed = { start: number; seg: AudiobookDialogueSegment };
  const placed: Placed[] = input.segments.map((seg) => ({
    start: contentOffset(content, seg.text),
    seg: { ...seg },
  }));

  for (const span of missing) {
    const seg = buildSpeechFromSpan({
      span,
      narrator: input.narrator,
      characterVoices: input.characterVoices,
      index: 0,
    });
    placed.push({ start: span.start, seg });
  }

  placed.sort((a, b) => a.start - b.start || a.seg.index - b.seg.index);
  return placed.map((p, i) => ({ ...p.seg, index: i }));
}

/**
 * finishAnnotation 用：纠正误 skip → overlay 前；补洞在 overlay 后由调用方再调 fill。
 */
export function repairChannelsBeforeOverlay(
  content: string,
  segments: AudiobookDialogueSegment[],
  narrator?: AudiobookNarratorConfig | null,
): AudiobookDialogueSegment[] {
  return repairFalseChannelSkips(content, segments, narrator);
}
