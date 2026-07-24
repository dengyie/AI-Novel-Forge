/**
 * L1 Rule Assembly：规则预切 + 说话人启发式 → 可合成 annotation segments。
 * 用于 LLM diarize 失败时的产品化托底（非整章旁白）。
 */

import type {
  AudiobookCharacterVoiceConfig,
  AudiobookDialogueSegment,
  AudiobookNarratorConfig,
  AudiobookSegmentKind,
  AudiobookRenderPolicy,
} from "@ai-novel/shared/types/audiobook";
import { defaultRenderPolicyForKind } from "./renderPolicy";
import {
  guestStyleForUnresolvedName,
  pickGuestPresetVoice,
} from "./guestVoice";
import { runRuleSpanPass, type RuleSpan } from "./ruleSpanPass";

export interface RuleAssemblyInput {
  content: string;
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
}

export interface RuleAssemblyResult {
  segments: AudiobookDialogueSegment[];
  spans: RuleSpan[];
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function buildCharacterIndex(characterVoices: AudiobookCharacterVoiceConfig[]) {
  const byExact = new Map<string, AudiobookCharacterVoiceConfig>();
  const byNormalized = new Map<string, AudiobookCharacterVoiceConfig>();
  for (const item of characterVoices) {
    const names = [item.characterName, ...(item.speakerAliases ?? [])]
      .map((n) => n?.trim())
      .filter((n): n is string => Boolean(n));
    for (const name of names) {
      byExact.set(name, item);
      byNormalized.set(normalizeName(name), item);
    }
  }
  return { byExact, byNormalized, all: characterVoices };
}

function resolveCharacter(
  speakerName: string | null | undefined,
  index: ReturnType<typeof buildCharacterIndex>,
): AudiobookCharacterVoiceConfig | null {
  const raw = speakerName?.trim();
  if (!raw || raw === "旁白" || raw === "narrator") return null;
  const exact = index.byExact.get(raw) ?? index.byNormalized.get(normalizeName(raw));
  if (exact) return exact;
  if (raw.length < 2) return null;
  let best: AudiobookCharacterVoiceConfig | null = null;
  let bestLen = 0;
  for (const item of index.all) {
    const candidates = [item.characterName, ...(item.speakerAliases ?? [])]
      .map((n) => n?.trim())
      .filter((n): n is string => Boolean(n) && n.length >= 2);
    for (const name of candidates) {
      if (raw.includes(name) || name.includes(raw)) {
        if (name.includes(raw) && !raw.includes(name) && name.length - raw.length > 1) {
          continue;
        }
        if (name.length > bestLen) {
          best = item;
          bestLen = name.length;
        }
      }
    }
  }
  return best;
}

function kindFromSpan(span: RuleSpan): AudiobookSegmentKind {
  switch (span.kind) {
    case "typed":
      return "typed";
    case "chat":
      return "chat";
    case "on_screen":
      return "on_screen";
    case "phone":
      return "phone";
    default:
      return "speech";
  }
}

function pushNarration(
  segments: AudiobookDialogueSegment[],
  text: string,
  narrator: AudiobookNarratorConfig,
): void {
  const t = text.replace(/\r\n/g, "\n");
  if (!t.trim()) return;
  // 按段落切开，避免单段过大
  const parts = t.split(/\n{2,}/);
  for (const part of parts) {
    const piece = part.trim();
    if (!piece) continue;
    segments.push({
      index: segments.length,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: "旁白",
      text: piece,
      segmentKind: "narration",
      renderPolicy: "tts",
      channelHint: null,
      ttsMode: "preset",
      voice: narrator.voice,
      style: narrator.style,
      baseStyle: narrator.style,
      delivery: null,
      deliveryMergeKey: "none",
    });
  }
}

function pushSpanSegment(
  segments: AudiobookDialogueSegment[],
  span: RuleSpan,
  narrator: AudiobookNarratorConfig,
  index: ReturnType<typeof buildCharacterIndex>,
): void {
  const text = span.text.replace(/\r\n/g, "\n").trim();
  if (!text) return;
  const segmentKind = kindFromSpan(span);
  const renderPolicy: AudiobookRenderPolicy = defaultRenderPolicyForKind(segmentKind);

  if (renderPolicy === "skip") {
    segments.push({
      index: segments.length,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: segmentKind === "typed" ? "打字" : segmentKind === "chat" ? "消息" : "屏幕",
      text,
      segmentKind,
      renderPolicy: "skip",
      channelHint: span.channelHint ?? segmentKind,
      quoteSpanIds: [span.id],
      ttsMode: "preset",
      voice: narrator.voice,
      style: narrator.style,
      baseStyle: narrator.style,
      delivery: null,
      deliveryMergeKey: "none",
      diarizeConfidence: 0.7,
    });
    return;
  }

  const matched = resolveCharacter(span.speakerHint, index);
  if (matched) {
    const mode = matched.ttsMode?.trim() || "preset";
    const ttsMode = mode === "design" || mode === "clone" ? mode : "preset";
    segments.push({
      index: segments.length,
      speakerKind: "character",
      characterId: matched.characterId,
      speakerLabel: matched.characterName,
      text,
      segmentKind,
      renderPolicy: "tts",
      channelHint: span.channelHint ?? "speech",
      quoteSpanIds: [span.id],
      ttsMode,
      voice: matched.ttsVoice?.trim() || "",
      style: matched.ttsStyle ?? narrator.style,
      baseStyle: matched.ttsStyle ?? narrator.style,
      baseDesignPrompt: matched.ttsDesignPrompt ?? null,
      designPrompt: matched.ttsDesignPrompt ?? null,
      refAudioPath: matched.ttsRefAudioPath ?? null,
      delivery: null,
      deliveryMergeKey: "none",
      diarizeConfidence: span.speakerHint ? 0.75 : 0.55,
    });
    return;
  }

  // 有 speakerHint 但未匹配 → unresolved + 路人 preset（与旁白可辨）
  if (span.speakerHint?.trim()) {
    const hint = span.speakerHint.trim();
    const guestVoice = pickGuestPresetVoice(hint, narrator.voice);
    const guestStyle = guestStyleForUnresolvedName(hint);
    segments.push({
      index: segments.length,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: hint,
      text,
      segmentKind,
      renderPolicy: "tts",
      channelHint: span.channelHint ?? "speech",
      quoteSpanIds: [span.id],
      ttsMode: "preset",
      voice: guestVoice,
      style: guestStyle,
      baseStyle: guestStyle,
      delivery: null,
      deliveryMergeKey: "none",
      speakerUnresolved: true,
      unresolvedSpeakerName: hint,
      diarizeConfidence: 0.4,
    });
    return;
  }

  // 无说话人线索的 quote：speech + 旁白声 + unresolved，便于 coverage 计 spoken 且进 cast 分母
  // 产品选择：宁可旁白念对白也不丢 coverage；LLM 路径应补 speaker
  segments.push({
    index: segments.length,
    speakerKind: "narrator",
    characterId: null,
    speakerLabel: "旁白",
    text,
    segmentKind: "speech",
    renderPolicy: "tts",
    channelHint: "quote_orphan",
    quoteSpanIds: [span.id],
    ttsMode: "preset",
    voice: narrator.voice,
    style: narrator.style,
    baseStyle: narrator.style,
    delivery: null,
    deliveryMergeKey: "none",
    speakerUnresolved: true,
    unresolvedSpeakerName: null,
    diarizeConfidence: 0.35,
  });
}

/**
 * 按 span 切分正文：narration 间隙 + span 段。
 */
export function assembleSegmentsFromRules(input: RuleAssemblyInput): RuleAssemblyResult {
  const pass = runRuleSpanPass(input.content);
  const content = pass.normalizedContent;
  const index = buildCharacterIndex(input.characterVoices);
  const segments: AudiobookDialogueSegment[] = [];

  // 仅处理 quote-like spans
  const spans = pass.spans.filter((s) =>
    s.kind === "quote" || s.kind === "typed" || s.kind === "chat"
    || s.kind === "on_screen" || s.kind === "phone"
  );

  if (spans.length === 0) {
    pushNarration(segments, content, input.narrator);
    return { segments, spans };
  }

  let cursor = 0;
  for (const span of spans) {
    // span.start/end 是 inner；引号字符在两侧
    const openStart = Math.max(0, span.start - 1);
    if (openStart > cursor) {
      pushNarration(segments, content.slice(cursor, openStart), input.narrator);
    }
    pushSpanSegment(segments, span, input.narrator, index);
    cursor = Math.min(content.length, span.end + 1);
  }
  if (cursor < content.length) {
    pushNarration(segments, content.slice(cursor), input.narrator);
  }

  // reindex
  segments.forEach((s, i) => {
    s.index = i;
  });

  return { segments, spans };
}
