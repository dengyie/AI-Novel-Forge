import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
  isMimoTtsPresetVoice,
  type AudiobookPrecheckResult,
  type AudiobookScopeMode,
  type CreateAudiobookTaskInput,
} from "@ai-novel/shared/types/audiobook";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";

function parseScopeMode(value: string | undefined): AudiobookScopeMode {
  if (value === "chapter" || value === "range" || value === "full") {
    return value;
  }
  throw new AppError("scopeMode 必须是 chapter | range | full。", 400);
}

export class AudiobookPrecheckService {
  async precheck(input: CreateAudiobookTaskInput): Promise<AudiobookPrecheckResult> {
    const novelId = input.novelId?.trim();
    if (!novelId) {
      throw new AppError("novelId 不能为空。", 400);
    }

    const scopeMode = parseScopeMode(input.scopeMode);

    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        title: true,
        audiobookNarratorVoice: true,
        audiobookNarratorStyle: true,
        characters: {
          select: {
            id: true,
            name: true,
            ttsVoice: true,
            ttsStyle: true,
          },
          orderBy: { createdAt: "asc" },
        },
        chapters: {
          select: {
            id: true,
            order: true,
            title: true,
          },
          orderBy: { order: "asc" },
        },
      },
    });

    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    const chapters = this.resolveChapters(novel.chapters, scopeMode, input);
    if (chapters.length === 0) {
      throw new AppError("所选范围内没有章节，无法启动有声书任务。", 400);
    }

    const narratorVoiceRaw = (input.narratorVoice ?? novel.audiobookNarratorVoice ?? DEFAULT_AUDIOBOOK_NARRATOR_VOICE).trim();
    const narratorStyle = (input.narratorStyle ?? novel.audiobookNarratorStyle ?? DEFAULT_AUDIOBOOK_NARRATOR_STYLE).trim()
      || DEFAULT_AUDIOBOOK_NARRATOR_STYLE;

    const warnings: string[] = [];
    if (!isMimoTtsPresetVoice(narratorVoiceRaw)) {
      warnings.push(`旁白音色「${narratorVoiceRaw}」不在 MiMo 预置表中，合成阶段可能失败。`);
    }

    const characterVoices = novel.characters.map((character) => ({
      characterId: character.id,
      characterName: character.name,
      ttsVoice: character.ttsVoice?.trim() || "",
      ttsStyle: character.ttsStyle ?? null,
    }));

    const missingVoices = characterVoices
      .filter((item) => !item.ttsVoice)
      .map((item) => ({
        characterId: item.characterId,
        characterName: item.characterName,
        reason: "角色卡未配置 ttsVoice（MiMo 预置音色）。",
      }));

    for (const item of characterVoices) {
      if (item.ttsVoice && !isMimoTtsPresetVoice(item.ttsVoice)) {
        warnings.push(`角色「${item.characterName}」音色「${item.ttsVoice}」不在 MiMo 预置表中。`);
      }
    }

    const ok = missingVoices.length === 0;

    return {
      ok,
      novelId: novel.id,
      scopeMode,
      chapterIds: chapters.map((chapter) => chapter.id),
      chapterCount: chapters.length,
      narrator: {
        voice: narratorVoiceRaw || DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
        style: narratorStyle,
      },
      characterVoices: characterVoices.filter((item) => item.ttsVoice),
      missingVoices,
      warnings,
    };
  }

  private resolveChapters(
    chapters: Array<{ id: string; order: number; title: string }>,
    scopeMode: AudiobookScopeMode,
    input: CreateAudiobookTaskInput,
  ): Array<{ id: string; order: number; title: string }> {
    if (scopeMode === "full") {
      return chapters;
    }

    if (scopeMode === "chapter") {
      const chapterId = input.chapterId?.trim();
      if (!chapterId) {
        throw new AppError("scopeMode=chapter 时必须提供 chapterId。", 400);
      }
      const found = chapters.find((chapter) => chapter.id === chapterId);
      if (!found) {
        throw new AppError("指定章节不存在于该小说。", 404);
      }
      return [found];
    }

    const start = input.startChapterOrder;
    const end = input.endChapterOrder;
    if (
      typeof start !== "number"
      || typeof end !== "number"
      || !Number.isFinite(start)
      || !Number.isFinite(end)
      || start < 1
      || end < start
    ) {
      throw new AppError("scopeMode=range 时需提供合法的 startChapterOrder ≤ endChapterOrder。", 400);
    }

    const ranged = chapters.filter((chapter) => chapter.order >= start && chapter.order <= end);
    if (ranged.length === 0) {
      throw new AppError(`范围内没有章节（order ${start}-${end}）。`, 400);
    }
    return ranged;
  }
}

export const audiobookPrecheckService = new AudiobookPrecheckService();
