import { prisma } from "../../db/prisma";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import {
  characterEvolutionPrompt,
  characterWorldCheckPrompt,
} from "../../prompting/prompts/novel/coreCharacter.prompts";
import { writeCharacterVoiceRefFromBase64 } from "../audiobook/audiobookPaths";
import { voiceLibraryService } from "../audiobook/voiceLibraryService";
import { parseSpeakerAliases } from "../audiobook/audiobookSpeakerAliases";
import { ragServices } from "../rag";
import { decideCharacterVoiceRefUpdate } from "./characterVoiceRefUpdate";
import { queueRagDelete, queueRagUpsert } from "./novelCoreSupport";
import { WorldContextGateway } from "./worldContext/WorldContextGateway";
import {
  CharacterInput,
  CharacterTimelineSyncOptions,
  extractCharacterEventLines,
  LLMGenerateOptions,
} from "./novelCoreShared";
import { serializeCharacterProhibitions } from "./characters/characterHardFacts";

function normalizeTtsSpeakerAliases(
  value: string | string[] | null | undefined,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const aliases = parseSpeakerAliases(value);
  if (aliases.length === 0) {
    return null;
  }
  return JSON.stringify(aliases);
}

export class NovelCoreCharacterService {
  private readonly worldContextGateway = new WorldContextGateway();

  async listCharacters(novelId: string) {
    return prisma.character.findMany({ where: { novelId }, orderBy: { createdAt: "asc" } });
  }

  async createCharacter(novelId: string, input: CharacterInput) {
    let payload: CharacterInput = { ...input };
    if (input.baseCharacterId) {
      const baseCharacter = await prisma.baseCharacter.findUnique({
        where: { id: input.baseCharacterId },
      });
      if (!baseCharacter) {
        throw new Error("基础角色不存在");
      }
      payload = {
        ...payload,
        personality: input.personality ?? baseCharacter.personality,
        background: input.background ?? baseCharacter.background,
        development: input.development ?? baseCharacter.development,
        appearance: input.appearance ?? baseCharacter.appearance ?? undefined,
      };
    }

    // 安全：剥离客户端裸 ttsRefAudioPath；仅 base64 / voiceAssetId 由服务端写路径
    const {
      prohibitions,
      ttsRefAudioBase64,
      ttsSpeakerAliases,
      ttsRefAudioPath: _ignoredClientRefPath,
      ttsVoiceAssetId: clientAssetId,
      ...data
    } = payload;
    void _ignoredClientRefPath;
    const aliasesJson = normalizeTtsSpeakerAliases(ttsSpeakerAliases);

    // 绑库前校验：失败不落库，避免半成品角色
    let bindPrep: ReturnType<typeof voiceLibraryService.assertBindableCloneRef> | null = null;
    if (clientAssetId?.trim()) {
      bindPrep = voiceLibraryService.assertBindableCloneRef(clientAssetId.trim());
    }

    const created = await prisma.character.create({
      data: {
        novelId,
        ...data,
        ...(bindPrep
          ? {
              ttsMode: "clone",
              ttsRefAudioPath: bindPrep.absolutePath,
              ttsVoiceAssetId: bindPrep.asset.id,
              ttsVoice: null,
              ttsDesignPrompt: null,
            }
          : {
              ttsRefAudioPath: null,
              ttsVoiceAssetId: null,
            }),
        ...(aliasesJson !== undefined ? { ttsSpeakerAliases: aliasesJson } : {}),
        ...(prohibitions ? { prohibitionsJson: serializeCharacterProhibitions(prohibitions) } : {}),
      },
    });

    if (bindPrep) {
      queueRagUpsert("character", created.id);
      return created;
    }

    if (ttsRefAudioBase64?.trim()) {
      const refPath = writeCharacterVoiceRefFromBase64({
        novelId,
        characterId: created.id,
        base64: ttsRefAudioBase64,
      });
      const withRef = await prisma.character.update({
        where: { id: created.id },
        data: {
          ttsRefAudioPath: refPath,
          ttsMode: data.ttsMode ?? "clone",
          ttsVoiceAssetId: null,
        },
      });
      queueRagUpsert("character", withRef.id);
      return withRef;
    }

    queueRagUpsert("character", created.id);
    return created;
  }

  async updateCharacter(novelId: string, characterId: string, input: Partial<CharacterInput>) {
    const exists = await prisma.character.findFirst({
      where: { id: characterId, novelId },
      select: { id: true, currentState: true, currentGoal: true },
    });
    if (!exists) {
      throw new Error("角色不存在");
    }

    const hasStateChanged = typeof input.currentState === "string" && input.currentState !== exists.currentState;
    const hasGoalChanged = typeof input.currentGoal === "string" && input.currentGoal !== exists.currentGoal;
    // 安全：剥离客户端裸 ttsRefAudioPath；仅 base64 落盘 / asset bind / 显式 null 清空
    const {
      prohibitions,
      ttsRefAudioBase64,
      ttsSpeakerAliases,
      ttsRefAudioPath: clientRefPath,
      ttsVoiceAssetId: clientAssetId,
      ...data
    } = input;
    const aliasesJson = normalizeTtsSpeakerAliases(ttsSpeakerAliases);

    let nextData: Record<string, unknown> = {
      ...data,
      ...(aliasesJson !== undefined ? { ttsSpeakerAliases: aliasesJson } : {}),
      ...(prohibitions ? { prohibitionsJson: serializeCharacterProhibitions(prohibitions) } : {}),
      ...(hasStateChanged || hasGoalChanged ? { lastEvolvedAt: new Date() } : {}),
    };
    // 禁止客户端任意写路径；null 允许清空；有值的字符串一律忽略
    if (clientRefPath === null) {
      nextData.ttsRefAudioPath = null;
    }

    // assetId 非空 → 绑库；否则 base64 写盘（含同请求 assetId:null）；否则仅 null 清 asset
    // 不可先处理 assetId===null 再 else-if base64，否则会吞掉「上传覆盖库绑定」
    const voiceRefDecision = decideCharacterVoiceRefUpdate({
      ttsVoiceAssetId: clientAssetId,
      ttsRefAudioBase64,
    });
    if (voiceRefDecision.action === "bind") {
      const { asset, absolutePath } = voiceLibraryService.assertBindableCloneRef(
        voiceRefDecision.voiceAssetId,
      );
      nextData = {
        ...nextData,
        ttsMode: "clone",
        ttsRefAudioPath: absolutePath,
        ttsVoiceAssetId: asset.id,
        ttsVoice: null,
        ttsDesignPrompt: null,
      };
    } else if (voiceRefDecision.action === "write_base64") {
      const refPath = writeCharacterVoiceRefFromBase64({
        novelId,
        characterId,
        base64: voiceRefDecision.base64,
      });
      nextData = {
        ...nextData,
        ttsRefAudioPath: refPath,
        ttsMode: data.ttsMode ?? "clone",
        ttsVoiceAssetId: null,
      };
    } else if (voiceRefDecision.action === "clear_asset") {
      nextData.ttsVoiceAssetId = null;
    }

    const updated = await prisma.character.update({
      where: { id: characterId },
      data: nextData,
    });

    queueRagUpsert("character", updated.id);
    return updated;
  }

  async deleteCharacter(novelId: string, characterId: string) {
    queueRagDelete("character", characterId);
    const deleted = await prisma.character.deleteMany({ where: { id: characterId, novelId } });
    if (deleted.count === 0) {
      throw new Error("角色不存在");
    }
  }

  async listCharacterTimeline(novelId: string, characterId: string) {
    return prisma.characterTimeline.findMany({
      where: { novelId, characterId },
      orderBy: [{ chapterOrder: "asc" }, { createdAt: "asc" }],
    });
  }

  async syncCharacterTimeline(
    novelId: string,
    characterId: string,
    options: CharacterTimelineSyncOptions = {},
  ) {
    const character = await prisma.character.findFirst({
      where: { id: characterId, novelId },
    });
    if (!character) {
      throw new Error("角色不存在");
    }

    const chapters = await prisma.chapter.findMany({
      where: {
        novelId,
        ...(typeof options.startOrder === "number" || typeof options.endOrder === "number"
          ? {
            order: {
              gte: options.startOrder ?? undefined,
              lte: options.endOrder ?? undefined,
            },
          }
          : {}),
      },
      orderBy: { order: "asc" },
      select: {
        id: true,
        order: true,
        title: true,
        content: true,
      },
    });

    const events: Array<{
      novelId: string;
      characterId: string;
      chapterId: string;
      chapterOrder: number;
      title: string;
      content: string;
      source: string;
    }> = [];

    for (const chapter of chapters) {
      const content = chapter.content ?? "";
      if (!content) {
        continue;
      }
      const lines = extractCharacterEventLines(content, character.name, 3);
      for (const line of lines) {
        events.push({
          novelId,
          characterId,
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          title: `${chapter.order} · ${chapter.title}`,
          content: line,
          source: "chapter_extract",
        });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.characterTimeline.deleteMany({
        where: {
          novelId,
          characterId,
          source: "chapter_extract",
          ...(typeof options.startOrder === "number" || typeof options.endOrder === "number"
            ? {
              chapterOrder: {
                gte: options.startOrder ?? undefined,
                lte: options.endOrder ?? undefined,
              },
            }
            : {}),
        },
      });
      if (events.length > 0) {
        await tx.characterTimeline.createMany({
          data: events,
        });
      }
    });

    const total = await prisma.characterTimeline.count({
      where: { novelId, characterId },
    });

    return {
      characterId,
      syncedCount: events.length,
      totalTimelineCount: total,
    };
  }

  async syncAllCharacterTimeline(novelId: string, options: CharacterTimelineSyncOptions = {}) {
    const characters = await prisma.character.findMany({
      where: { novelId },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (characters.length === 0) {
      return {
        characterCount: 0,
        syncedCount: 0,
        details: [] as Array<{ characterId: string; syncedCount: number; totalTimelineCount: number }>,
      };
    }

    const details = await Promise.all(
      characters.map((character) => this.syncCharacterTimeline(novelId, character.id, options)),
    );
    const syncedCount = details.reduce((sum, item) => sum + item.syncedCount, 0);

    return {
      characterCount: characters.length,
      syncedCount,
      details,
    };
  }

  async evolveCharacter(
    novelId: string,
    characterId: string,
    options: LLMGenerateOptions = {},
  ) {
    const [novel, character, timelines] = await Promise.all([
      prisma.novel.findUnique({
        where: { id: novelId },
        include: { bible: true },
      }),
      prisma.character.findFirst({
        where: { id: characterId, novelId },
      }),
      prisma.characterTimeline.findMany({
        where: { novelId, characterId },
        orderBy: [{ chapterOrder: "desc" }, { createdAt: "desc" }],
        take: 20,
      }),
    ]);

    if (!novel || !character) {
      throw new Error("小说或角色不存在");
    }

    const timelineText = timelines.length > 0
      ? timelines
        .map((item) => `${item.title}: ${item.content}`)
        .join("\n")
      : "暂无时间线事件";

    let ragContext = "";
    try {
      ragContext = await ragServices.hybridRetrievalService.buildContextBlock(
        `角色演进 ${character.name}\n${timelineText}`,
        {
          novelId,
          ownerTypes: ["character", "character_timeline", "chapter_summary", "consistency_fact", "novel", "bible"],
          finalTopK: 6,
        },
      );
    } catch {
      ragContext = "";
    }

    const result = await runStructuredPrompt({
      asset: characterEvolutionPrompt,
      promptInput: {
        novelTitle: novel.title,
        bibleContent: novel.bible?.rawContent ?? "暂无",
        characterName: character.name,
        characterRole: character.role,
        personality: character.personality ?? "暂无",
        background: character.background ?? "暂无",
        development: character.development ?? "暂无",
        currentState: character.currentState ?? "暂无",
        currentGoal: character.currentGoal ?? "暂无",
        timelineText,
        ragContext: ragContext || "",
      },
      options: {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature ?? 0.4,
      },
    });
    const parsed = result.output;

    const updated = await prisma.character.update({
      where: { id: characterId },
      data: {
        personality: parsed.personality ?? character.personality,
        background: parsed.background ?? character.background,
        development: parsed.development ?? character.development,
        currentState: parsed.currentState ?? character.currentState,
        currentGoal: parsed.currentGoal ?? character.currentGoal,
        lastEvolvedAt: new Date(),
      },
    });

    await prisma.characterTimeline.create({
      data: {
        novelId,
        characterId,
        title: `角色演进更新 · ${new Date().toLocaleString("zh-CN")}`,
        content: `状态：${updated.currentState ?? "暂无"}；目标：${updated.currentGoal ?? "暂无"}`,
        source: "ai_evolve",
      },
    });

    return updated;
  }

  async checkCharacterAgainstWorld(
    novelId: string,
    characterId: string,
    options: LLMGenerateOptions = {},
  ) {
    const [novel, character] = await Promise.all([
      prisma.novel.findUnique({
        where: { id: novelId },
        select: { id: true },
      }),
      prisma.character.findFirst({
        where: { id: characterId, novelId },
      }),
    ]);
    if (!novel || !character) {
      throw new Error("小说或角色不存在");
    }
    const worldContextBlock = await this.worldContextGateway.getWorldContextBlock(novelId, {
      purpose: "character",
      provider: options.provider,
      model: options.model,
      temperature: options.temperature,
    });
    if (!worldContextBlock) {
      return {
        status: "pass" as const,
        warnings: ["当前没有可用的本书世界上下文，无法执行严格世界规则检查。"],
        issues: [],
      };
    }

    const worldContext = worldContextBlock.promptBlock;
    try {
      const result = await runStructuredPrompt({
        asset: characterWorldCheckPrompt,
        promptInput: {
          worldContext,
          characterName: character.name,
          characterRole: character.role,
          personality: character.personality ?? "",
          background: character.background ?? "",
          development: character.development ?? "",
          currentState: character.currentState ?? "",
          currentGoal: character.currentGoal ?? "",
        },
        options: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature ?? 0.2,
        },
      });
      const parsed = result.output;

      return {
        status: parsed.status ?? "pass",
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      };
    } catch {
      return {
        status: "warn" as const,
        warnings: ["AI 检查失败，返回规则回退结果"],
        issues: [] as Array<{ severity: "warn" | "error"; message: string; suggestion?: string }>,
      };
    }
  }
}
