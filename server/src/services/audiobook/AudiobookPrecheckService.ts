import fs from "node:fs";
import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
  isAudiobookTtsMode,
  isMimoTtsPresetVoice,
  type AudiobookPrecheckResult,
  type AudiobookScopeMode,
  type AudiobookTtsMode,
  type CreateAudiobookTaskInput,
} from "@ai-novel/shared/types/audiobook";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { parseSpeakerAliases } from "./AudiobookTaskService";

function parseScopeMode(value: string | undefined): AudiobookScopeMode {
  if (value === "chapter" || value === "range" || value === "full") {
    return value;
  }
  throw new AppError("scopeMode 必须是 chapter | range | full。", 400);
}

function normalizeMode(raw: string | null | undefined): AudiobookTtsMode {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return "preset";
  }
  if (!isAudiobookTtsMode(trimmed)) {
    return "preset";
  }
  return trimmed;
}

function characterIsConfigured(item: {
  ttsMode: AudiobookTtsMode;
  ttsVoice: string;
  ttsDesignPrompt: string;
  ttsRefAudioPath: string;
}): boolean {
  if (item.ttsMode === "preset") {
    return Boolean(item.ttsVoice);
  }
  if (item.ttsMode === "design") {
    return Boolean(item.ttsDesignPrompt);
  }
  return Boolean(item.ttsRefAudioPath);
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
            ttsMode: true,
            ttsVoice: true,
            ttsStyle: true,
            ttsDesignPrompt: true,
            ttsRefAudioPath: true,
            ttsSpeakerAliases: true,
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
    const blockingErrors: string[] = [];

    if (!isMimoTtsPresetVoice(narratorVoiceRaw)) {
      blockingErrors.push(`旁白音色「${narratorVoiceRaw}」不在 MiMo 预置表中（旁白仅支持 preset）。`);
    }

    const characterVoices = novel.characters.map((character) => {
      const ttsMode = normalizeMode(character.ttsMode);
      return {
        characterId: character.id,
        characterName: character.name,
        ttsMode,
        ttsVoice: character.ttsVoice?.trim() || "",
        ttsStyle: character.ttsStyle ?? null,
        ttsDesignPrompt: character.ttsDesignPrompt?.trim() || "",
        ttsRefAudioPath: character.ttsRefAudioPath?.trim() || "",
        speakerAliases: parseSpeakerAliases(character.ttsSpeakerAliases),
      };
    });

    const missingVoices = characterVoices
      .filter((item) => !characterIsConfigured(item))
      .map((item) => {
        let reason = "角色卡未完成 TTS 绑定。";
        if (item.ttsMode === "preset") {
          reason = "角色卡未配置 ttsVoice（MiMo 预置音色）。";
        } else if (item.ttsMode === "design") {
          reason = "角色卡未配置 ttsDesignPrompt（音色设计描述）。";
        } else {
          reason = "角色卡未配置 clone 参考音频（ttsRefAudioPath）。";
        }
        return {
          characterId: item.characterId,
          characterName: item.characterName,
          reason,
        };
      });

    for (const item of characterVoices) {
      const rawMode = novel.characters.find((c) => c.id === item.characterId)?.ttsMode?.trim();
      if (rawMode && !isAudiobookTtsMode(rawMode)) {
        blockingErrors.push(`角色「${item.characterName}」ttsMode「${rawMode}」非法（须 preset|design|clone）。`);
        continue;
      }

      if (item.ttsMode === "preset" && item.ttsVoice && !isMimoTtsPresetVoice(item.ttsVoice)) {
        blockingErrors.push(`角色「${item.characterName}」音色「${item.ttsVoice}」不在 MiMo 预置表中。`);
      }

      if (item.ttsMode === "clone" && item.ttsRefAudioPath) {
        if (item.ttsRefAudioPath.includes("..") || item.ttsRefAudioPath.includes("\0")) {
          blockingErrors.push(`角色「${item.characterName}」参考音频路径非法。`);
        } else if (!fs.existsSync(item.ttsRefAudioPath)) {
          blockingErrors.push(`角色「${item.characterName}」参考音频文件不存在。`);
        } else {
          try {
            const stat = fs.statSync(item.ttsRefAudioPath);
            if (!stat.isFile() || stat.size <= 0) {
              blockingErrors.push(`角色「${item.characterName}」参考音频不可用。`);
            }
          } catch {
            blockingErrors.push(`角色「${item.characterName}」参考音频无法读取。`);
          }
        }
      }
    }

    if (characterVoices.length === 0) {
      warnings.push("小说尚无角色卡；对白将仅使用旁白音色。");
    }

    const ok = missingVoices.length === 0 && blockingErrors.length === 0;

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
      characterVoices: characterVoices
        .filter((item) => characterIsConfigured(item))
        .map((item) => ({
          characterId: item.characterId,
          characterName: item.characterName,
          ttsMode: item.ttsMode,
          ttsVoice: item.ttsVoice || null,
          ttsStyle: item.ttsStyle,
          ttsDesignPrompt: item.ttsDesignPrompt || null,
          ttsRefAudioPath: item.ttsRefAudioPath || null,
          speakerAliases: item.speakerAliases,
        })),
      missingVoices,
      blockingErrors,
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
