import {
  type AudiobookVoicePlanApplyInput,
  type AudiobookVoicePlanApplyResult,
  type AudiobookVoicePlanSuggestInput,
  type AudiobookVoicePlanSuggestResult,
  type AudiobookVoicePreviewInput,
  type AudiobookVoicePreviewResult,
  isAudiobookTtsMode,
  isMimoTtsPresetVoice,
} from "@ai-novel/shared/types/audiobook";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { parseSpeakerAliases } from "./audiobookSpeakerAliases";
import {
  isCharacterVoiceConfigured,
  planCharacterVoices,
  type VoicePlannerCharacterInput,
} from "./audiobookVoicePlanner";
import { mimoChatAudioTTSProvider } from "./MimoChatAudioTTSProvider";

const DEFAULT_PREVIEW_TEXT = "我是这段故事里的角色，请听听我的声音是否合适。";

function summarizePlan(items: AudiobookVoicePlanSuggestResult["items"]): AudiobookVoicePlanSuggestResult["summary"] {
  return {
    total: items.length,
    planned: items.length,
    presetCount: items.filter((item) => item.ttsMode === "preset").length,
    designCount: items.filter((item) => item.ttsMode === "design").length,
    overwriteCount: items.filter((item) => item.wouldOverwrite).length,
  };
}

function toPlannerInput(row: {
  id: string;
  name: string;
  gender?: string | null;
  castRole?: string | null;
  role?: string | null;
  personality?: string | null;
  voiceTexture?: string | null;
  appearance?: string | null;
  background?: string | null;
  storyFunction?: string | null;
  firstImpression?: string | null;
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsStyle?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  ttsSpeakerAliases?: string | null;
}): VoicePlannerCharacterInput {
  return {
    characterId: row.id,
    characterName: row.name,
    gender: row.gender,
    castRole: row.castRole,
    role: row.role,
    personality: row.personality,
    voiceTexture: row.voiceTexture,
    appearance: row.appearance,
    background: row.background,
    storyFunction: row.storyFunction,
    firstImpression: row.firstImpression,
    ttsMode: row.ttsMode,
    ttsVoice: row.ttsVoice,
    ttsStyle: row.ttsStyle,
    ttsDesignPrompt: row.ttsDesignPrompt,
    ttsRefAudioPath: row.ttsRefAudioPath,
    ttsSpeakerAliases: row.ttsSpeakerAliases,
  };
}

export class AudiobookVoiceAssetService {
  async suggest(novelId: string, input: AudiobookVoicePlanSuggestInput = {}): Promise<AudiobookVoicePlanSuggestResult> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        characters: {
          select: {
            id: true,
            name: true,
            gender: true,
            castRole: true,
            role: true,
            personality: true,
            voiceTexture: true,
            appearance: true,
            background: true,
            storyFunction: true,
            firstImpression: true,
            ttsMode: true,
            ttsVoice: true,
            ttsStyle: true,
            ttsDesignPrompt: true,
            ttsRefAudioPath: true,
            ttsSpeakerAliases: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    const strategy = input.strategy ?? "auto";
    const planned = planCharacterVoices({
      characters: novel.characters.map(toPlannerInput),
      strategy,
      onlyMissing: input.onlyMissing !== false,
      characterIds: input.characterIds,
      maxImportantPerPreset: input.maxImportantPerPreset,
    });

    return {
      novelId,
      strategy,
      items: planned.items,
      skipped: planned.skipped,
      summary: summarizePlan(planned.items),
    };
  }

  async apply(novelId: string, input: AudiobookVoicePlanApplyInput): Promise<AudiobookVoicePlanApplyResult> {
    if (!input.items?.length) {
      throw new AppError("apply 需要至少一项音色规划。", 400);
    }

    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        characters: {
          select: {
            id: true,
            name: true,
            ttsMode: true,
            ttsVoice: true,
            ttsDesignPrompt: true,
            ttsRefAudioPath: true,
          },
        },
      },
    });
    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    const byId = new Map(novel.characters.map((item) => [item.id, item]));
    const overwrite = Boolean(input.overwrite);
    const applied: AudiobookVoicePlanApplyResult["applied"] = [];
    const skipped: AudiobookVoicePlanApplyResult["skipped"] = [];

    for (const item of input.items) {
      const character = byId.get(item.characterId);
      if (!character) {
        skipped.push({
          characterId: item.characterId,
          characterName: item.characterId,
          reason: "角色不存在或不属于该小说。",
        });
        continue;
      }

      if (!isAudiobookTtsMode(item.ttsMode)) {
        skipped.push({
          characterId: character.id,
          characterName: character.name,
          reason: `ttsMode 非法：${item.ttsMode}`,
        });
        continue;
      }

      if (item.ttsMode === "clone") {
        skipped.push({
          characterId: character.id,
          characterName: character.name,
          reason: "规划管线不自动写 clone；请在角色卡上传参考音频。",
        });
        continue;
      }

      if (item.ttsMode === "preset") {
        const voice = item.ttsVoice?.trim() || "";
        if (!voice || !isMimoTtsPresetVoice(voice)) {
          skipped.push({
            characterId: character.id,
            characterName: character.name,
            reason: `preset 需要合法 MiMo 预置音色，收到「${voice || "空"}」。`,
          });
          continue;
        }
      }

      if (item.ttsMode === "design") {
        const prompt = item.ttsDesignPrompt?.trim() || "";
        if (!prompt) {
          skipped.push({
            characterId: character.id,
            characterName: character.name,
            reason: "design 需要 ttsDesignPrompt。",
          });
          continue;
        }
      }

      const configured = isCharacterVoiceConfigured(character);
      if (configured && !overwrite) {
        skipped.push({
          characterId: character.id,
          characterName: character.name,
          reason: "已绑定音色且 overwrite=false。",
        });
        continue;
      }

      const aliases = item.speakerAliases
        ? parseSpeakerAliases(item.speakerAliases)
        : null;

      const data: Record<string, unknown> = {
        ttsMode: item.ttsMode,
        ttsStyle: item.ttsStyle?.trim() || null,
      };

      if (item.ttsMode === "preset") {
        data.ttsVoice = item.ttsVoice!.trim();
        // 切回 preset 时清掉 design 文案，避免预检歧义
        data.ttsDesignPrompt = null;
      } else if (item.ttsMode === "design") {
        data.ttsDesignPrompt = item.ttsDesignPrompt!.trim();
        // design 不依赖 preset 名
        data.ttsVoice = item.ttsVoice?.trim() || null;
      }

      if (aliases && aliases.length > 0) {
        data.ttsSpeakerAliases = JSON.stringify(aliases);
      }

      await prisma.character.update({
        where: { id: character.id },
        data,
      });

      applied.push({
        characterId: character.id,
        characterName: character.name,
        ttsMode: item.ttsMode,
      });
    }

    return { novelId, applied, skipped };
  }

  async preview(novelId: string, input: AudiobookVoicePreviewInput): Promise<AudiobookVoicePreviewResult> {
    let characterName: string | null = null;
    let mode = input.ttsMode?.trim() || "preset";
    let voice = input.ttsVoice?.trim() || "";
    let style = input.ttsStyle?.trim() || null;
    let designPrompt = input.ttsDesignPrompt?.trim() || null;
    let refAudioPath: string | null = null;

    if (input.characterId?.trim()) {
      const character = await prisma.character.findFirst({
        where: { id: input.characterId, novelId },
        select: {
          id: true,
          name: true,
          ttsMode: true,
          ttsVoice: true,
          ttsStyle: true,
          ttsDesignPrompt: true,
          ttsRefAudioPath: true,
        },
      });
      if (!character) {
        throw new AppError("角色不存在。", 404);
      }
      characterName = character.name;
      if (!input.ttsMode) {
        mode = character.ttsMode?.trim() || "preset";
      }
      if (!input.ttsVoice) {
        voice = character.ttsVoice?.trim() || "";
      }
      if (input.ttsStyle == null) {
        style = character.ttsStyle;
      }
      if (input.ttsDesignPrompt == null) {
        designPrompt = character.ttsDesignPrompt;
      }
      refAudioPath = character.ttsRefAudioPath;
    }

    if (!isAudiobookTtsMode(mode)) {
      throw new AppError(`不支持的 TTS 模态「${mode}」。`, 400);
    }

    if (mode === "preset" && (!voice || !isMimoTtsPresetVoice(voice))) {
      throw new AppError("试听 preset 需要合法 MiMo 预置音色。", 400);
    }
    if (mode === "design" && !designPrompt?.trim()) {
      throw new AppError("试听 design 需要 ttsDesignPrompt。", 400);
    }
    if (mode === "clone" && !refAudioPath?.trim()) {
      throw new AppError("试听 clone 需要角色已配置参考音频。", 400);
    }

    const sampleText = (input.text?.trim() || DEFAULT_PREVIEW_TEXT).slice(0, 120);
    const result = await mimoChatAudioTTSProvider.synthesize({
      text: sampleText,
      mode,
      voice: mode === "preset" ? voice : null,
      style,
      designPrompt: mode === "design" ? designPrompt : null,
      refAudioPath: mode === "clone" ? refAudioPath : null,
      format: "wav",
    });

    return {
      characterId: input.characterId ?? null,
      characterName,
      ttsMode: mode,
      voice: mode === "preset" ? voice : null,
      audioBase64: result.audioBase64,
      format: "wav",
      sampleText,
    };
  }
}

export const audiobookVoiceAssetService = new AudiobookVoiceAssetService();
