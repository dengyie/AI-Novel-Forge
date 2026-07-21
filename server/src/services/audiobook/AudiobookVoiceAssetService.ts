import fs from "node:fs";
import path from "node:path";
import {
  type AudiobookVoicePlanApplyInput,
  type AudiobookVoicePlanApplyResult,
  type AudiobookVoicePlanSuggestInput,
  type AudiobookVoicePlanSuggestResult,
  type AudiobookVoicePreviewInput,
  type AudiobookVoicePreviewResult,
  type AudiobookVoiceLibraryMatchesResult,
  type AudiobookVoiceLibraryMatchItem,
  type AudiobookWorkspaceBootstrap,
  type CharacterVoiceAdoptPreviewAsCloneInput,
  type CharacterVoiceAdoptPreviewAsCloneResult,
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
  copyCharacterVoicePreviewToRef,
  resolveCharacterVoicePreviewCandidatesMetaPath,
  resolveCharacterVoicePreviewPath,
  writeCharacterVoicePreviewCandidateFromBase64,
  writeCharacterVoicePreviewFromBase64,
} from "./audiobookPaths";
import { checkVoiceRefAudioPath } from "./voiceRefPath";
import { isValidPcmWavFile, parseWavInfo } from "./audiobookWav";
import {
  isCharacterVoiceConfigured,
  planCharacterVoices,
  type VoicePlannerCharacterInput,
  type VoicePlannerLibraryAsset,
  type VoiceCluster,
  type VoiceSlot,
  inferGenderBucket,
  resolveVoiceCluster,
  inferVoiceSlot,
  speakerKeyFromTags,
  collectLibraryAssetCandidates,
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
import { tryResolveEffectiveCloneRefPath, voiceLibraryService } from "./voiceLibraryService";
import {
  buildVoiceBrief,
  buildRuleVoiceBrief,
  formatBookContext,
  type BookVoiceContext,
  type VoiceBrief,
} from "./voiceBriefService";
import { pickLibraryAssetWithLlm } from "./voiceLibraryPickService";
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
  /** 已采用写入 formal preview 的候选 id；未采用则为 null（多抽未选优时禁止锁克隆）。 */
  adoptedCandidateId?: string | null;
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

function writeCandidatesMetaAtomic(
  novelId: string,
  characterId: string,
  meta: PreviewCandidatesMeta,
): void {
  const metaPath = resolveCharacterVoicePreviewCandidatesMetaPath(novelId, characterId);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  const tmp = `${metaPath}.${process.pid}.part`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf8");
  fs.renameSync(tmp, metaPath);
}

/** per-character in-flight preview generate 锁，防并发重复扣合成额度 + 文件竞争。 */
export const activePreviewGenerateKeys = new Set<string>();
export function acquirePreviewGenerateLock(novelId: string, characterId: string): string {
  const key = `${novelId}:${characterId}`;
  if (activePreviewGenerateKeys.has(key)) {
    throw new AppError("该角色试听正在生成，请等待当前完成后再试。", 409);
  }
  activePreviewGenerateKeys.add(key);
  return key;
}
export function releasePreviewGenerateLock(key: string): void {
  activePreviewGenerateKeys.delete(key);
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

/**
 * 多抽会话未选优时禁止用旧 formal preview 升格 clone。
 * meta 指纹与当前一致且 candidates>1 且未 adopted → 阻塞。
 */
export function assertMultiDrawAdoptedForCloneLock(
  meta: PreviewCandidatesMeta | null,
  currentFingerprint: string,
): void {
  if (!meta || !Array.isArray(meta.candidates) || meta.candidates.length <= 1) {
    return;
  }
  if (meta.fingerprint && meta.fingerprint !== currentFingerprint) {
    // 配置已变：走 ready/stale 主门禁即可
    return;
  }
  const adopted = meta.adoptedCandidateId?.trim() || "";
  if (!adopted) {
    throw new AppError(
      "当前存在未采用的多抽候选。请先采用一条候选写入正式试听，再锁定克隆身份。",
      400,
    );
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
    cloneCount: items.filter(
      (item) => item.ttsMode === "clone" && Boolean(item.ttsVoiceAssetId?.trim()),
    ).length,
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
  ttsVoiceAssetId?: string | null;
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
    ttsVoiceAssetId: row.ttsVoiceAssetId,
    ttsSpeakerAliases: row.ttsSpeakerAliases,
  };
}

function loadApprovedLibraryAssets(): VoicePlannerLibraryAsset[] {
  // 分页拉全量 approved，避免 LIST_MAX_LIMIT 截断导致规划漏库
  const pageSize = 500;
  const items: VoicePlannerLibraryAsset[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const listed = voiceLibraryService.list({
      status: "approved",
      kind: "clone_ref",
      limit: pageSize,
      offset,
    });
    total = listed.total;
    for (const a of listed.items) {
      items.push({
        id: a.id,
        slug: a.slug,
        displayName: a.displayName,
        status: a.status,
        kind: a.kind,
        tags: a.tags ?? [],
      });
    }
    if (!listed.items.length) break;
    offset += listed.items.length;
    if (offset > 50_000) {
      console.warn(
        `[voice-plan] approved clone_ref library page loop safety stop: injected=${items.length} total=${total}`,
      );
      break;
    }
  }
  return items;
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
            ttsVoiceAssetId: true,
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

  /**
   * 「人物卡 ↔ VoiceAsset 对靠」：为单角色返回 top-N 库候选（approved clone_ref）。
   * - 单次 collectLibraryAssetCandidates 打分（gender/cluster/scope/speaker 去重/L2 轻加权），
   *   top-N slice 与 excludedCount 复用同一结果，不二次打分
   * - 全书 speaker 去重视角：本书其他角色已绑定的 asset/speaker 进 usedSpeakerKeys，
   *   候选保留并标 occupiedBy（不硬排除，供人工覆盖）
   * - 不读角色 ttsRefAudioPath 绝对路径；不落库；不做听感证明
   * 安全：仅 approved clone_ref 可入候选；试听入口由前端走库 media-access 端点
   */
  async listVoiceLibraryMatches(
    novelId: string,
    characterId: string,
    opts: { topN?: number } = {},
  ): Promise<AudiobookVoiceLibraryMatchesResult> {
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
            ttsVoiceAssetId: true,
            ttsSpeakerAliases: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }
    const target = novel.characters.find((c) => c.id === characterId);
    if (!target) {
      throw new AppError("角色不存在。", 404);
    }

    const plannerInput = toPlannerInput(target);
    const genderBucket = inferGenderBucket(plannerInput);
    const cluster = resolveVoiceCluster(plannerInput);
    const preferredSlot = inferVoiceSlot(plannerInput);

    // 本书其他角色已绑定 clone → assetId / speaker 预占：建 assetId→names、speaker→names 映射
    const assetOccupants = new Map<string, string[]>();
    const speakerOccupants = new Map<string, string[]>();
    const usedSpeakerKeys = new Set<string>();
    const libraryAssets = loadApprovedLibraryAssets();
    const assetById = new Map(libraryAssets.map((a) => [a.id, a]));
    for (const c of novel.characters) {
      if (c.id === characterId) continue;
      const id = c.ttsVoiceAssetId?.trim();
      if (!id || c.ttsMode?.trim() !== "clone") continue;
      const name = c.name?.trim() || c.id;
      assetOccupants.set(id, [...(assetOccupants.get(id) ?? []), name]);
      const bound = assetById.get(id);
      const sp = speakerKeyFromTags(bound?.tags, id);
      if (sp) {
        usedSpeakerKeys.add(sp);
        speakerOccupants.set(sp, [...(speakerOccupants.get(sp) ?? []), name]);
      }
    }

    // 自身已绑 asset 不进候选（usedAssetIds 排除）
    const usedAssetIds = new Set<string>();
    const selfAsset = target.ttsVoiceAssetId?.trim();
    if (selfAsset && target.ttsMode?.trim() === "clone") usedAssetIds.add(selfAsset);

    // 单次 collect 拿完整去重排序候选：既供 top-N slice，又供 excludedCount，避免二次打分。
    // want 归一化与 matchLibraryAssetsTopN 一致（默认 8 / 硬顶 32 / 非法回落默认）。
    const want = Number.isFinite(opts.topN) && (opts.topN as number) > 0
      ? Math.min(Math.floor(opts.topN as number), 32)
      : 8;
    const allRanked = collectLibraryAssetCandidates({
      genderBucket,
      cluster,
      assets: libraryAssets,
      usedAssetIds,
      usedSpeakerKeys,
      preferredSlot,
      /** 对靠链路：保留已被本书其他角色占用的 speaker 候选并标注，不静默隐藏 */
      includeOccupiedSpeakers: true,
    });
    const ranked = allRanked.slice(0, want);

    const candidates: AudiobookVoiceLibraryMatchItem[] = ranked.map((c) => {
      const byAsset = assetOccupants.get(c.asset.id) ?? [];
      const bySpeaker = c.speakerKey ? (speakerOccupants.get(c.speakerKey) ?? []) : [];
      const occupiedBy = Array.from(new Set([...byAsset, ...bySpeaker]));
      return {
        voiceAssetId: c.asset.id,
        slug: c.asset.slug,
        displayName: c.asset.displayName,
        score: c.score,
        reason: c.reason,
        dimensions: {
          gender: c.gender,
          cluster: c.cluster,
          scope: c.scope,
        },
        occupiedBy: occupiedBy.length ? occupiedBy : null,
        speakerOccupied: c.speakerOccupied,
      };
    });

    // excludedCount：库 approved 总数 - 全量通过门禁候选数（同 speaker 去重后）。
    // 观测「库很大但严门禁」；不阻断。
    const totalApproved = libraryAssets.length;
    const excludedCount = Math.max(0, totalApproved - allRanked.length);

    return {
      novelId,
      characterId,
      genderBucket,
      cluster,
      candidates,
      excludedCount,
    };
  }

  async suggest(novelId: string, input: AudiobookVoicePlanSuggestInput = {}): Promise<AudiobookVoicePlanSuggestResult> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        title: true,
        description: true,
        styleTone: true,
        bookSellingPoint: true,
        first30ChapterPromise: true,
        competingFeel: true,
        narrativePov: true,
        audiobookNarratorVoice: true,
        genre: { select: { name: true } },
        primaryStoryMode: { select: { name: true } },
        bible: {
          select: {
            coreSetting: true,
            worldRules: true,
            mainPromise: true,
            rawContent: true,
          },
        },
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
            ttsVoiceAssetId: true,
            ttsSpeakerAliases: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    const book: BookVoiceContext = {
      title: novel.title,
      description: novel.description,
      styleTone: novel.styleTone,
      bookSellingPoint: novel.bookSellingPoint,
      first30ChapterPromise: novel.first30ChapterPromise,
      competingFeel: novel.competingFeel,
      narrativePov: novel.narrativePov ? String(novel.narrativePov) : null,
      genreName: novel.genre?.name ?? null,
      storyModeName: novel.primaryStoryMode?.name ?? null,
      worldSummary: clipWorldSummaryFromBible(novel.bible),
    };
    const bookContextBlob = formatBookContext(book);

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
    const libraryAssets =
      strategy === "preset_only" || strategy === "prefer_design"
        ? []
        : loadApprovedLibraryAssets();

    const plannerChars = novel.characters.map(toPlannerInput);
    const wantBrief =
      strategy === "prefer_library"
      || strategy === "prefer_library_ai"
      || strategy === "auto"
      || process.env.VOICE_PLAN_BRIEF_LLM?.trim() === "1";
    const useLlmBrief =
      strategy === "prefer_library_ai"
      || process.env.VOICE_PLAN_BRIEF_LLM?.trim() === "1";

    const briefByCharacterId: Record<
      string,
      {
        cluster?: VoiceCluster;
        preferredSlot?: VoiceSlot;
        personaTags?: string[];
        avoidTags?: string[];
        oneLine?: string;
      }
    > = {};

    if (wantBrief) {
      const briefTargets = plannerChars.filter(
        (ch) => !input.characterIds?.length || input.characterIds.includes(ch.characterId),
      );
      // 规则 Brief 可全量；LLM Brief 仅 lead/cast 且有限并发
      const llmClusterOk = (cluster: string | undefined) =>
        cluster === "lead" || cluster === "cast";
      await mapWithConcurrency(briefTargets, 4, async (ch) => {
        try {
          // 先规则算 cluster，再决定是否 LLM（省成本：extra/narrator 不调 LLM）
          const ruleBrief = buildRuleVoiceBrief(ch, book);
          const allowLlm = useLlmBrief && llmClusterOk(ruleBrief.cluster);
          const brief: VoiceBrief = await buildVoiceBrief({
            character: ch,
            book,
            useLlm: allowLlm,
          });
          briefByCharacterId[ch.characterId] = {
            cluster: brief.cluster,
            preferredSlot: {
              pitchBand: brief.pitch,
              textureBand: brief.texture,
              energyBand: brief.energy,
            },
            personaTags: brief.personaTags,
            avoidTags: brief.avoidTags,
            oneLine: brief.oneLine,
          };
        } catch {
          /* rule path inside buildVoiceBrief already soft-fails */
        }
      });
    }

    const planned = planCharacterVoices({
      characters: plannerChars,
      strategy,
      onlyMissing: input.onlyMissing !== false,
      characterIds: input.characterIds,
      maxImportantPerPreset: input.maxImportantPerPreset,
      reservedPresets,
      libraryAssets,
      bookContextBlob,
      briefByCharacterId,
    });

    // prefer_library_ai：仅 lead/cast 走 LLM pick（校验 id∈候选）；extra/narrator 保持规则
    let items = planned.items;
    if (strategy === "prefer_library_ai" && libraryAssets.length && process.env.VOICE_PLAN_AI_PICK?.trim() !== "0") {
      const usedIds = new Set(
        items
          .filter((i) => i.ttsMode === "clone" && i.ttsVoiceAssetId)
          .map((i) => i.ttsVoiceAssetId!.trim()),
      );
      const usedSpeakers = new Set<string>();
      for (const id of usedIds) {
        const a = libraryAssets.find((x) => x.id === id);
        const sp = speakerKeyFromTags(a?.tags, id);
        if (sp) usedSpeakers.add(sp);
      }

      const isLeadOrCast = (characterId: string): boolean => {
        const ch = plannerChars.find((c) => c.characterId === characterId);
        if (!ch) return false;
        const cluster = briefByCharacterId[characterId]?.cluster || resolveVoiceCluster(ch);
        return cluster === "lead" || cluster === "cast";
      };

      // 无 clone 的 lead/cast：并发 AI pick
      const needPickIdx: number[] = [];
      items.forEach((item, idx) => {
        if (item.ttsMode === "clone" && item.ttsVoiceAssetId) return;
        if (!isLeadOrCast(item.characterId)) return;
        needPickIdx.push(idx);
      });

      // 阶段1：并发 LLM 挑候选（快照 used，不互斥写）
      // 阶段2：串行落盘，冲突 id/speaker 丢弃，避免并发抢同一资产
      const pickProposals = await mapWithConcurrency(needPickIdx, 3, async (idx) => {
        const item = items[idx]!;
        const briefMeta = briefByCharacterId[item.characterId];
        const ch = plannerChars.find((c) => c.characterId === item.characterId);
        if (!ch || !briefMeta) return { idx, item, pickedId: null as string | null, pickReason: "" };
        const candidates = collectLibraryAssetCandidates({
          genderBucket: inferGenderBucket(ch),
          cluster: (briefMeta.cluster || resolveVoiceCluster(ch)) as VoiceCluster,
          assets: libraryAssets,
          usedAssetIds: usedIds,
          usedSpeakerKeys: usedSpeakers,
          preferredSlot: briefMeta.preferredSlot,
          personaTags: briefMeta.personaTags,
          avoidTags: briefMeta.avoidTags,
        }).slice(0, 80);
        if (!candidates.length) return { idx, item, pickedId: null, pickReason: "" };
        const briefForPick: VoiceBrief = {
          gender: inferGenderBucket(ch),
          age: "unknown",
          cluster: (briefMeta.cluster || resolveVoiceCluster(ch)) as VoiceCluster,
          pitch: briefMeta.preferredSlot?.pitchBand || "mid",
          texture: briefMeta.preferredSlot?.textureBand || "neutral",
          energy: briefMeta.preferredSlot?.energyBand || "even",
          personaTags: briefMeta.personaTags || [],
          avoidTags: briefMeta.avoidTags || [],
          oneLine: briefMeta.oneLine || item.characterName,
          confidence: 0.5,
          source: "rule",
        };
        const pick = await pickLibraryAssetWithLlm({
          brief: briefForPick,
          candidates: candidates.map((c) => c.asset),
        });
        if (!pick.assetId) return { idx, item, pickedId: null, pickReason: "" };
        return { idx, item, pickedId: pick.assetId as string, pickReason: pick.reason || "" };
      });

      const nextItems = items.slice();
      for (const r of pickProposals) {
        if (!r.pickedId || usedIds.has(r.pickedId)) {
          nextItems[r.idx] = r.item;
          continue;
        }
        const sp = speakerKeyFromTags(
          libraryAssets.find((a) => a.id === r.pickedId)?.tags,
          r.pickedId,
        );
        if (sp && usedSpeakers.has(sp)) {
          nextItems[r.idx] = r.item;
          continue;
        }
        usedIds.add(r.pickedId);
        if (sp) usedSpeakers.add(sp);
        nextItems[r.idx] = {
          ...r.item,
          ttsMode: "clone" as const,
          ttsVoiceAssetId: r.pickedId,
          ttsDesignPrompt: null,
          ttsVoice: null,
          reason: `策略 prefer_library_ai：LLM 选库 ${r.pickedId}（${r.pickReason}）`,
        };
      }
      items = nextItems;

      // 可选：已有规则 clone 的 lead/cast 再 LLM 重排
      if (process.env.VOICE_PLAN_AI_PICK_RERANK?.trim() === "1") {
        const rerankIdx: number[] = [];
        items.forEach((item, idx) => {
          if (!(item.ttsMode === "clone" && item.ttsVoiceAssetId)) return;
          if (!isLeadOrCast(item.characterId)) return;
          rerankIdx.push(idx);
        });
        const rerankProposals = await mapWithConcurrency(rerankIdx, 3, async (idx) => {
          const item = items[idx]!;
          const briefMeta = briefByCharacterId[item.characterId];
          const ch = plannerChars.find((c) => c.characterId === item.characterId);
          if (!ch || !briefMeta) return { idx, item, oldId: null as string | null, pickedId: null as string | null, pickReason: "" };
          const candidates = collectLibraryAssetCandidates({
            genderBucket: inferGenderBucket(ch),
            cluster: (briefMeta.cluster || resolveVoiceCluster(ch)) as VoiceCluster,
            assets: libraryAssets,
            usedAssetIds: new Set([...usedIds].filter((id) => id !== item.ttsVoiceAssetId)),
            usedSpeakerKeys: usedSpeakers,
            preferredSlot: briefMeta.preferredSlot,
            personaTags: briefMeta.personaTags,
            avoidTags: briefMeta.avoidTags,
          }).slice(0, 80);
          if (candidates.length < 2) return { idx, item, oldId: null, pickedId: null, pickReason: "" };
          const briefForPick: VoiceBrief = {
            gender: inferGenderBucket(ch),
            age: "unknown",
            cluster: (briefMeta.cluster || resolveVoiceCluster(ch)) as VoiceCluster,
            pitch: briefMeta.preferredSlot?.pitchBand || "mid",
            texture: briefMeta.preferredSlot?.textureBand || "neutral",
            energy: briefMeta.preferredSlot?.energyBand || "even",
            personaTags: briefMeta.personaTags || [],
            avoidTags: briefMeta.avoidTags || [],
            oneLine: briefMeta.oneLine || item.characterName,
            confidence: 0.5,
            source: "rule",
          };
          const pick = await pickLibraryAssetWithLlm({
            brief: briefForPick,
            candidates: candidates.map((c) => c.asset),
          });
          if (pick.assetId && pick.assetId !== item.ttsVoiceAssetId) {
            return {
              idx,
              item,
              oldId: item.ttsVoiceAssetId!,
              pickedId: pick.assetId as string,
              pickReason: pick.reason || "",
            };
          }
          return { idx, item, oldId: null, pickedId: null, pickReason: "" };
        });
        const after = items.slice();
        for (const r of rerankProposals) {
          if (!r.pickedId || !r.oldId || usedIds.has(r.pickedId)) {
            after[r.idx] = r.item;
            continue;
          }
          const sp = speakerKeyFromTags(
            libraryAssets.find((a) => a.id === r.pickedId)?.tags,
            r.pickedId,
          );
          if (sp && usedSpeakers.has(sp)) {
            after[r.idx] = r.item;
            continue;
          }
          usedIds.delete(r.oldId);
          usedIds.add(r.pickedId);
          if (sp) usedSpeakers.add(sp);
          after[r.idx] = {
            ...r.item,
            ttsVoiceAssetId: r.pickedId,
            reason: `策略 prefer_library_ai：LLM 重排 ${r.pickedId}（${r.pickReason}；原 ${r.oldId}）`,
          };
        }
        items = after;
      }
    }

    return {
      novelId,
      strategy,
      items,
      skipped: planned.skipped,
      summary: summarizePlan(items, planned.skipped),
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
            ttsVoiceAssetId: true,
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
        const assetId = item.ttsVoiceAssetId?.trim() || "";
        if (!assetId) {
          skipped.push({
            characterId: character.id,
            characterName: character.name,
            reason: "clone 需要 ttsVoiceAssetId（禁止客户端写参考路径）。",
          });
          continue;
        }

        // 已有 clone 绑库且未 overwrite：永不覆盖；overwrite=true 时换绑仍走 assertBindable
        const alreadyClone =
          (character.ttsMode?.trim() || "") === "clone"
          && Boolean(
            character.ttsRefAudioPath?.trim() || character.ttsVoiceAssetId?.trim(),
          );
        if (alreadyClone && !overwrite) {
          skipped.push({
            characterId: character.id,
            characterName: character.name,
            reason: "已配置 clone，apply 不覆盖（overwrite=false）。",
          });
          continue;
        }
        if (
          !alreadyClone
          && isCharacterVoiceConfigured(character)
          && !overwrite
        ) {
          skipped.push({
            characterId: character.id,
            characterName: character.name,
            reason: "已绑定音色且 overwrite=false。",
          });
          continue;
        }

        try {
          const bound = await voiceLibraryService.bindCharacter(novelId, character.id, {
            voiceAssetId: assetId,
          });
          if (item.speakerAliases) {
            const aliases = parseSpeakerAliases(item.speakerAliases);
            if (aliases && aliases.length > 0) {
              await prisma.character.update({
                where: { id: character.id },
                data: { ttsSpeakerAliases: JSON.stringify(aliases) },
              });
            }
          }
          applied.push({
            characterId: character.id,
            characterName: character.name,
            ttsMode: "clone",
            ttsVoiceAssetId: bound.voiceAssetId,
          });
        } catch (error) {
          skipped.push({
            characterId: character.id,
            characterName: character.name,
            reason:
              error instanceof Error
                ? error.message
                : "绑库失败。",
          });
        }
        continue;
      }

      const currentMode = character.ttsMode?.trim() || "preset";
      if (
        currentMode === "clone"
        && (character.ttsRefAudioPath?.trim() || character.ttsVoiceAssetId?.trim())
      ) {
        skipped.push({
          characterId: character.id,
          characterName: character.name,
          reason: "已配置 clone，apply 不覆盖为 preset/design。",
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
        // 切到 preset/design 时清掉 clone 参考路径与库绑定，避免预检/合成仍走旧 clone
        ttsRefAudioPath: null,
        ttsVoiceAssetId: null,
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
        ttsVoiceAssetId: null,
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
        ttsVoiceAssetId: true,
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
    const lockKey = acquirePreviewGenerateLock(novelId, characterId);
    try {
      return await this.runGenerateCharacterPreview(novelId, characterId, input);
    } finally {
      releasePreviewGenerateLock(lockKey);
    }
  }

  private async runGenerateCharacterPreview(
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
        ttsVoiceAssetId: true,
      },
    });
    if (!character) {
      throw new AppError("角色不存在。", 404);
    }

    const effectiveRef =
      tryResolveEffectiveCloneRefPath({
        ttsVoiceAssetId: character.ttsVoiceAssetId,
        ttsRefAudioPath: character.ttsRefAudioPath,
        requireApproved: true,
      }) || character.ttsRefAudioPath;
    const previewConfig = {
      ...character,
      ttsRefAudioPath: effectiveRef,
    };

    let ready: ReturnType<typeof assertCharacterVoiceReadyForPreview>;
    try {
      ready = assertCharacterVoiceReadyForPreview(previewConfig);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "音色配置不完整，无法生成试听。", 400);
    }

    const sampleText = clampCharacterVoicePreviewSampleText(
      input.text?.trim()
        || resolveDefaultCharacterVoicePreviewText({ gender: character.gender }),
    );
    const fingerprint = buildCharacterVoicePreviewFingerprint(previewConfig, sampleText);
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
      writeCandidatesMetaAtomic(novelId, characterId, {
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
        adoptedCandidateId: autoAdopt ? suggestedCandidateId : null,
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
   * 候选 meta 指纹必须与当前角色配置一致，避免配置变更后误 adopt 旧抽签。
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
        ttsVoiceAssetId: true,
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

    const sampleText = clampCharacterVoicePreviewSampleText(meta.sampleText || DEFAULT_PREVIEW_TEXT);
    const fingerprint = buildCharacterVoicePreviewFingerprint(character, sampleText);
    if (meta.fingerprint && meta.fingerprint !== fingerprint) {
      throw new AppError("候选已过期（音色配置已变更），请重新多抽后再采用。", 409);
    }

    let previewPath: string;
    try {
      previewPath = promoteCandidateToPreview(row.path, novelId, characterId);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "采用候选失败。", 500);
    }

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

    writeCandidatesMetaAtomic(novelId, characterId, {
      ...meta,
      sampleText,
      fingerprint,
      adoptedCandidateId: candidateId,
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


  /**
   * Design→Clone：把选优后的正式 preview 拷为 ref.wav，ttsMode=clone。
   * 必须 ready（与当前配置指纹一致）；禁止用 stale/旧 formal 冒充选优结果。
   * 可选 candidateId：先 adopt 再升格。对照 regenerate 失败不回滚主绑定。
   */
  async adoptPreviewAsClone(
    novelId: string,
    characterId: string,
    input: CharacterVoiceAdoptPreviewAsCloneInput = {},
  ): Promise<CharacterVoiceAdoptPreviewAsCloneResult> {
    const candidateId = input.candidateId?.trim() || "";
    if (candidateId) {
      await this.adoptPreviewCandidate(novelId, characterId, { candidateId });
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
        ttsVoiceAssetId: true,
        ttsPreviewAudioPath: true,
        ttsPreviewSampleText: true,
        ttsPreviewFingerprint: true,
        ttsPreviewGeneratedAt: true,
      },
    });
    if (!character) {
      throw new AppError("角色不存在。", 404);
    }

    const previewPath =
      character.ttsPreviewAudioPath?.trim()
      || resolveCharacterVoicePreviewPath(novelId, characterId);
    if (!isValidPcmWavFile(previewPath)) {
      throw new AppError(
        "升格 clone 需要已选优的正式试听（preview ready）。请先多抽并采用候选。",
        400,
      );
    }

    const sampleForFp =
      character.ttsPreviewSampleText?.trim()
      || resolveDefaultCharacterVoicePreviewText({ gender: character.gender });
    const currentFingerprint = buildCharacterVoicePreviewFingerprint(character, sampleForFp);
    const previewStatus = resolveCharacterVoicePreviewStatus({
      audioPath: previewPath,
      fingerprint: character.ttsPreviewFingerprint,
      currentFingerprint,
    });
    if (previewStatus !== "ready") {
      throw new AppError(
        previewStatus === "stale"
          ? "升格 clone 需要与当前配置一致的 ready 试听（当前为过期试听）。请重新生成并采用候选后再锁定。"
          : "升格 clone 需要合法 PCM WAV 试听文件。",
        400,
      );
    }

    // 服务端强制：多抽未采用时禁止锁旧 formal（不依赖 UI pending 状态）
    assertMultiDrawAdoptedForCloneLock(readCandidatesMeta(novelId, characterId), currentFingerprint);

    let refPath: string;
    try {
      refPath = copyCharacterVoicePreviewToRef({
        novelId,
        characterId,
        previewPath,
      });
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : "拷贝 preview 为 clone 参考失败。",
        500,
      );
    }

    const refCheck = checkVoiceRefAudioPath(refPath);
    if (!refCheck.ok) {
      throw new AppError(refCheck.reason || "clone 参考路径校验失败。", 500);
    }

    const retainedDesignPrompt = character.ttsDesignPrompt?.trim() || null;
    await prisma.character.update({
      where: { id: characterId },
      data: {
        ttsMode: "clone",
        ttsRefAudioPath: refPath,
        // 本地 clone ≠ 库资产
        ttsVoiceAssetId: null,
        // 保留 design 文案审计；preset voice 可清
        ttsVoice: null,
      },
    });

    // mode 变更 → fingerprint 变 → 旧 preview 记为 stale；资产仍可播
    const after = await this.getCharacterPreview(novelId, characterId);

    let contrastPreview: CharacterVoicePreviewAsset | null = null;
    if (input.regeneratePreviewUnderClone === true) {
      try {
        const gen = await this.generateCharacterPreview(novelId, characterId, {
          text: input.contrastText,
          candidates: 1,
          autoAdoptWinner: true,
        });
        contrastPreview = gen.adopted;
      } catch {
        // 主绑定已成功；对照合成失败不回滚 clone，由客户端提示再生成
        contrastPreview = null;
      }
    }

    return {
      characterId: character.id,
      characterName: character.name,
      ttsMode: "clone",
      ttsRefAudioPath: refPath,
      sourcePreviewPath: previewPath,
      retainedDesignPrompt,
      preview: after,
      contrastPreview,
    };
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


function clipWorldSummaryFromBible(
  bible?: {
    coreSetting?: string | null;
    worldRules?: string | null;
    mainPromise?: string | null;
    rawContent?: string | null;
  } | null,
): string | null {
  if (!bible) return null;
  const parts = [bible.coreSetting, bible.worldRules, bible.mainPromise, bible.rawContent]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const joined = parts.join("；");
  return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  async function runOne(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => runOne()));
  return results;
}
