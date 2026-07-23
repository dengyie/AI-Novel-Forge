import { createHash } from "node:crypto";
import type {
  AudiobookChapterAnnotation,
  AudiobookCharacterVoiceConfig,
  AudiobookDialogueSegment,
  AudiobookNarratorConfig,
  DeliveryStyleMode,
} from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { audiobookChapterAnnotatePrompt } from "../../prompting/prompts/audiobook/audiobookChapterAnnotate.prompts";
import { audiobookChapterDiarizePrompt } from "../../prompting/prompts/audiobook/audiobookChapterDiarize.prompts";
import { AppError } from "../../middleware/errorHandler";
import {
  applyDeliveryToSegment,
  computeDeliveryChapterStats,
  fillContinuityFrom,
  resolveDeliveryStyleMode,
  shouldApplyDelivery,
} from "./deliveryStyle";
import { expandSegmentsToChunkJobs } from "./audiobookChunk";
import { assembleSegmentsFromRules } from "./diarize/ruleAssembly";
import { computeDiarizeChapterStats } from "./diarize/diarizeQualityGate";
import {
  defaultRenderPolicyForKind,
  inferSegmentKindFromSpeaker,
} from "./diarize/renderPolicy";
import { overlayChannelSkips } from "./diarize/overlayChannelSkips";
import { runRuleSpanPass } from "./diarize/ruleSpanPass";
import type { AudiobookSegmentKind } from "@ai-novel/shared/types/audiobook";
import { isAudiobookSegmentKind } from "@ai-novel/shared/types/audiobook";

/** 标注缓存用正文指纹：trim + CRLF→LF 后 sha1 前 16 hex。 */
export function hashAudiobookChapterContent(content: string | null | undefined): string {
  const normalized = (content ?? "").replace(/\r\n/g, "\n").trim();
  return createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 16);
}

export interface AnnotateChapterInput {
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  chapterContent: string;
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
  provider?: LLMProvider | null;
  model?: string | null;
  temperature?: number | null;
  signal?: AbortSignal;
  /** 段级表演模式；缺省 resolveDeliveryStyleMode() → off */
  deliveryStyleMode?: DeliveryStyleMode | null;
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function clipRosterField(value: string | null | undefined, max: number): string | null {
  const t = (value ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length <= max ? t : t.slice(0, max);
}

/** roster 行：名 | 别名 | 声线 | 风格 | 性格 */
export function buildCharacterRosterLine(item: AudiobookCharacterVoiceConfig): string {
  const aliases = (item.speakerAliases ?? [])
    .map((alias) => alias.trim())
    .filter(Boolean);
  const voice = clipRosterField(item.voiceTexture, 36) || "未设定";
  const style = clipRosterField(item.ttsStyle, 24) || "未设定";
  const personality = clipRosterField(item.personality, 24) || "未设定";
  const aliasPart = aliases.length > 0 ? aliases.join("、") : "无";
  return `- ${item.characterName} | 别名:${aliasPart} | 声线:${voice} | 风格:${style} | 性格:${personality}`;
}

function buildCharacterIndex(characterVoices: AudiobookCharacterVoiceConfig[]) {
  const byExact = new Map<string, AudiobookCharacterVoiceConfig>();
  const byNormalized = new Map<string, AudiobookCharacterVoiceConfig>();
  for (const item of characterVoices) {
    const names = [
      item.characterName,
      ...(item.speakerAliases ?? []),
    ]
      .map((name) => name?.trim())
      .filter((name): name is string => Boolean(name));
    for (const name of names) {
      byExact.set(name, item);
      byNormalized.set(normalizeName(name), item);
    }
  }
  return { byExact, byNormalized };
}

function resolveCharacter(
  speakerName: string | null | undefined,
  index: ReturnType<typeof buildCharacterIndex>,
): AudiobookCharacterVoiceConfig | null {
  const raw = speakerName?.trim();
  if (!raw || raw === "旁白" || raw === "narrator") {
    return null;
  }
  const exact = index.byExact.get(raw) ?? index.byNormalized.get(normalizeName(raw));
  if (exact) {
    return exact;
  }

  // 子串回退：两侧均 ≥2 字；优先最长候选。
  // - speaker 包含角色名：允许（「小美姐姐」→「小美」）
  // - 角色名包含 speaker：仅长度差 ≤1（「王小明」←「小明」；拒绝「弟弟」→「远哥弟弟」）
  let best: AudiobookCharacterVoiceConfig | null = null;
  let bestLen = 0;
  if (raw.length < 2) {
    return null;
  }
  for (const item of new Set(index.byExact.values())) {
    const candidates = [
      item.characterName,
      ...(item.speakerAliases ?? []),
    ]
      .map((name) => name?.trim())
      .filter((name): name is string => Boolean(name) && name.length >= 2);
    for (const name of candidates) {
      const speakerContainsName = raw.includes(name);
      const nameContainsSpeaker = name.includes(raw);
      if (!speakerContainsName && !nameContainsSpeaker) {
        continue;
      }
      if (nameContainsSpeaker && !speakerContainsName && name.length - raw.length > 1) {
        continue;
      }
      if (name.length > bestLen) {
        best = item;
        bestLen = name.length;
      }
    }
  }
  return best;
}

/** 导出供单测验证 speaker 归一。 */
export function matchCharacterBySpeakerNameForTest(
  speakerName: string | null | undefined,
  characterVoices: AudiobookCharacterVoiceConfig[],
): AudiobookCharacterVoiceConfig | null {
  return resolveCharacter(speakerName, buildCharacterIndex(characterVoices));
}

/**
 * 标注失败时的兜底：整章作为旁白单段，保证合成可继续。
 * 注意：仅用于标注总失败；delivery 单段失败不得走此路径。
 */
export function buildNarratorOnlyAnnotation(input: {
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  chapterContent: string;
  narrator: AudiobookNarratorConfig;
  error?: string | null;
}): AudiobookChapterAnnotation {
  const text = input.chapterContent.replace(/\r\n/g, "\n").trim();
  const segments: AudiobookDialogueSegment[] = text
    ? [{
        index: 0,
        speakerKind: "narrator",
        characterId: null,
        speakerLabel: "旁白",
        text,
        segmentKind: "narration",
        renderPolicy: "tts",
        ttsMode: "preset",
        voice: input.narrator.voice,
        style: input.narrator.style,
        baseStyle: input.narrator.style,
        delivery: null,
        deliveryMergeKey: "none",
      }]
    : [];

  const wholeChapterNarratorFallback = true;
  const diarizeStats = computeDiarizeChapterStats({
    content: text,
    segments,
    wholeChapterNarratorFallback,
    assemblySource: "narrator_fallback",
  });

  return {
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder,
    chapterTitle: input.chapterTitle,
    segments,
    annotatedAt: new Date().toISOString(),
    error: input.error ?? (text ? null : "章节正文为空。"),
    deliveryStyleMode: "off",
    contentSha1: hashAudiobookChapterContent(input.chapterContent),
    wholeChapterNarratorFallback,
    diarizeStats,
  };
}

/**
 * L1 规则装配：LLM 失败时优先于整章旁白（有引号/通道时）。
 * 无有效 span 或装配为空则返回 null，由调用方走 L3。
 */
export function tryBuildRuleAssemblyAnnotation(input: {
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  chapterContent: string;
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
  deliveryStyleMode?: DeliveryStyleMode | null;
  contentTruncated?: boolean;
  errorNote?: string | null;
}): AudiobookChapterAnnotation | null {
  const content = input.chapterContent.replace(/\r\n/g, "\n").trim();
  if (content.length < 40) return null;

  const assembled = assembleSegmentsFromRules({
    content,
    narrator: input.narrator,
    characterVoices: input.characterVoices,
  });
  if (assembled.segments.length === 0) return null;
  // 至少有一个非「整章单旁白」结构，或存在 skip/speech 通道才采纳
  const hasChannelOrSpeech = assembled.segments.some((s) => {
    const kind = s.segmentKind;
    return kind === "speech" || kind === "typed" || kind === "chat"
      || kind === "on_screen" || kind === "phone" || kind === "broadcast";
  });
  if (!hasChannelOrSpeech && assembled.spans.length === 0) {
    return null;
  }

  const deliveryStyleMode = resolveDeliveryStyleMode(input.deliveryStyleMode ?? null);
  const overlaid = overlayChannelSkips(content, assembled.segments);
  const withContinuity = fillContinuityFrom(overlaid, { deliveryStyleMode: "off" });
  const chunkJobCount = expandSegmentsToChunkJobs(withContinuity).length;
  const deliveryStats = computeDeliveryChapterStats(withContinuity, {
    peeledCount: 0,
    chunkJobCount,
  });
  const diarizeStats = computeDiarizeChapterStats({
    content,
    segments: withContinuity,
    wholeChapterNarratorFallback: false,
    assemblySource: "rules",
  });

  return {
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder,
    chapterTitle: input.chapterTitle,
    segments: withContinuity,
    annotatedAt: new Date().toISOString(),
    error: input.errorNote
      ? `LLM 标注失败，已用规则装配：${input.errorNote.slice(0, 200)}`
      : null,
    contentTruncated: input.contentTruncated || undefined,
    deliveryStats,
    diarizeStats,
    wholeChapterNarratorFallback: false,
    deliveryStyleMode,
    contentSha1: hashAudiobookChapterContent(content),
  };
}

function buildBaseSegment(input: {
  index: number;
  speakerKind: "narrator" | "character";
  characterId: string | null;
  speakerLabel: string;
  text: string;
  ttsMode: "preset" | "design" | "clone";
  voice: string;
  baseStyle: string | null;
  baseDesignPrompt: string | null;
  refAudioPath: string | null;
}): AudiobookDialogueSegment {
  return {
    index: input.index,
    speakerKind: input.speakerKind,
    characterId: input.characterId,
    speakerLabel: input.speakerLabel,
    text: input.text,
    ttsMode: input.ttsMode,
    voice: input.voice,
    style: input.baseStyle,
    designPrompt: input.baseDesignPrompt,
    refAudioPath: input.refAudioPath,
    baseStyle: input.baseStyle,
    baseDesignPrompt: input.baseDesignPrompt,
    delivery: null,
    deliveryMergeKey: "none",
  };
}

type RawAnnotateSegment = {
  speakerKind: "narrator" | "character";
  speakerName?: string | null;
  text: string;
  delivery?: unknown;
  segmentKind?: string | null;
  channelHint?: string | null;
  confidence?: number | null;
};

function resolveRawSegmentKind(
  raw: RawAnnotateSegment,
): AudiobookSegmentKind {
  if (raw.segmentKind && isAudiobookSegmentKind(raw.segmentKind)) {
    return raw.segmentKind;
  }
  return inferSegmentKindFromSpeaker(raw.speakerKind);
}

/**
 * 将 LLM 原始段（diarize 或 annotate）落到角色音色 + 通道字段。
 * delivery 可选；坏表演只剥 delivery。
 */
export function materializeAnnotationSegments(input: {
  rawSegments: RawAnnotateSegment[];
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
  deliveryStyleMode: DeliveryStyleMode;
}): { segments: AudiobookDialogueSegment[]; peeledCount: number } {
  const index = buildCharacterIndex(input.characterVoices);
  const segments: AudiobookDialogueSegment[] = [];
  let segIndex = 0;
  let peeledCount = 0;
  const deliveryStyleMode = input.deliveryStyleMode;

  for (const raw of input.rawSegments) {
    const text = raw.text.replace(/\r\n/g, "\n").trim();
    if (!text) continue;

    const rawDelivery = raw.delivery;
    const hadRawDelivery = Boolean(rawDelivery && typeof rawDelivery === "object");
    const kind = resolveRawSegmentKind(raw);
    const policy = defaultRenderPolicyForKind(kind);

    if (raw.speakerKind === "character") {
      const matched = resolveCharacter(raw.speakerName, index);
      if (matched) {
        const mode = matched.ttsMode?.trim() || "preset";
        const ttsMode = mode === "design" || mode === "clone" ? mode : "preset";
        const baseStyle = (matched.ttsStyle ?? input.narrator.style) || null;
        const baseDesignPrompt = matched.ttsDesignPrompt ?? null;
        const base = buildBaseSegment({
          index: segIndex++,
          speakerKind: "character",
          characterId: matched.characterId,
          speakerLabel: matched.characterName,
          text,
          ttsMode,
          voice: matched.ttsVoice?.trim() || "",
          baseStyle,
          baseDesignPrompt,
          refAudioPath: matched.ttsRefAudioPath ?? null,
        });
        const withChannel: AudiobookDialogueSegment = {
          ...base,
          segmentKind: kind,
          renderPolicy: policy,
          channelHint: raw.channelHint ?? null,
          diarizeConfidence:
            typeof raw.confidence === "number" ? raw.confidence : null,
        };
        const withDelivery = shouldApplyDelivery(deliveryStyleMode, "character")
          ? applyDeliveryToSegment(withChannel, rawDelivery, {
              deliveryStyleMode,
              baseStyle,
              baseDesignPrompt,
            })
          : applyDeliveryToSegment(withChannel, null, {
              deliveryStyleMode: "off",
              baseStyle,
              baseDesignPrompt,
            });
        if (
          hadRawDelivery
          && shouldApplyDelivery(deliveryStyleMode, "character")
          && !withDelivery.delivery
        ) {
          peeledCount += 1;
        }
        segments.push(withDelivery);
        continue;
      }
    }

    const unmatchedCharacterForcedNarrator = raw.speakerKind === "character";
    const rawSpeakerName = typeof raw.speakerName === "string"
      ? raw.speakerName.trim()
      : "";
    const skipLike = policy === "skip";
    const label = skipLike
      ? (kind === "typed" ? "打字" : kind === "chat" ? "消息" : kind === "on_screen" ? "屏幕" : "旁白")
      : unmatchedCharacterForcedNarrator && rawSpeakerName
        ? rawSpeakerName
        : "旁白";

    const narratorBase = buildBaseSegment({
      index: segIndex++,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: label,
      text,
      ttsMode: "preset",
      voice: input.narrator.voice,
      baseStyle: input.narrator.style,
      baseDesignPrompt: null,
      refAudioPath: null,
    });
    const narratorKind = unmatchedCharacterForcedNarrator && !skipLike
      ? ("speech" as const)
      : kind;
    const narratorWithChannel: AudiobookDialogueSegment = {
      ...narratorBase,
      segmentKind: narratorKind,
      renderPolicy: defaultRenderPolicyForKind(narratorKind),
      channelHint: raw.channelHint ?? null,
      diarizeConfidence:
        typeof raw.confidence === "number" ? raw.confidence : null,
    };
    let narratorSeg = unmatchedCharacterForcedNarrator || skipLike
      ? applyDeliveryToSegment(narratorWithChannel, null, {
          deliveryStyleMode: "off",
          baseStyle: input.narrator.style,
          baseDesignPrompt: null,
        })
      : shouldApplyDelivery(deliveryStyleMode, "narrator")
        ? applyDeliveryToSegment(narratorWithChannel, rawDelivery, {
            deliveryStyleMode,
            baseStyle: input.narrator.style,
            baseDesignPrompt: null,
          })
        : applyDeliveryToSegment(narratorWithChannel, null, {
            deliveryStyleMode: "off",
            baseStyle: input.narrator.style,
            baseDesignPrompt: null,
          });
    if (unmatchedCharacterForcedNarrator && !skipLike) {
      narratorSeg = {
        ...narratorSeg,
        speakerUnresolved: true,
        unresolvedSpeakerName: rawSpeakerName || null,
      };
    }
    if (unmatchedCharacterForcedNarrator && hadRawDelivery) {
      peeledCount += 1;
    } else if (
      hadRawDelivery
      && !skipLike
      && shouldApplyDelivery(deliveryStyleMode, "narrator")
      && !narratorSeg.delivery
    ) {
      peeledCount += 1;
    }
    segments.push(narratorSeg);
  }

  return { segments, peeledCount };
}

function finishAnnotation(input: {
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  content: string;
  segments: AudiobookDialogueSegment[];
  peeledCount: number;
  deliveryStyleMode: DeliveryStyleMode;
  contentTruncated: boolean;
  assemblySource: "llm" | "rules";
  error?: string | null;
}): AudiobookChapterAnnotation {
  const overlaid = overlayChannelSkips(input.content, input.segments);
  const withContinuity = fillContinuityFrom(overlaid, {
    deliveryStyleMode: input.deliveryStyleMode,
  });
  const chunkJobCount = expandSegmentsToChunkJobs(withContinuity).length;
  const deliveryStats = computeDeliveryChapterStats(withContinuity, {
    peeledCount: input.peeledCount,
    chunkJobCount,
  });
  const diarizeStats = computeDiarizeChapterStats({
    content: input.content,
    segments: withContinuity,
    wholeChapterNarratorFallback: false,
    assemblySource: input.assemblySource,
  });
  return {
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder,
    chapterTitle: input.chapterTitle,
    segments: withContinuity,
    annotatedAt: new Date().toISOString(),
    error: input.error ?? null,
    contentTruncated: input.contentTruncated || undefined,
    deliveryStats,
    diarizeStats,
    wholeChapterNarratorFallback: false,
    deliveryStyleMode: input.deliveryStyleMode,
    contentSha1: hashAudiobookChapterContent(input.content),
  };
}

function buildRuleSpanSummary(content: string, maxLines = 40): string {
  const pass = runRuleSpanPass(content);
  const lines = pass.spans.slice(0, maxLines).map((s) => {
    const speak = s.shouldSpeak ? "speak" : "skip";
    const who = s.speakerHint ? ` speaker=${s.speakerHint}` : "";
    const clip = s.text.length > 36 ? `${s.text.slice(0, 36)}…` : s.text;
    return `- [${s.kind}/${speak}]${who} 「${clip}」`;
  });
  if (pass.spans.length > maxLines) {
    lines.push(`- …共 ${pass.spans.length} 条 span`);
  }
  return lines.join("\n");
}

export class AudiobookAnnotationService {
  async annotateChapter(input: AnnotateChapterInput): Promise<AudiobookChapterAnnotation> {
    const content = input.chapterContent.replace(/\r\n/g, "\n").trim();
    if (!content) {
      return buildNarratorOnlyAnnotation({
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        chapterContent: "",
        narrator: input.narrator,
        error: "章节正文为空，跳过标注。",
      });
    }

    if (content.length < 40) {
      return buildNarratorOnlyAnnotation({
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        chapterContent: content,
        narrator: input.narrator,
        error: null,
      });
    }

    const deliveryStyleMode = resolveDeliveryStyleMode(input.deliveryStyleMode ?? null);
    const requestDelivery = deliveryStyleMode !== "off";
    const contentTruncated = content.length > 28_000;
    const roster = input.characterVoices.map(buildCharacterRosterLine).join("\n");
    const contentSlice = content.slice(0, 28_000);
    const llmOptions = {
      provider: input.provider ?? undefined,
      model: input.model ?? undefined,
      temperature: typeof input.temperature === "number" ? input.temperature : 0.2,
      signal: input.signal,
      novelId: undefined as string | undefined,
      chapterId: input.chapterId,
    };

    // ── L0: 专用 diarize（无 delivery，通道优先）──────────────────────────
    try {
      const diarize = await runStructuredPrompt({
        asset: audiobookChapterDiarizePrompt,
        promptInput: {
          chapterOrder: input.chapterOrder,
          chapterTitle: input.chapterTitle,
          chapterContent: contentSlice,
          characterRosterText: roster,
          narratorLabel: "旁白",
          ruleSpanSummary: buildRuleSpanSummary(contentSlice),
        },
        options: {
          ...llmOptions,
          temperature: typeof input.temperature === "number" ? input.temperature : 0.15,
          stage: "audiobook_diarize",
          entrypoint: "audiobook.diarize",
        },
      });

      const { segments, peeledCount } = materializeAnnotationSegments({
        rawSegments: diarize.output.segments as RawAnnotateSegment[],
        narrator: input.narrator,
        characterVoices: input.characterVoices,
        // diarize 路径暂不带 delivery；表演另 job（Phase 2.1），避免拖垮分轨
        deliveryStyleMode: "off",
      });

      if (segments.length > 0) {
        return finishAnnotation({
          chapterId: input.chapterId,
          chapterOrder: input.chapterOrder,
          chapterTitle: input.chapterTitle,
          content,
          segments,
          peeledCount,
          // 快照仍记录用户请求的 mode（resume 指纹）；段上 delivery 为空
          deliveryStyleMode,
          contentTruncated,
          assemblySource: "llm",
          error: requestDelivery
            ? null // delivery 留空不记 error；UI 可见 deliveryApplied=0
            : null,
        });
      }
    } catch (error) {
      if (input.signal?.aborted) {
        throw error instanceof Error ? error : new AppError("标注已取消。", 408);
      }
      // fall through → legacy annotate → rules → narrator
      console.warn(
        "[audiobook] diarize failed, falling back",
        input.chapterId,
        error instanceof Error ? error.message : error,
      );
    }

    // ── L0b: 旧 annotate（含 optional delivery）───────────────────────────
    try {
      const result = await runStructuredPrompt({
        asset: audiobookChapterAnnotatePrompt,
        promptInput: {
          chapterOrder: input.chapterOrder,
          chapterTitle: input.chapterTitle,
          chapterContent: contentSlice,
          characterRosterText: roster,
          narratorLabel: "旁白",
          requestDelivery,
        },
        options: {
          ...llmOptions,
          stage: "audiobook_annotate",
          entrypoint: "audiobook.annotation",
        },
      });

      const { segments, peeledCount } = materializeAnnotationSegments({
        rawSegments: result.output.segments as RawAnnotateSegment[],
        narrator: input.narrator,
        characterVoices: input.characterVoices,
        deliveryStyleMode,
      });

      if (segments.length === 0) {
        const rulesEmpty = tryBuildRuleAssemblyAnnotation({
          chapterId: input.chapterId,
          chapterOrder: input.chapterOrder,
          chapterTitle: input.chapterTitle,
          chapterContent: content,
          narrator: input.narrator,
          characterVoices: input.characterVoices,
          deliveryStyleMode,
          contentTruncated,
          errorNote: "标注结果为空",
        });
        if (rulesEmpty) return rulesEmpty;
        return buildNarratorOnlyAnnotation({
          chapterId: input.chapterId,
          chapterOrder: input.chapterOrder,
          chapterTitle: input.chapterTitle,
          chapterContent: content,
          narrator: input.narrator,
          error: "标注结果为空，已回退整章旁白。",
        });
      }

      return finishAnnotation({
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        content,
        segments,
        peeledCount,
        deliveryStyleMode,
        contentTruncated,
        assemblySource: "llm",
      });
    } catch (error) {
      if (input.signal?.aborted) {
        throw error instanceof Error ? error : new AppError("标注已取消。", 408);
      }
      const message = error instanceof Error ? error.message : String(error);
      const rules = tryBuildRuleAssemblyAnnotation({
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        chapterContent: content,
        narrator: input.narrator,
        characterVoices: input.characterVoices,
        deliveryStyleMode: input.deliveryStyleMode,
        contentTruncated,
        errorNote: message,
      });
      if (rules) return rules;
      return buildNarratorOnlyAnnotation({
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        chapterContent: content,
        narrator: input.narrator,
        error: `标注失败已回退旁白：${message.slice(0, 240)}`,
      });
    }
  }
}

export const audiobookAnnotationService = new AudiobookAnnotationService();
