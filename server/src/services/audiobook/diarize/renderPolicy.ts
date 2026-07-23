import type {
  AudiobookDialogueSegment,
  AudiobookRenderPolicy,
  AudiobookSegmentKind,
  AudiobookSpeakerKind,
} from "@ai-novel/shared/types/audiobook";

/** 默认：非口语通道 skip */
export function defaultRenderPolicyForKind(
  kind: AudiobookSegmentKind | null | undefined,
): AudiobookRenderPolicy {
  switch (kind) {
    case "typed":
    case "chat":
    case "on_screen":
    case "sfx_cue":
      return "skip";
    default:
      return "tts";
  }
}

export function inferSegmentKindFromSpeaker(
  speakerKind: AudiobookSpeakerKind,
): AudiobookSegmentKind {
  return speakerKind === "character" ? "speech" : "narration";
}

/**
 * 解析段上有效 kind / policy（兼容旧 annotation）。
 */
export function resolveSegmentChannel(segment: AudiobookDialogueSegment): {
  segmentKind: AudiobookSegmentKind;
  renderPolicy: AudiobookRenderPolicy;
} {
  const kind =
    segment.segmentKind
    ?? inferSegmentKindFromSpeaker(segment.speakerKind);
  const policy =
    segment.renderPolicy
    ?? defaultRenderPolicyForKind(kind);
  return { segmentKind: kind, renderPolicy: policy };
}

/** 是否进入 TTS chunk 作业 */
export function shouldSynthesizeSegment(segment: AudiobookDialogueSegment): boolean {
  const { renderPolicy } = resolveSegmentChannel(segment);
  return renderPolicy === "tts" || renderPolicy === "tts_neutral";
}
