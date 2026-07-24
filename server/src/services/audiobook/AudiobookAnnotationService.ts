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
import {
  fillUncoveredSpokenQuotes,
  repairChannelsBeforeOverlay,
} from "./diarize/channelRepair";
import {
  guestStyleForUnresolvedName,
  pickGuestPresetVoice,
} from "./diarize/guestVoice";
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
    assemblySource: "narrator_fallback",
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
    // 规则装配成功不是硬失败：诊断进 assemblyNote，禁止写 error（会污染旁白回退语义）
    error: null,
    assemblyNote: input.errorNote
      ? `LLM 标注失败，已用规则装配：${input.errorNote.slice(0, 200)}`
      : null,
    contentTruncated: input.contentTruncated || undefined,
    deliveryStats,
    diarizeStats,
    wholeChapterNarratorFallback: false,
    assemblySource: "rules",
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

    // 未匹配角色：用路人 preset 音色（与旁白可辨），仍标 speakerUnresolved
    const useGuestVoice = unmatchedCharacterForcedNarrator && !skipLike;
    const guestVoice = useGuestVoice
      ? pickGuestPresetVoice(rawSpeakerName || label, input.narrator.voice)
      : input.narrator.voice;
    const guestStyle = useGuestVoice
      ? guestStyleForUnresolvedName(rawSpeakerName || label)
      : input.narrator.style;

    const narratorBase = buildBaseSegment({
      index: segIndex++,
      speakerKind: "narrator",
      characterId: null,
      speakerLabel: label,
      text,
      ttsMode: "preset",
      voice: useGuestVoice ? guestVoice : input.narrator.voice,
      baseStyle: useGuestVoice ? guestStyle : input.narrator.style,
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
          baseStyle: useGuestVoice ? guestStyle : input.narrator.style,
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
        voice: guestVoice,
        style: guestStyle,
        baseStyle: guestStyle,
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
  assemblySource: "llm" | "llm_rules_hybrid" | "rules";
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
  error?: string | null;
  assemblyNote?: string | null;
}): AudiobookChapterAnnotation {
  // 管线：误标 skip 纠正 → overlay 强制通道 skip → 应出声 quote 补洞 → 连续性
  const repaired = repairChannelsBeforeOverlay(
    input.content,
    input.segments,
    input.narrator,
  );
  const overlaid = overlayChannelSkips(input.content, repaired);
  const filled = fillUncoveredSpokenQuotes({
    content: input.content,
    segments: overlaid,
    narrator: input.narrator,
    characterVoices: input.characterVoices,
  });
  const withContinuity = fillContinuityFrom(filled, {
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
    assemblyNote: input.assemblyNote ?? null,
    contentTruncated: input.contentTruncated || undefined,
    deliveryStats,
    diarizeStats,
    wholeChapterNarratorFallback: false,
    assemblySource: input.assemblySource,
    deliveryStyleMode: input.deliveryStyleMode,
    contentSha1: hashAudiobookChapterContent(input.content),
  };
}

/**
 * 单次 diarize/annotate 正文窗口（字符）。超长章按块切片，禁止全文一把梭。
 * 可用 env 覆盖（生产 grok 长文易 600s：`AUDIOBOOK_LLM_CONTENT_WINDOW=4500`）。
 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 500) return fallback;
  return Math.floor(n);
}

export const AUDIOBOOK_LLM_CONTENT_WINDOW = parsePositiveIntEnv(
  "AUDIOBOOK_LLM_CONTENT_WINDOW",
  28_000,
);
/** 块间重叠，降低跨块对白被切断的概率 */
const AUDIOBOOK_LLM_CONTENT_OVERLAP = parsePositiveIntEnv(
  "AUDIOBOOK_LLM_CONTENT_OVERLAP",
  400,
);

/**
 * 将超长章正文切成若干 ≤window 的块；块边界优先落在换行。
 * 短章返回单块 [content]。
 */
export function splitChapterContentForLlm(
  content: string,
  window = AUDIOBOOK_LLM_CONTENT_WINDOW,
  overlap = AUDIOBOOK_LLM_CONTENT_OVERLAP,
): string[] {
  const text = content.replace(/\r\n/g, "\n");
  if (text.length <= window) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + window, text.length);
    if (end < text.length) {
      // 向后找换行，避免把引号对白拦腰切断
      const slice = text.slice(start, end);
      const breakAt = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf("\n"),
      );
      if (breakAt >= Math.floor(window * 0.55)) {
        end = start + breakAt + 1;
      }
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    const nextStart = Math.max(0, end - overlap);
    // 保证前进，避免 overlap 卡死
    start = nextStart <= start ? end : nextStart;
  }
  return chunks.length > 0 ? chunks : [text.slice(0, window)];
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

/** 合并前归一：空白折叠 + 常见标点半角化，便于 overlap 去重。 */
function normalizeMergeText(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[，]/g, ",")
    .replace(/[。．]/g, ".")
    .replace(/[！]/g, "!")
    .replace(/[？]/g, "?")
    .replace(/[「『]/g, "「")
    .replace(/[」』]/g, "」");
}

/**
 * 两段是否视为 overlap 重复：相等，或一侧是另一侧的长前缀残片。
 * 长度门槛防误伤短叹词。
 */
/** 中文对白偏短，12 字门槛会漏掉常见 overlap 残片。 */
const MERGE_OVERLAP_MIN_LEN = 8;

function textsAreOverlapDup(a: string, b: string): boolean {
  const na = normalizeMergeText(a);
  const nb = normalizeMergeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length < MERGE_OVERLAP_MIN_LEN || nb.length < MERGE_OVERLAP_MIN_LEN) return false;
  if (na.startsWith(nb) && nb.length / na.length >= 0.5) return true;
  if (nb.startsWith(na) && na.length / nb.length >= 0.5) return true;
  return false;
}

/**
 * 相邻块边界：后块开头与前块结尾的重叠长度。
 * 优先匹配多段完全对齐（≤8 段），再回落单段前缀替换。
 */
function findChunkBoundaryOverlap(
  prev: AudiobookDialogueSegment[],
  next: AudiobookDialogueSegment[],
): { skip: number; replaceLast: boolean } {
  if (prev.length === 0 || next.length === 0) {
    return { skip: 0, replaceLast: false };
  }
  const maxK = Math.min(8, prev.length, next.length);
  for (let k = maxK; k >= 2; k -= 1) {
    let allMatch = true;
    for (let i = 0; i < k; i += 1) {
      if (
        !textsAreOverlapDup(
          prev[prev.length - k + i]!.text,
          next[i]!.text,
        )
      ) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return { skip: k, replaceLast: false };
  }

  const last = prev[prev.length - 1]!;
  const first = next[0]!;
  const prevText = normalizeMergeText(last.text);
  const nextText = normalizeMergeText(first.text);
  if (!prevText || !nextText) return { skip: 0, replaceLast: false };
  if (prevText === nextText) return { skip: 1, replaceLast: false };
  if (
    prevText.startsWith(nextText)
    && nextText.length >= MERGE_OVERLAP_MIN_LEN
    && nextText.length / prevText.length >= 0.5
  ) {
    return { skip: 1, replaceLast: false };
  }
  if (
    nextText.startsWith(prevText)
    && prevText.length >= MERGE_OVERLAP_MIN_LEN
    && prevText.length / nextText.length >= 0.5
  ) {
    return { skip: 1, replaceLast: true };
  }
  return { skip: 0, replaceLast: false };
}

/**
 * 去掉相邻块重叠区重复的段，避免 overlap 双念。
 * - 多段边界：后块前缀与前块后缀对齐时整段跳过
 * - 单段：相等 / 前缀残片跳过；后块更长则替换前块尾
 * - 标点半角归一，容忍微改写级空白/标点差
 */
export function mergeChunkedSegments(
  parts: AudiobookDialogueSegment[][],
): AudiobookDialogueSegment[] {
  const out: AudiobookDialogueSegment[] = [];
  for (const part of parts) {
    const cleaned = part.filter((seg) => normalizeMergeText(seg.text).length > 0);
    if (cleaned.length === 0) continue;

    let startAt = 0;
    if (out.length > 0) {
      const { skip, replaceLast } = findChunkBoundaryOverlap(out, cleaned);
      if (skip > 0) {
        if (replaceLast && skip === 1) {
          out[out.length - 1] = { ...cleaned[0]!, index: out.length - 1 };
        }
        startAt = skip;
      }
    }

    for (let i = startAt; i < cleaned.length; i += 1) {
      const seg = cleaned[i]!;
      const text = normalizeMergeText(seg.text);
      const prev = out[out.length - 1];
      // 块内相邻重复（模型偶发双吐）也压掉
      if (prev && textsAreOverlapDup(prev.text, text)) {
        const prevText = normalizeMergeText(prev.text);
        if (
          text.startsWith(prevText)
          && prevText.length >= MERGE_OVERLAP_MIN_LEN
          && prevText.length / text.length >= 0.5
          && text.length > prevText.length
        ) {
          out[out.length - 1] = { ...seg, index: out.length - 1 };
        }
        continue;
      }
      out.push({ ...seg, index: out.length });
    }
  }
  return out;
}

/** 是否每一块都有非空段（禁止「部分成功即收工」留下空洞）。 */
export function allChunkPartsPresent(
  parts: AudiobookDialogueSegment[][],
  expectedCount: number,
): boolean {
  if (expectedCount <= 0) return false;
  if (parts.length !== expectedCount) return false;
  return parts.every((part) => Array.isArray(part) && part.length > 0);
}

/**
 * 统计「真正来自 LLM」的块数：非空且不在规则补齐集合内。
 * 0 → 不得 assemblySource=llm；部分补齐 → llm_rules_hybrid。
 */
export function countLlmOwnedChunks(
  parts: AudiobookDialogueSegment[][],
  filledByRulesIndexes: number[],
  expectedCount: number,
): number {
  const filledSet = new Set(filledByRulesIndexes);
  let n = 0;
  for (let i = 0; i < expectedCount; i += 1) {
    if ((parts[i]?.length ?? 0) > 0 && !filledSet.has(i)) n += 1;
  }
  return n;
}

/**
 * 失败块用规则补齐。返回补齐后的 parts；若仍有空块则 complete=false。
 * 不修改 LLM 已成功的块。
 */
export function fillFailedChunksWithRules(input: {
  contentChunks: string[];
  parts: AudiobookDialogueSegment[][];
  failedChunkIndexes: number[];
  narrator: AudiobookNarratorConfig;
  characterVoices: AudiobookCharacterVoiceConfig[];
}): {
  parts: AudiobookDialogueSegment[][];
  filledIndexes: number[];
  stillFailedIndexes: number[];
  complete: boolean;
} {
  const chunkCount = input.contentChunks.length;
  const parts: AudiobookDialogueSegment[][] = Array.from(
    { length: chunkCount },
    (_, i) => [...(input.parts[i] ?? [])],
  );
  const filledIndexes: number[] = [];
  const stillFailedIndexes: number[] = [];
  const attempted = new Set<number>();

  // 优先处理显式失败块，再扫未登记空洞（合并为单次尝试）
  const toTry: number[] = [];
  for (const idx of input.failedChunkIndexes) {
    if (idx < 0 || idx >= chunkCount) {
      stillFailedIndexes.push(idx);
      continue;
    }
    if (!attempted.has(idx)) {
      attempted.add(idx);
      toTry.push(idx);
    }
  }
  for (let i = 0; i < chunkCount; i += 1) {
    if ((parts[i]?.length ?? 0) === 0 && !attempted.has(i)) {
      attempted.add(i);
      toTry.push(i);
    }
  }

  for (const idx of toTry) {
    if ((parts[idx]?.length ?? 0) > 0) continue;
    const assembled = assembleSegmentsFromRules({
      content: input.contentChunks[idx] ?? "",
      narrator: input.narrator,
      characterVoices: input.characterVoices,
    });
    if (assembled.segments.length > 0) {
      parts[idx] = assembled.segments.map((seg, i) => ({ ...seg, index: i }));
      filledIndexes.push(idx);
    } else {
      stillFailedIndexes.push(idx);
    }
  }

  return {
    parts,
    filledIndexes,
    stillFailedIndexes,
    complete: allChunkPartsPresent(parts, chunkCount),
  };
}

export function buildMultiChunkAssemblyNote(input: {
  stage: "diarize" | "annotate";
  chunkCount: number;
  failedChunkIndexes: number[];
  filledByRulesIndexes: number[];
}): string {
  const base = `章内分 ${input.chunkCount} 块 ${input.stage} 后拼接`;
  if (input.failedChunkIndexes.length === 0 && input.filledByRulesIndexes.length === 0) {
    return base;
  }
  const bits: string[] = [base];
  if (input.filledByRulesIndexes.length > 0) {
    const human = input.filledByRulesIndexes.map((i) => i + 1).join(",");
    bits.push(`失败块 ${human} 已用规则补齐`);
  }
  const unfilled = input.failedChunkIndexes.filter(
    (i) => !input.filledByRulesIndexes.includes(i),
  );
  if (unfilled.length > 0) {
    bits.push(`块 ${unfilled.map((i) => i + 1).join(",")} 仍空`);
  }
  return bits.join("；");
}

/**
 * 读库/展示时分流：旧任务把「已用规则装配」写进 error，应视为 assemblyNote。
 * 门禁不读 error；UI 不得再标成「回退」。
 */
export function normalizeAnnotationDiagnostics(
  annotation: AudiobookChapterAnnotation,
): AudiobookChapterAnnotation {
  const err = annotation.error?.trim() || "";
  const note = annotation.assemblyNote?.trim() || "";
  const looksLikeAssemblySuccess =
    Boolean(err)
    && annotation.wholeChapterNarratorFallback !== true
    && annotation.diarizeStats?.wholeChapterNarratorFallback !== true
    && /已用规则装配|规则装配成功|规则装配：/.test(err);

  if (!looksLikeAssemblySuccess) {
    return annotation;
  }

  const mergedNote = note
    ? (note.includes(err) ? note : `${note}；${err}`)
    : err;

  return {
    ...annotation,
    error: null,
    assemblyNote: mergedNote,
  };
}

export class AudiobookAnnotationService {
  /**
   * 按**单章**标注：任务循环一章一章调本方法。
   * 章内若超 LLM 窗口，再按块顺序 diarize 后拼接——禁止把全书/全文塞进一次 LLM。
   *
   * 多块语义（H1/H2）：
   * - per-chunk try/catch，单块失败不丢弃其它块
   * - 仅当**每一块**都有段才作为 LLM 成功返回；失败块先规则补齐
   * - 仍有空洞 → 不 silent partial，降级整章 L1/L3
   */
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
    const contentChunks = splitChapterContentForLlm(content);
    const multiChunk = contentChunks.length > 1;
    const roster = input.characterVoices.map(buildCharacterRosterLine).join("\n");
    const llmOptions = {
      provider: input.provider ?? undefined,
      model: input.model ?? undefined,
      temperature: typeof input.temperature === "number" ? input.temperature : 0.2,
      signal: input.signal,
      novelId: undefined as string | undefined,
      chapterId: input.chapterId,
    };

    const tryFinishChunkedLlm = (args: {
      stage: "diarize" | "annotate";
      parts: AudiobookDialogueSegment[][];
      failedChunkIndexes: number[];
      peeledTotal: number;
    }): AudiobookChapterAnnotation | null => {
      let parts = args.parts;
      let filledByRulesIndexes: number[] = [];

      if (!allChunkPartsPresent(parts, contentChunks.length)) {
        const filled = fillFailedChunksWithRules({
          contentChunks,
          parts,
          failedChunkIndexes: args.failedChunkIndexes,
          narrator: input.narrator,
          characterVoices: input.characterVoices,
        });
        parts = filled.parts;
        filledByRulesIndexes = filled.filledIndexes;
        if (!filled.complete) {
          return null;
        }
      }

      // 零块 LLM 成功、全靠规则补洞 → 不冒充 llm，交给整章 L1/L3
      const llmChunkCount = countLlmOwnedChunks(
        parts,
        filledByRulesIndexes,
        contentChunks.length,
      );
      if (llmChunkCount === 0) {
        return null;
      }

      const merged = mergeChunkedSegments(parts);
      if (merged.length === 0) return null;

      const assemblyNote = multiChunk || filledByRulesIndexes.length > 0
        ? buildMultiChunkAssemblyNote({
          stage: args.stage,
          chunkCount: contentChunks.length,
          failedChunkIndexes: args.failedChunkIndexes,
          filledByRulesIndexes,
        })
        : null;

      // 部分块规则补齐 → hybrid，禁止整章标纯 llm
      const assemblySource = filledByRulesIndexes.length > 0
        ? "llm_rules_hybrid"
        : "llm";

      // 分块路径覆盖全章（含规则补洞）→ 非 truncated。
      // 仅在无法覆盖时走 null 降级，不会带着洞返回。
      return finishAnnotation({
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        content,
        segments: merged,
        peeledCount: args.peeledTotal,
        deliveryStyleMode,
        contentTruncated: false,
        assemblySource,
        narrator: input.narrator,
        characterVoices: input.characterVoices,
        assemblyNote,
        error: null,
      });
    };

    // ── L0: 专用 diarize（无 delivery，通道优先；按章内块顺序）──────────────
    {
      const chunkSegmentParts: AudiobookDialogueSegment[][] = Array.from(
        { length: contentChunks.length },
        () => [],
      );
      let peeledTotal = 0;
      const failedChunkIndexes: number[] = [];
      let aborted: unknown = null;

      for (let chunkIndex = 0; chunkIndex < contentChunks.length; chunkIndex += 1) {
        if (input.signal?.aborted) {
          aborted = new AppError("标注已取消。", 408);
          break;
        }
        const chunk = contentChunks[chunkIndex]!;
        const chunkTitle = multiChunk
          ? `${input.chapterTitle}（块 ${chunkIndex + 1}/${contentChunks.length}）`
          : input.chapterTitle;
        try {
          const diarize = await runStructuredPrompt({
            asset: audiobookChapterDiarizePrompt,
            promptInput: {
              chapterOrder: input.chapterOrder,
              chapterTitle: chunkTitle,
              chapterContent: chunk,
              characterRosterText: roster,
              narratorLabel: "旁白",
              ruleSpanSummary: buildRuleSpanSummary(chunk),
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
            // diarize 路径暂不带 delivery；表演另 job（Phase 2.1）
            deliveryStyleMode: "off",
          });
          peeledTotal += peeledCount;
          if (segments.length > 0) {
            chunkSegmentParts[chunkIndex] = segments;
          } else {
            failedChunkIndexes.push(chunkIndex);
          }
        } catch (error) {
          if (input.signal?.aborted) {
            aborted = error instanceof Error ? error : new AppError("标注已取消。", 408);
            break;
          }
          failedChunkIndexes.push(chunkIndex);
          console.warn(
            "[audiobook] diarize chunk failed",
            input.chapterId,
            `chunk ${chunkIndex + 1}/${contentChunks.length}`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      if (aborted) {
        throw aborted instanceof Error ? aborted : new AppError("标注已取消。", 408);
      }

      const finished = tryFinishChunkedLlm({
        stage: "diarize",
        parts: chunkSegmentParts,
        failedChunkIndexes,
        peeledTotal,
      });
      if (finished) return finished;

      if (failedChunkIndexes.length > 0 || multiChunk) {
        console.warn(
          "[audiobook] diarize incomplete after chunk/rules fill, falling back",
          input.chapterId,
          {
            chunks: contentChunks.length,
            failed: failedChunkIndexes.map((i) => i + 1),
          },
        );
      }
    }

    // ── L0b: 旧 annotate（含 optional delivery；同样按块）───────────────────
    {
      const chunkSegmentParts: AudiobookDialogueSegment[][] = Array.from(
        { length: contentChunks.length },
        () => [],
      );
      let peeledTotal = 0;
      const failedChunkIndexes: number[] = [];
      let aborted: unknown = null;
      let lastErrorMessage: string | null = null;

      for (let chunkIndex = 0; chunkIndex < contentChunks.length; chunkIndex += 1) {
        if (input.signal?.aborted) {
          aborted = new AppError("标注已取消。", 408);
          break;
        }
        const chunk = contentChunks[chunkIndex]!;
        const chunkTitle = multiChunk
          ? `${input.chapterTitle}（块 ${chunkIndex + 1}/${contentChunks.length}）`
          : input.chapterTitle;
        try {
          const result = await runStructuredPrompt({
            asset: audiobookChapterAnnotatePrompt,
            promptInput: {
              chapterOrder: input.chapterOrder,
              chapterTitle: chunkTitle,
              chapterContent: chunk,
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
          peeledTotal += peeledCount;
          if (segments.length > 0) {
            chunkSegmentParts[chunkIndex] = segments;
          } else {
            failedChunkIndexes.push(chunkIndex);
          }
        } catch (error) {
          if (input.signal?.aborted) {
            aborted = error instanceof Error ? error : new AppError("标注已取消。", 408);
            break;
          }
          failedChunkIndexes.push(chunkIndex);
          lastErrorMessage = error instanceof Error ? error.message : String(error);
          console.warn(
            "[audiobook] annotate chunk failed",
            input.chapterId,
            `chunk ${chunkIndex + 1}/${contentChunks.length}`,
            lastErrorMessage,
          );
        }
      }

      if (aborted) {
        throw aborted instanceof Error ? aborted : new AppError("标注已取消。", 408);
      }

      const finished = tryFinishChunkedLlm({
        stage: "annotate",
        parts: chunkSegmentParts,
        failedChunkIndexes,
        peeledTotal,
      });
      if (finished) return finished;

      const errorNote = lastErrorMessage
        || (failedChunkIndexes.length > 0
          ? `分块标注失败：${failedChunkIndexes.map((i) => i + 1).join(",")}/${contentChunks.length}`
          : "标注结果为空");

      const rules = tryBuildRuleAssemblyAnnotation({
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        chapterContent: content,
        narrator: input.narrator,
        characterVoices: input.characterVoices,
        deliveryStyleMode,
        // 整章规则覆盖 → 非 truncated；字段仅表示「LLM 窗未盖全且无补洞」
        contentTruncated: false,
        errorNote,
      });
      if (rules) return rules;

      return buildNarratorOnlyAnnotation({
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        chapterContent: content,
        narrator: input.narrator,
        error: `标注失败已回退旁白：${errorNote.slice(0, 240)}`,
      });
    }
  }
}

export const audiobookAnnotationService = new AudiobookAnnotationService();
