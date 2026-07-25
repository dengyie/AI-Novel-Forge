import { AUDIOBOOK_GAP_MS } from "@ai-novel/shared/types/audiobook";
import type { AudiobookDialogueSegment } from "@ai-novel/shared/types/audiobook";
import { namedGuestSpeakerName } from "./diarize/guestVoice";

export type AudiobookGapKind =
  | "same_speaker"
  | "narrator_character"
  | "character_character"
  | "between_chapters";

export interface AudiobookChunkSpeakerRef {
  /**
   * 旁白用固定键 `narrator`；
   * 有名 guest：`guest:<name>`（生产以 narrator kind + unresolved 承载）；
   * 角色优先 characterId，否则 speakerLabel。
   */
  speakerKey: string;
  speakerKind: "narrator" | "character";
  text: string;
}

export function speakerKeyFromSegment(segment: Pick<
  AudiobookDialogueSegment,
  | "speakerKind"
  | "characterId"
  | "speakerLabel"
  | "speakerUnresolved"
  | "unresolvedSpeakerName"
>): string {
  // 有名未匹配路人：独立 key，避免与真旁白 / 其他路人被判 same_speaker（气口过短）
  const guestName = namedGuestSpeakerName(segment);
  if (guestName) {
    return `guest:${guestName}`;
  }
  if (segment.speakerKind === "narrator") {
    return "narrator";
  }
  const id = segment.characterId?.trim();
  if (id) {
    return `character:${id}`;
  }
  return `label:${segment.speakerLabel?.trim() || "unknown"}`;
}

export function classifyChunkGap(
  prev: AudiobookChunkSpeakerRef,
  next: AudiobookChunkSpeakerRef,
): AudiobookGapKind {
  if (prev.speakerKey === next.speakerKey) {
    return "same_speaker";
  }
  if (prev.speakerKind === "narrator" || next.speakerKind === "narrator") {
    return "narrator_character";
  }
  return "character_character";
}

/**
 * 计算 prev→next 之间应插入的静音毫秒。
 * 短句加成看 prev 文本（话说完后多留一口气）。
 */
export function resolveInterChunkGapMs(
  prev: AudiobookChunkSpeakerRef,
  next: AudiobookChunkSpeakerRef,
  gapMs: typeof AUDIOBOOK_GAP_MS = AUDIOBOOK_GAP_MS,
): number {
  const kind = classifyChunkGap(prev, next);
  let ms = 0;
  if (kind === "same_speaker") {
    ms = gapMs.sameSpeaker;
  } else if (kind === "narrator_character") {
    ms = gapMs.narratorCharacter;
  } else {
    ms = gapMs.characterCharacter;
  }

  const prevChars = prev.text.replace(/\s+/g, "").length;
  if (prevChars > 0 && prevChars <= gapMs.shortUtteranceChars) {
    ms += gapMs.shortUtteranceBonus;
  }
  return Math.max(0, Math.floor(ms));
}

export function resolveBetweenChapterGapMs(
  gapMs: typeof AUDIOBOOK_GAP_MS = AUDIOBOOK_GAP_MS,
): number {
  return Math.max(0, Math.floor(gapMs.betweenChapters));
}
