import { z } from "zod";
import { sanitizeCreativeMustAdvanceItems } from "./chapterCreativeContract.js";

export const SCENE_COUNT_MIN = 3;
export const SCENE_COUNT_MAX = 8;

export const lengthBudgetContractSchema = z.object({
  targetWordCount: z.number().int().positive(),
  softMinWordCount: z.number().int().positive(),
  softMaxWordCount: z.number().int().positive(),
  hardMaxWordCount: z.number().int().positive(),
});

export const chapterSceneCardSchema = z.object({
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
  mustAdvance: z.array(z.string().trim().min(1)).default([]),
  mustPreserve: z.array(z.string().trim().min(1)).default([]),
  entryState: z.string().trim().min(1),
  exitState: z.string().trim().min(1),
  forbiddenExpansion: z.array(z.string().trim().min(1)).default([]),
  targetWordCount: z.number().int().positive(),
});

export const chapterScenePlanSchema = z.object({
  targetWordCount: z.number().int().positive(),
  lengthBudget: lengthBudgetContractSchema,
  scenes: z.array(chapterSceneCardSchema).min(SCENE_COUNT_MIN).max(SCENE_COUNT_MAX),
});

export type LengthBudgetContract = z.infer<typeof lengthBudgetContractSchema>;
export type ChapterSceneCard = z.infer<typeof chapterSceneCardSchema>;
export type ChapterScenePlan = z.infer<typeof chapterScenePlanSchema>;

type LooseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.round(value));
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter((item): item is string => Boolean(item));
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,，;；、|]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return null;
}

function readAlias(record: LooseRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function normalizeSceneCardInput(raw: unknown, index: number): ChapterSceneCard | null {
  if (!isRecord(raw)) {
    return null;
  }

  const targetWordCount = normalizeInteger(readAlias(raw, [
    "targetWordCount",
    "target_word_count",
    "targetWords",
    "wordCount",
    "budget",
    "字数",
  ]));
  const key = normalizeText(readAlias(raw, [
    "key",
    "sceneKey",
    "id",
  ])) ?? `scene_${index + 1}`;
  const title = normalizeText(readAlias(raw, [
    "title",
    "sceneTitle",
    "label",
    "name",
  ]));
  const purpose = normalizeText(readAlias(raw, [
    "purpose",
    "objective",
    "goal",
    "summary",
  ]));
  const entryState = normalizeText(readAlias(raw, [
    "entryState",
    "startState",
    "sceneEntry",
    "openingState",
  ]));
  const exitState = normalizeText(readAlias(raw, [
    "exitState",
    "endState",
    "sceneExit",
    "closingState",
  ]));

  if (!title || !purpose || !entryState || !exitState || !targetWordCount || targetWordCount <= 0) {
    return null;
  }

  return chapterSceneCardSchema.parse({
    key,
    title,
    purpose,
    mustAdvance: sanitizeCreativeMustAdvanceItems(normalizeStringArray(readAlias(raw, [
      "mustAdvance",
      "mustAdvanceItems",
      "advanceItems",
      "deliverables",
    ]))),
    mustPreserve: normalizeStringArray(readAlias(raw, [
      "mustPreserve",
      "mustPreserveItems",
      "preserveItems",
      "guardrails",
    ])),
    entryState,
    exitState,
    forbiddenExpansion: normalizeStringArray(readAlias(raw, [
      "forbiddenExpansion",
      "forbiddenExpansions",
      "mustAvoid",
      "forbidden",
    ])),
    targetWordCount,
  });
}

function rescaleSceneTargets(targetWordCount: number, scenes: ChapterSceneCard[]): ChapterSceneCard[] {
  const rawTotal = scenes.reduce((sum, scene) => sum + scene.targetWordCount, 0);
  if (rawTotal <= 0) {
    throw new Error("Scene target word count total must be positive.");
  }

  const scaled = scenes.map((scene) => ({
    ...scene,
    targetWordCount: Math.max(1, Math.floor((scene.targetWordCount * targetWordCount) / rawTotal)),
  }));
  let delta = targetWordCount - scaled.reduce((sum, scene) => sum + scene.targetWordCount, 0);
  const ordered = scaled
    .map((scene, index) => ({ scene, index }))
    .sort((left, right) => right.scene.targetWordCount - left.scene.targetWordCount || left.index - right.index);

  let cursor = 0;
  while (delta !== 0 && ordered.length > 0) {
    const target = ordered[cursor % ordered.length]?.scene;
    if (!target) {
      break;
    }
    if (delta < 0 && target.targetWordCount <= 1) {
      cursor += 1;
      continue;
    }
    target.targetWordCount += delta > 0 ? 1 : -1;
    delta += delta > 0 ? -1 : 1;
    cursor += 1;
  }

  return scaled.map((scene) => chapterSceneCardSchema.parse(scene));
}

export function resolveLengthBudgetContract(targetWordCount: number | null | undefined): LengthBudgetContract | null {
  if (!Number.isFinite(targetWordCount) || (targetWordCount ?? 0) <= 0) {
    return null;
  }
  const normalizedTarget = Math.round(targetWordCount as number);
  return {
    targetWordCount: normalizedTarget,
    softMinWordCount: Math.floor(normalizedTarget * 0.85),
    softMaxWordCount: Math.ceil(normalizedTarget * 1.15),
    hardMaxWordCount: Math.ceil(normalizedTarget * 1.25),
  };
}

/** 相对 base 目标字数的章型倍率（情感偏短、战斗偏满、过渡更短）。 */
export const CHAPTER_TYPE_LENGTH_MULTIPLIERS = {
  emotion: 0.9,
  combat: 1.05,
  explore: 1.0,
  transition: 0.8,
} as const;

export type ChapterLengthTypeKey = keyof typeof CHAPTER_TYPE_LENGTH_MULTIPLIERS;

/**
 * 按章型解析目标字数。
 * - base 通常来自 novel.defaultChapterLength（其次章上历史 target / 规划默认）
 * - 无显式 target：base × 分型倍率
 * - 有显式 target 且已知章型：夹逼到 typeTarget × [0.9, 1.1]，避免 LLM 目标完全绕过分型
 * - 无章型时保留显式 target
 */
export function resolveChapterTypeTargetWordCount(input: {
  baseWordCount: number | null | undefined;
  chapterType?: ChapterLengthTypeKey | string | null;
  explicitTargetWordCount?: number | null;
  /** 默认 true：有章型时把显式 target 夹进分型带 */
  clampExplicitToTypeBand?: boolean;
}): number | null {
  const clampExplicit = input.clampExplicitToTypeBand !== false;
  const base = Number.isFinite(input.baseWordCount) && (input.baseWordCount ?? 0) > 0
    ? Math.round(input.baseWordCount as number)
    : null;
  const key = input.chapterType && input.chapterType in CHAPTER_TYPE_LENGTH_MULTIPLIERS
    ? (input.chapterType as ChapterLengthTypeKey)
    : null;
  const typeTarget = base != null
    ? (key ? Math.max(200, Math.round(base * CHAPTER_TYPE_LENGTH_MULTIPLIERS[key])) : base)
    : null;
  const explicit = Number.isFinite(input.explicitTargetWordCount)
    && (input.explicitTargetWordCount ?? 0) > 0
    ? Math.round(input.explicitTargetWordCount as number)
    : null;

  if (explicit != null) {
    if (clampExplicit && typeTarget != null && key) {
      const softMin = Math.max(200, Math.floor(typeTarget * 0.9));
      const softMax = Math.ceil(typeTarget * 1.1);
      if (explicit < softMin) {
        return softMin;
      }
      if (explicit > softMax) {
        return softMax;
      }
    }
    return explicit;
  }
  return typeTarget;
}

/**
 * Hard under-length ratio: actual < target × this value is not silently approvable
 * (must enter repair / quality checkpoint; not skippable auto_continue).
 */
export const LENGTH_HARD_UNDER_RATIO = 0.6;

export type LengthBudgetBand =
  | "within_soft"
  | "under_soft"
  | "under_hard"
  | "over_soft"
  | "over_hard";

export interface LengthBudgetEvaluation {
  budget: LengthBudgetContract;
  actualWordCount: number;
  band: LengthBudgetBand;
  /**
   * 可观测标签。
   * - under_soft / over_soft / over_hard：默认不 hard-block 写流
   * - under_hard：字数 < target×0.6，验收层应抬升 repair / 质量门，禁止静默 approved
   */
  riskTags: string[];
  varianceRatio: number;
  /** floor(target × LENGTH_HARD_UNDER_RATIO)；无 target 时不出现在评估里 */
  hardMinWordCount: number;
}

export function countContentCharacters(content: string): number {
  return content.replace(/\s+/g, "").trim().length;
}

export function resolveHardMinWordCount(targetWordCount: number): number {
  return Math.max(1, Math.floor(targetWordCount * LENGTH_HARD_UNDER_RATIO));
}

/**
 * 双界评估：
 * - softMin–softMax 为提示带
 * - hardMin（target×0.6）以下为 under_hard（验收 hard gate）
 * - hardMax 为软上限（可观测 over_hard，默认不阻断写流）
 */
export function evaluateLengthBudget(input: {
  content: string;
  targetWordCount: number | null | undefined;
}): LengthBudgetEvaluation | null {
  const budget = resolveLengthBudgetContract(input.targetWordCount);
  if (!budget) {
    return null;
  }
  const actualWordCount = countContentCharacters(input.content);
  const hardMinWordCount = resolveHardMinWordCount(budget.targetWordCount);
  const varianceRatio = budget.targetWordCount > 0
    ? (actualWordCount - budget.targetWordCount) / budget.targetWordCount
    : 0;
  let band: LengthBudgetBand = "within_soft";
  const riskTags: string[] = [];
  if (actualWordCount < hardMinWordCount) {
    band = "under_hard";
    riskTags.push("length_under_hard");
    // Keep soft tag too so existing under-length detectors still match.
    riskTags.push("length_under_soft");
  } else if (actualWordCount < budget.softMinWordCount) {
    band = "under_soft";
    riskTags.push("length_under_soft");
  } else if (actualWordCount > budget.hardMaxWordCount) {
    band = "over_hard";
    riskTags.push("length_over_hard");
  } else if (actualWordCount > budget.softMaxWordCount) {
    band = "over_soft";
    riskTags.push("length_over_soft");
  }
  return {
    budget,
    actualWordCount,
    band,
    riskTags,
    varianceRatio,
    hardMinWordCount,
  };
}

export function normalizeChapterScenePlan(
  raw: unknown,
  targetWordCount: number | null | undefined,
): ChapterScenePlan {
  const budget = resolveLengthBudgetContract(targetWordCount);
  if (!budget) {
    throw new Error("Target word count is required to normalize chapter scene plan.");
  }

  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw) as unknown; } catch { return raw; } })() : raw;
  const record = isRecord(parsed) ? parsed : null;
  const scenesRaw = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record?.scenes)
      ? record.scenes
      : Array.isArray(record?.sceneCards)
        ? record.sceneCards
        : Array.isArray(record?.scenePlan)
          ? record.scenePlan
          : [];
  const normalizedScenes = scenesRaw
    .map((scene, index) => normalizeSceneCardInput(scene, index))
    .filter((scene): scene is ChapterSceneCard => Boolean(scene));

  if (normalizedScenes.length < SCENE_COUNT_MIN) {
    throw new Error("Scene count below minimum.");
  }

  const boundedScenes = normalizedScenes.slice(0, SCENE_COUNT_MAX);
  return chapterScenePlanSchema.parse({
    targetWordCount: budget.targetWordCount,
    lengthBudget: budget,
    scenes: rescaleSceneTargets(budget.targetWordCount, boundedScenes),
  });
}

export function parseChapterScenePlan(
  raw: unknown,
  options: { targetWordCount?: number | null } = {},
): ChapterScenePlan | null {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
    if (options.targetWordCount != null) {
      return normalizeChapterScenePlan(parsed, options.targetWordCount);
    }
    return chapterScenePlanSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function isCanonicalChapterScenePlan(
  raw: unknown,
  options: { targetWordCount?: number | null } = {},
): boolean {
  return Boolean(parseChapterScenePlan(raw, options));
}

export function serializeChapterScenePlan(plan: ChapterScenePlan): string {
  return JSON.stringify(chapterScenePlanSchema.parse(plan));
}
