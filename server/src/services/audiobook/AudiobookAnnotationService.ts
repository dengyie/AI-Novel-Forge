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
import { AppError } from "../../middleware/errorHandler";
import {
  applyDeliveryToSegment,
  computeDeliveryChapterStats,
  fillContinuityFrom,
  resolveDeliveryStyleMode,
  shouldApplyDelivery,
} from "./deliveryStyle";
import { expandSegmentsToChunkJobs } from "./audiobookChunk";

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
        ttsMode: "preset",
        voice: input.narrator.voice,
        style: input.narrator.style,
        baseStyle: input.narrator.style,
        delivery: null,
        deliveryMergeKey: "none",
      }]
    : [];

  return {
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder,
    chapterTitle: input.chapterTitle,
    segments,
    annotatedAt: new Date().toISOString(),
    error: input.error ?? (text ? null : "章节正文为空。"),
    deliveryStyleMode: "off",
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

    // 极短正文不值得打 LLM
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

    try {
      const result = await runStructuredPrompt({
        asset: audiobookChapterAnnotatePrompt,
        promptInput: {
          chapterOrder: input.chapterOrder,
          chapterTitle: input.chapterTitle,
          chapterContent: content.slice(0, 28_000),
          characterRosterText: roster,
          narratorLabel: "旁白",
          requestDelivery,
        },
        options: {
          provider: input.provider ?? undefined,
          model: input.model ?? undefined,
          temperature: typeof input.temperature === "number" ? input.temperature : 0.2,
          signal: input.signal,
          novelId: undefined,
          chapterId: input.chapterId,
          stage: "audiobook_annotate",
          entrypoint: "audiobook.annotation",
        },
      });

      const index = buildCharacterIndex(input.characterVoices);
      const segments: AudiobookDialogueSegment[] = [];
      let segIndex = 0;
      let peeledCount = 0;

      for (const raw of result.output.segments) {
        const text = raw.text.replace(/\r\n/g, "\n").trim();
        if (!text) {
          continue;
        }

        // delivery 单独 normalize；坏表演只剥 delivery，绝不整章旁白
        const rawDelivery = (raw as { delivery?: unknown }).delivery;
        const hadRawDelivery = Boolean(rawDelivery && typeof rawDelivery === "object");

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
            const withDelivery = shouldApplyDelivery(deliveryStyleMode, "character")
              ? applyDeliveryToSegment(base, rawDelivery, {
                  deliveryStyleMode,
                  baseStyle,
                  baseDesignPrompt,
                })
              : applyDeliveryToSegment(base, null, {
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

        // 未匹配角色名：已从 character 分支 fallthrough，按旁白落段并强制剥 delivery
        const unmatchedCharacterForcedNarrator = raw.speakerKind === "character";

        const narratorBase = buildBaseSegment({
          index: segIndex++,
          speakerKind: "narrator",
          characterId: null,
          speakerLabel: "旁白",
          text,
          ttsMode: "preset",
          voice: input.narrator.voice,
          baseStyle: input.narrator.style,
          baseDesignPrompt: null,
          refAudioPath: null,
        });
        const narratorSeg = unmatchedCharacterForcedNarrator
          ? applyDeliveryToSegment(narratorBase, null, {
              deliveryStyleMode: "off",
              baseStyle: input.narrator.style,
              baseDesignPrompt: null,
            })
          : shouldApplyDelivery(deliveryStyleMode, "narrator")
            ? applyDeliveryToSegment(narratorBase, rawDelivery, {
                deliveryStyleMode,
                baseStyle: input.narrator.style,
                baseDesignPrompt: null,
              })
            : applyDeliveryToSegment(narratorBase, null, {
                deliveryStyleMode: "off",
                baseStyle: input.narrator.style,
                baseDesignPrompt: null,
              });
        if (unmatchedCharacterForcedNarrator && hadRawDelivery) {
          peeledCount += 1;
        } else if (
          hadRawDelivery
          && shouldApplyDelivery(deliveryStyleMode, "narrator")
          && !narratorSeg.delivery
        ) {
          peeledCount += 1;
        }
        segments.push(narratorSeg);
      }

      if (segments.length === 0) {
        return buildNarratorOnlyAnnotation({
          chapterId: input.chapterId,
          chapterOrder: input.chapterOrder,
          chapterTitle: input.chapterTitle,
          chapterContent: content,
          narrator: input.narrator,
          error: "标注结果为空，已回退整章旁白。",
        });
      }

      const withContinuity = fillContinuityFrom(segments, { deliveryStyleMode });
      const chunkJobCount = expandSegmentsToChunkJobs(withContinuity).length;
      const deliveryStats = computeDeliveryChapterStats(withContinuity, {
        peeledCount,
        chunkJobCount,
      });

      return {
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        segments: withContinuity,
        annotatedAt: new Date().toISOString(),
        error: null,
        contentTruncated: contentTruncated || undefined,
        deliveryStats,
        deliveryStyleMode,
      };
    } catch (error) {
      if (input.signal?.aborted) {
        throw error instanceof Error ? error : new AppError("标注已取消。", 408);
      }
      const message = error instanceof Error ? error.message : String(error);
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
