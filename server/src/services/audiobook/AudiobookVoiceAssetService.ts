import fs from "node:fs";
import path from "node:path";
import {
  type AudiobookVoicePlanApplyInput,
  type AudiobookVoicePlanApplyResult,
  type AudiobookVoicePlanSuggestInput,
  type AudiobookVoicePlanSuggestResult,
  type AudiobookVoicePreviewInput,
  type AudiobookVoicePreviewResult,
  type AudiobookWorkspaceBootstrap,
  type CharacterVoicePreviewAdoptCandidateInput,
  type CharacterVoicePreviewAsset,
  type CharacterVoicePreviewCandidate,
  type CharacterVoicePreviewGenerateInput,
  type CharacterVoicePreviewGenerateResult,
  isAudiobookTtsMode,
  isMimoTtsPresetVoice,
} from "@ai-novel/shared/types/audiobook";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { parseSpeakerAliases } from "./audiobookSpeakerAliases";
import {
  resolveCharacterVoicePreviewCandidatesMetaPath,
  resolveCharacterVoicePreviewPath,
  writeCharacterVoicePreviewCandidateFromBase64,
  writeCharacterVoicePreviewFromBase64,
} from "./audiobookPaths";
import { parseWavInfo } from "./audiobookWav";
import {
  isCharacterVoiceConfigured,
  planCharacterVoices,
  type VoicePlannerCharacterInput,
} from "./audiobookVoicePlanner";
import {
  assertCharacterVoiceReadyForPreview,
  buildCharacterVoicePreviewAudioUrl,
  buildCharacterVoicePreviewFingerprint,
  clampCharacterVoicePreviewSampleText,
  DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT,
  resolveCharacterVoicePreviewStatus,
  resolveDefaultCharacterVoicePreviewText,
  resolvePreviewTtsMode,
} from "./characterVoicePreview";
import { mimoChatAudioTTSProvider } from "./MimoChatAudioTTSProvider";

const DEFAULT_PREVIEW_TEXT = DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT;
export const DEFAULT_PREVIEW_CANDIDATES = 3;
export const MAX_PREVIEW_CANDIDATES = 5;

type PreviewCandidatesMeta = {
  sampleText: string;
  fingerprint: string;
  createdAt: string;
  candidates: Array<{
    id: string;
    index: number;
    path: string;
    durationMs: number;
  }>;
  suggestedCandidateId: string | null;
};

function normalizeCandidatesCount(raw?: number | null): number {
  if (raw == null || Number.isNaN(Number(raw))) return DEFAULT_PREVIEW_CANDIDATES;
  return Math.max(1, Math.min(MAX_PREVIEW_CANDIDATES, Math.floor(Number(raw))));
}

function wavDurationMsFromBase64(base64: string): number {
  try {
    const match = /^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i.exec(base64.trim());
    const bare = (match ? match[2] : base64).replace(/\s+/g, "");
    const buf = Buffer.from(bare, "base64");
    const info = parseWavInfo(buf);
    if (info.byteRate <= 0) return 0;
    return Math.round((info.dataSize / info.byteRate) * 1000);
  } catch {
    return 0;
  }
}

/** 工程初选：剔 durationMs<=0，取最接近中位数时长的一条。 */
export function pickMedianDurationCandidateIndex(durationsMs: number[]): number {
  if (durationsMs.length === 0) return 0;
  const valid = durationsMs
    .map((ms, index) => ({ ms, index }))
    .filter((row) => row.ms > 0);
  if (valid.length === 0) return 0;
  const sorted = [...valid].sort((a, b) => a.ms - b.ms);
  const mid = sorted[Math.floor((sorted.length - 1) / 2)]!;
  return mid.index;
}

function buildCandidateAudioUrl(
  novelId: string,
  characterId: string,
  candidateId: string,
): string {
  return `/novels/${encodeURIComponent(novelId)}/characters/${encodeURIComponent(characterId)}/voice-preview/candidates/${encodeURIComponent(candidateId)}/audio`;
}

function writeCandidatesMeta(novelId: string, characterId: string, meta: PreviewCandidatesMeta): void {
  const metaPath = resolveCharacterVoicePreviewCandidatesMetaPath(novelId, characterId);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
}

function readCandidatesMeta(novelId: string, characterId: string): PreviewCandidatesMeta | null {
  const metaPath = resolveCharacterVoicePreviewCandidatesMetaPath(novelId, characterId);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, "utf8")) as PreviewCandidatesMeta;
    if (!raw || !Array.isArray(raw.candidates)) return null;
    return raw;
  } catch {
    return null;
  }
}

function promoteCandidateToPreview(sourcePath: string, novelId: string, characterId: string): string {
  const previewPath = resolveCharacterVoicePreviewPath(novelId, characterId);
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  const buf = fs.readFileSync(sourcePath);
  const tmp = `${previewPath}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, previewPath);
  return previewPath;
}

function summarizePlan(
  items: AudiobookVoicePlanSuggestResult["items"],
  skipped: AudiobookVoicePlanSuggestResult["skipped"] = [],
): AudiobookVoicePlanSuggestResult["summary"] {
  const designItems = items.filter((item) => item.ttsMode === "design");
  const designLens = designItems
    .map((item) => item.ttsDesignPrompt?.trim().length ?? 0)
    .filter((n) => n > 0);
  const designPromptAvgLen = designLens.length
    ? Math.round(designLens.reduce((a, b) => a + b, 0) / designLens.length)
    : 0;
  return {
    total: items.length,
    planned: items.length,
    presetCount: items.filter((item) => item.ttsMode === "preset").length,
    designCount: designItems.length,
    overwriteCount: items.filter((item) => item.wouldOverwrite).length,
    softCollisionCount: items.filter((item) => item.reason.includes("collision:soft")).length,
    slotOverrideCount: items.filter((item) => item.reason.includes("slot:override")).length,
    seedInferredCount: skipped.filter((item) => item.reason.includes("seed:inferred")).length,
    designPromptAvgLen,
    archetypeHitCount: items.filter((item) => item.reason.includes("archetype:")).length,
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
  /**
   * 有声书页首屏数据：章节仅 id/order/title，角色仅音色相关字段。
   * 禁止 include 章节 content（源世界整本 getNovelDetail ~2MB）。
   */
  async getWorkspaceBootstrap(novelId: string): Promise<AudiobookWorkspaceBootstrap> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        title: true,
        audiobookNarratorVoice: true,
        audiobookNarratorStyle: true,
        chapters: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            order: true,
            title: true,
          },
        },
        characters: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            gender: true,
            castRole: true,
            role: true,
            ttsMode: true,
            ttsVoice: true,
            ttsStyle: true,
            ttsDesignPrompt: true,
            ttsRefAudioPath: true,
            ttsSpeakerAliases: true,
            ttsPreviewAudioPath: true,
            ttsPreviewSampleText: true,
            ttsPreviewFingerprint: true,
            ttsPreviewGeneratedAt: true,
          },
        },
      },
    });

    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    return {
      novelId: novel.id,
      title: novel.title,
      audiobookNarratorVoice: novel.audiobookNarratorVoice ?? null,
      audiobookNarratorStyle: novel.audiobookNarratorStyle ?? null,
      chapters: novel.chapters,
      characters: novel.characters.map((character) => {
        const sampleText =
          character.ttsPreviewSampleText?.trim()
          || resolveDefaultCharacterVoicePreviewText({ gender: character.gender });
        const currentFingerprint = buildCharacterVoicePreviewFingerprint(character, sampleText);
        return {
          ...character,
          ttsPreviewGeneratedAt: character.ttsPreviewGeneratedAt?.toISOString() ?? null,
          voicePreviewStatus: resolveCharacterVoicePreviewStatus({
            audioPath: character.ttsPreviewAudioPath,
            fingerprint: character.ttsPreviewFingerprint,
            currentFingerprint,
          }),
        };
      }),
      chapterCount: novel.chapters.length,
      characterCount: novel.characters.length,
    };
  }

  async suggest(novelId: string, input: AudiobookVoicePlanSuggestInput = {}): Promise<AudiobookVoicePlanSuggestResult> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        audiobookNarratorVoice: true,
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

    const narratorVoice = novel.audiobookNarratorVoice?.trim() || "";
    const reservedFromNovel =
      narratorVoice && isMimoTtsPresetVoice(narratorVoice) ? [narratorVoice] : [];
    const reservedPresets = [
      ...new Set(
        [...(input.reservedPresets ?? []), ...reservedFromNovel]
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ];

    const strategy = input.strategy ?? "auto";
    const planned = planCharacterVoices({
      characters: novel.characters.map(toPlannerInput),
      strategy,
      onlyMissing: input.onlyMissing !== false,
      characterIds: input.characterIds,
      maxImportantPerPreset: input.maxImportantPerPreset,
      reservedPresets,
    });

    return {
      novelId,
      strategy,
      items: planned.items,
      skipped: planned.skipped,
      summary: summarizePlan(planned.items, planned.skipped),
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

      const currentMode = character.ttsMode?.trim() || "preset";
      if (currentMode === "clone" && character.ttsRefAudioPath?.trim()) {
        skipped.push({
          characterId: character.id,
          characterName: character.name,
          reason: "已配置 clone 参考音频，apply 不覆盖。",
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
        // 切到 preset/design 时清掉 clone 参考路径，避免预检/合成仍走旧 clone
        ttsRefAudioPath: null,
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

  /**
   * @deprecated 产品路径请用 generateCharacterPreview / getCharacterPreview。
   * 带 characterId 时改为固化试听资产；无 characterId 仍 ephemeral（调试）。
   */
  async preview(novelId: string, input: AudiobookVoicePreviewInput): Promise<AudiobookVoicePreviewResult> {
    if (input.characterId?.trim()) {
      const result = await this.generateCharacterPreview(novelId, input.characterId.trim(), {
        text: input.text,
        candidates: 1,
        autoAdoptWinner: true,
      });
      const adopted = result.adopted;
      if (!adopted?.audioBase64) {
        throw new AppError("试听生成失败。", 500);
      }
      return {
        characterId: adopted.characterId,
        characterName: adopted.characterName,
        ttsMode: adopted.ttsMode,
        voice: adopted.voice ?? null,
        audioBase64: adopted.audioBase64,
        format: "wav",
        sampleText: adopted.sampleText ?? DEFAULT_PREVIEW_TEXT,
      };
    }

    let mode = input.ttsMode?.trim() || "preset";
    let voice = input.ttsVoice?.trim() || "";
    let style = input.ttsStyle?.trim() || null;
    let designPrompt = input.ttsDesignPrompt?.trim() || null;

    if (!isAudiobookTtsMode(mode)) {
      throw new AppError(`不支持的 TTS 模态「${mode}」。`, 400);
    }
    if (mode === "preset" && (!voice || !isMimoTtsPresetVoice(voice))) {
      throw new AppError("试听 preset 需要合法 MiMo 预置音色。", 400);
    }
    if (mode === "design" && !designPrompt?.trim()) {
      throw new AppError("试听 design 需要 ttsDesignPrompt。", 400);
    }
    if (mode === "clone") {
      throw new AppError("ephemeral 试听不支持 clone；请走角色卡生成试听。", 400);
    }

    const sampleText = clampCharacterVoicePreviewSampleText(input.text?.trim() || DEFAULT_PREVIEW_TEXT);
    const result = await mimoChatAudioTTSProvider.synthesize({
      text: sampleText,
      mode,
      voice: mode === "preset" ? voice : null,
      style,
      designPrompt: mode === "design" ? designPrompt : null,
      refAudioPath: null,
      format: "wav",
    });

    return {
      characterId: null,
      characterName: null,
      ttsMode: mode,
      voice: mode === "preset" ? voice : null,
      audioBase64: result.audioBase64,
      format: "wav",
      sampleText,
    };
  }

  async getCharacterPreview(novelId: string, characterId: string): Promise<CharacterVoicePreviewAsset> {
    const character = await prisma.character.findFirst({
      where: { id: characterId, novelId },
      select: {
        id: true,
        name: true,
        gender: true,
        ttsMode: true,
        ttsVoice: true,
        ttsStyle: true,
        ttsDesignPrompt: true,
        ttsRefAudioPath: true,
        ttsPreviewAudioPath: true,
        ttsPreviewSampleText: true,
        ttsPreviewFingerprint: true,
        ttsPreviewGeneratedAt: true,
      },
    });
    if (!character) {
      throw new AppError("角色不存在。", 404);
    }

    const mode = resolvePreviewTtsMode(character.ttsMode);
    const sampleForFingerprint =
      character.ttsPreviewSampleText?.trim()
      || resolveDefaultCharacterVoicePreviewText({ gender: character.gender });
    const currentFingerprint = buildCharacterVoicePreviewFingerprint(character, sampleForFingerprint);
    const status = resolveCharacterVoicePreviewStatus({
      audioPath: character.ttsPreviewAudioPath,
      fingerprint: character.ttsPreviewFingerprint,
      currentFingerprint,
    });

    return {
      characterId: character.id,
      characterName: character.name,
      status,
      ttsMode: mode,
      voice: mode === "preset" ? character.ttsVoice?.trim() || null : null,
      sampleText: character.ttsPreviewSampleText ?? null,
      fingerprint: character.ttsPreviewFingerprint ?? null,
      currentFingerprint,
      generatedAt: character.ttsPreviewGeneratedAt?.toISOString() ?? null,
      audioUrl: status === "missing" ? null : buildCharacterVoicePreviewAudioUrl(novelId, characterId),
      audioBase64: null,
      format: "wav",
    };
  }

  /**
   * 生成角色试听。默认多抽 3 条；candidates=1 或 autoAdoptWinner 时写入正式 preview。
   * 返回 CharacterVoicePreviewGenerateResult。
   */
  async generateCharacterPreview(
    novelId: string,
    characterId: string,
    input: CharacterVoicePreviewGenerateInput = {},
  ): Promise<CharacterVoicePreviewGenerateResult> {
    const character = await prisma.character.findFirst({
      where: { id: characterId, novelId },
      select: {
        id: true,
        name: true,
        gender: true,
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

    let ready: ReturnType<typeof assertCharacterVoiceReadyForPreview>;
    try {
      ready = assertCharacterVoiceReadyForPreview(character);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "音色配置不完整，无法生成试听。", 400);
    }

    const sampleText = clampCharacterVoicePreviewSampleText(
      input.text?.trim()
        || resolveDefaultCharacterVoicePreviewText({ gender: character.gender }),
    );
    const fingerprint = buildCharacterVoicePreviewFingerprint(character, sampleText);
    const candidatesCount = normalizeCandidatesCount(input.candidates);
    // job/prepare 默认 auto-adopt；UI 多抽默认 false
    const autoAdopt =
      input.autoAdoptWinner === true
      || (input.autoAdoptWinner !== false && candidatesCount === 1);

    const drawn: Array<{
      id: string;
      index: number;
      path: string;
      durationMs: number;
      base64: string;
    }> = [];

    for (let i = 0; i < candidatesCount; i += 1) {
      const synth = await mimoChatAudioTTSProvider.synthesize({
        text: sampleText,
        mode: ready.mode,
        voice: ready.mode === "preset" ? ready.voice : null,
        style: ready.style,
        designPrompt: ready.mode === "design" ? ready.designPrompt : null,
        refAudioPath: ready.mode === "clone" ? ready.refAudioPath : null,
        format: "wav",
      });
      let filePath: string;
      try {
        if (candidatesCount === 1 && autoAdopt) {
          filePath = writeCharacterVoicePreviewFromBase64({
            novelId,
            characterId,
            base64: synth.audioBase64,
          });
        } else {
          filePath = writeCharacterVoicePreviewCandidateFromBase64({
            novelId,
            characterId,
            index: i,
            base64: synth.audioBase64,
          });
        }
      } catch (error) {
        throw new AppError(error instanceof Error ? error.message : "试听音频落盘失败。", 500);
      }
      drawn.push({
        id: `c${i}`,
        index: i,
        path: filePath,
        durationMs: wavDurationMsFromBase64(synth.audioBase64),
        base64: synth.audioBase64,
      });
    }

    const winnerIndex = pickMedianDurationCandidateIndex(drawn.map((d) => d.durationMs));
    const suggested = drawn[winnerIndex] ?? drawn[0]!;
    const suggestedCandidateId = suggested.id;

    if (candidatesCount > 1 || !autoAdopt) {
      writeCandidatesMeta(novelId, characterId, {
        sampleText,
        fingerprint,
        createdAt: new Date().toISOString(),
        candidates: drawn.map((d) => ({
          id: d.id,
          index: d.index,
          path: d.path,
          durationMs: d.durationMs,
        })),
        suggestedCandidateId,
      });
    }

    let adopted: CharacterVoicePreviewAsset | null = null;
    if (autoAdopt) {
      if (candidatesCount > 1) {
        try {
          promoteCandidateToPreview(suggested.path, novelId, characterId);
        } catch (error) {
          throw new AppError(error instanceof Error ? error.message : "写入正式试听失败。", 500);
        }
      }
      const generatedAt = new Date();
      const previewPath = resolveCharacterVoicePreviewPath(novelId, characterId);
      await prisma.character.update({
        where: { id: characterId },
        data: {
          ttsPreviewAudioPath: previewPath,
          ttsPreviewSampleText: sampleText,
          ttsPreviewFingerprint: fingerprint,
          ttsPreviewGeneratedAt: generatedAt,
        },
      });
      adopted = {
        characterId: character.id,
        characterName: character.name,
        status: "ready",
        ttsMode: ready.mode,
        voice: ready.mode === "preset" ? ready.voice : null,
        sampleText,
        fingerprint,
        currentFingerprint: fingerprint,
        generatedAt: generatedAt.toISOString(),
        audioUrl: buildCharacterVoicePreviewAudioUrl(novelId, characterId),
        audioBase64: suggested.base64,
        format: "wav",
      };
    }

    const candidates: CharacterVoicePreviewCandidate[] = drawn.map((d) => ({
      id: d.id,
      index: d.index,
      durationMs: d.durationMs,
      audioUrl:
        candidatesCount === 1 && autoAdopt
          ? buildCharacterVoicePreviewAudioUrl(novelId, characterId)
          : buildCandidateAudioUrl(novelId, characterId, d.id),
      audioBase64: d.base64,
      selected: autoAdopt ? d.id === suggestedCandidateId : false,
    }));

    return {
      characterId: character.id,
      characterName: character.name,
      ttsMode: ready.mode,
      voice: ready.mode === "preset" ? ready.voice : null,
      sampleText,
      format: "wav",
      candidates,
      adopted,
      suggestedCandidateId,
    };
  }

  /**
   * 将多抽候选固化为正式 preview.wav。
   */
  async adoptPreviewCandidate(
    novelId: string,
    characterId: string,
    input: CharacterVoicePreviewAdoptCandidateInput,
  ): Promise<CharacterVoicePreviewAsset> {
    const candidateId = input.candidateId?.trim();
    if (!candidateId) {
      throw new AppError("candidateId 不能为空。", 400);
    }

    const character = await prisma.character.findFirst({
      where: { id: characterId, novelId },
      select: {
        id: true,
        name: true,
        gender: true,
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

    const meta = readCandidatesMeta(novelId, characterId);
    if (!meta) {
      throw new AppError("没有可采用的试听候选，请先多抽生成。", 400);
    }
    const row = meta.candidates.find((c) => c.id === candidateId);
    if (!row) {
      throw new AppError(`候选 ${candidateId} 不存在。`, 404);
    }
    if (!fs.existsSync(row.path)) {
      throw new AppError("候选音频文件缺失，请重新生成。", 404);
    }

    let previewPath: string;
    try {
      previewPath = promoteCandidateToPreview(row.path, novelId, characterId);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "采用候选失败。", 500);
    }

    const sampleText = clampCharacterVoicePreviewSampleText(meta.sampleText || DEFAULT_PREVIEW_TEXT);
    const fingerprint = buildCharacterVoicePreviewFingerprint(character, sampleText);
    const generatedAt = new Date();
    await prisma.character.update({
      where: { id: characterId },
      data: {
        ttsPreviewAudioPath: previewPath,
        ttsPreviewSampleText: sampleText,
        ttsPreviewFingerprint: fingerprint,
        ttsPreviewGeneratedAt: generatedAt,
      },
    });

    const mode = resolvePreviewTtsMode(character.ttsMode);
    return {
      characterId: character.id,
      characterName: character.name,
      status: "ready",
      ttsMode: mode,
      voice: mode === "preset" ? character.ttsVoice?.trim() || null : null,
      sampleText,
      fingerprint,
      currentFingerprint: fingerprint,
      generatedAt: generatedAt.toISOString(),
      audioUrl: buildCharacterVoicePreviewAudioUrl(novelId, characterId),
      audioBase64: null,
      format: "wav",
    };
  }

  resolvePreviewFilePath(novelId: string, characterId: string, storedPath?: string | null): string | null {
    const preferred = storedPath?.trim();
    const fallback = resolveCharacterVoicePreviewPath(novelId, characterId);
    if (preferred) {
      return preferred;
    }
    return fallback;
  }

  resolvePreviewCandidateFilePath(
    novelId: string,
    characterId: string,
    candidateId: string,
  ): string | null {
    const meta = readCandidatesMeta(novelId, characterId);
    if (!meta) return null;
    const row = meta.candidates.find((c) => c.id === candidateId);
    if (!row?.path || !fs.existsSync(row.path)) return null;
    return row.path;
  }
}


export const audiobookVoiceAssetService = new AudiobookVoiceAssetService();
