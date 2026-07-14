import type {
  AudiobookChapterAnnotation,
  AudiobookCharacterVoiceConfig,
  AudiobookDialogueSegment,
  AudiobookNarratorConfig,
} from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { audiobookChapterAnnotatePrompt } from "../../prompting/prompts/audiobook/audiobookChapterAnnotate.prompts";
import { AppError } from "../../middleware/errorHandler";

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
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
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
  return index.byExact.get(raw)
    ?? index.byNormalized.get(normalizeName(raw))
    ?? [...new Set(index.byExact.values())].find((item) => {
      const candidates = [
        item.characterName,
        ...(item.speakerAliases ?? []),
      ]
        .map((name) => name?.trim())
        .filter((name): name is string => Boolean(name) && name.length >= 2);
      return candidates.some((name) => raw.includes(name) || name.includes(raw));
    })
    ?? null;
}

/**
 * 标注失败时的兜底：整章作为旁白单段，保证合成可继续。
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
      }]
    : [];

  return {
    chapterId: input.chapterId,
    chapterOrder: input.chapterOrder,
    chapterTitle: input.chapterTitle,
    segments,
    annotatedAt: new Date().toISOString(),
    error: input.error ?? (text ? null : "章节正文为空。"),
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

    const roster = input.characterVoices
      .map((item) => {
        const mode = item.ttsMode?.trim() || "preset";
        const aliases = (item.speakerAliases ?? [])
          .map((alias) => alias.trim())
          .filter(Boolean);
        const aliasSuffix = aliases.length > 0 ? `；别名：${aliases.join("、")}` : "";
        if (mode === "design") {
          return `- ${item.characterName}（design${aliasSuffix}）`;
        }
        if (mode === "clone") {
          return `- ${item.characterName}（clone${aliasSuffix}）`;
        }
        return `- ${item.characterName}（音色 ${item.ttsVoice || "未设"}${aliasSuffix}）`;
      })
      .join("\n");

    try {
      const result = await runStructuredPrompt({
        asset: audiobookChapterAnnotatePrompt,
        promptInput: {
          chapterOrder: input.chapterOrder,
          chapterTitle: input.chapterTitle,
          chapterContent: content.slice(0, 28_000),
          characterRosterText: roster,
          narratorLabel: "旁白",
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

      for (const raw of result.output.segments) {
        const text = raw.text.replace(/\r\n/g, "\n").trim();
        if (!text) {
          continue;
        }

        if (raw.speakerKind === "character") {
          const matched = resolveCharacter(raw.speakerName, index);
          if (matched) {
            const mode = matched.ttsMode?.trim() || "preset";
            segments.push({
              index: segIndex++,
              speakerKind: "character",
              characterId: matched.characterId,
              speakerLabel: matched.characterName,
              text,
              ttsMode: mode === "design" || mode === "clone" ? mode : "preset",
              voice: matched.ttsVoice?.trim() || "",
              style: matched.ttsStyle ?? input.narrator.style,
              designPrompt: matched.ttsDesignPrompt ?? null,
              refAudioPath: matched.ttsRefAudioPath ?? null,
            });
            continue;
          }
        }

        segments.push({
          index: segIndex++,
          speakerKind: "narrator",
          characterId: null,
          speakerLabel: "旁白",
          text,
          ttsMode: "preset",
          voice: input.narrator.voice,
          style: input.narrator.style,
        });
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

      return {
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        chapterTitle: input.chapterTitle,
        segments,
        annotatedAt: new Date().toISOString(),
        error: null,
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
