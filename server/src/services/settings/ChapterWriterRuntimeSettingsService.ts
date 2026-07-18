import { prisma } from "../../db/prisma";
import { isMissingTableError } from "./ragLegacyCompatibility";

/**
 * 章节写作运行时设置（AppSetting 持久化，可热调）。
 *
 * 收口来源（review-fix backlog #2）：将原先散落的硬编码 / env 调优项统一迁入
 * AppSetting 四步范式，脱离「改常量要重启」「retry 走 env 违反配置约定」的旧状态：
 * - openingDiversity 章首多样性：recentWindow / similarityThreshold / openingChars
 *   （原为 openingDiversity.ts 内 DEFAULT_* 常量）。
 * - transportRetryMaxAttempts：writer 传输层瞬时失败整章重试上限
 *   （原为 chapterRuntimePipeline.ts 直读 process.env.CHAPTER_WRITER_TRANSPORT_RETRY_MAX_ATTEMPTS）。
 *
 * 默认值刻意等于迁移前的出厂值，保证不改变现行生文行为；env 仅作为“无 AppSetting 记录时”
 * 的 transport retry 起步兜底（向后兼容旧部署），一旦写入 AppSetting 即以库为准。
 */

export const CHAPTER_WRITER_OPENING_DIVERSITY_RECENT_WINDOW_KEY = "chapterWriter.openingDiversityRecentWindow";
export const CHAPTER_WRITER_OPENING_DIVERSITY_SIMILARITY_THRESHOLD_KEY = "chapterWriter.openingDiversitySimilarityThreshold";
export const CHAPTER_WRITER_OPENING_DIVERSITY_OPENING_CHARS_KEY = "chapterWriter.openingDiversityOpeningChars";
export const CHAPTER_WRITER_TRANSPORT_RETRY_MAX_ATTEMPTS_KEY = "chapterWriter.transportRetryMaxAttempts";

export const CHAPTER_WRITER_RUNTIME_SETTING_KEYS = [
  CHAPTER_WRITER_OPENING_DIVERSITY_RECENT_WINDOW_KEY,
  CHAPTER_WRITER_OPENING_DIVERSITY_SIMILARITY_THRESHOLD_KEY,
  CHAPTER_WRITER_OPENING_DIVERSITY_OPENING_CHARS_KEY,
  CHAPTER_WRITER_TRANSPORT_RETRY_MAX_ATTEMPTS_KEY,
] as const;

// 出厂默认：等于迁移前硬编码值，确保迁移不改变现行生文行为。
export const DEFAULT_OPENING_DIVERSITY_RECENT_WINDOW = 5;
export const MIN_OPENING_DIVERSITY_RECENT_WINDOW = 1;
export const MAX_OPENING_DIVERSITY_RECENT_WINDOW = 20;

export const DEFAULT_OPENING_DIVERSITY_SIMILARITY_THRESHOLD = 0.3;
export const MIN_OPENING_DIVERSITY_SIMILARITY_THRESHOLD = 0.05;
export const MAX_OPENING_DIVERSITY_SIMILARITY_THRESHOLD = 1;

export const DEFAULT_OPENING_DIVERSITY_OPENING_CHARS = 300;
export const MIN_OPENING_DIVERSITY_OPENING_CHARS = 64;
export const MAX_OPENING_DIVERSITY_OPENING_CHARS = 2000;

export const DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS = 2;
export const MIN_TRANSPORT_RETRY_MAX_ATTEMPTS = 0;
export const MAX_TRANSPORT_RETRY_MAX_ATTEMPTS = 5;

export interface ChapterWriterRuntimeSettings {
  openingDiversityRecentWindow: number;
  openingDiversitySimilarityThreshold: number;
  openingDiversityOpeningChars: number;
  transportRetryMaxAttempts: number;
}

export interface ChapterWriterRuntimeSettingsInput {
  openingDiversityRecentWindow: number;
  openingDiversitySimilarityThreshold: number;
  openingDiversityOpeningChars: number;
  transportRetryMaxAttempts: number;
}

function clampInt(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampFloat(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

/**
 * transport retry 的出厂默认：无 AppSetting 记录时，向后兼容旧部署仍读 env 起步，
 * env 缺失 / 非法则退回 2。写入 AppSetting 后以库值为准，不再看 env。
 */
function getDefaultTransportRetryMaxAttempts(): number {
  return clampInt(
    Number.parseInt(process.env.CHAPTER_WRITER_TRANSPORT_RETRY_MAX_ATTEMPTS ?? "", 10),
    DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS,
    MIN_TRANSPORT_RETRY_MAX_ATTEMPTS,
    MAX_TRANSPORT_RETRY_MAX_ATTEMPTS,
  );
}

function buildSettings(raw: {
  openingDiversityRecentWindow: number;
  openingDiversitySimilarityThreshold: number;
  openingDiversityOpeningChars: number;
  transportRetryMaxAttempts: number;
}): ChapterWriterRuntimeSettings {
  return {
    openingDiversityRecentWindow: clampInt(
      raw.openingDiversityRecentWindow,
      DEFAULT_OPENING_DIVERSITY_RECENT_WINDOW,
      MIN_OPENING_DIVERSITY_RECENT_WINDOW,
      MAX_OPENING_DIVERSITY_RECENT_WINDOW,
    ),
    openingDiversitySimilarityThreshold: clampFloat(
      raw.openingDiversitySimilarityThreshold,
      DEFAULT_OPENING_DIVERSITY_SIMILARITY_THRESHOLD,
      MIN_OPENING_DIVERSITY_SIMILARITY_THRESHOLD,
      MAX_OPENING_DIVERSITY_SIMILARITY_THRESHOLD,
    ),
    openingDiversityOpeningChars: clampInt(
      raw.openingDiversityOpeningChars,
      DEFAULT_OPENING_DIVERSITY_OPENING_CHARS,
      MIN_OPENING_DIVERSITY_OPENING_CHARS,
      MAX_OPENING_DIVERSITY_OPENING_CHARS,
    ),
    transportRetryMaxAttempts: clampInt(
      raw.transportRetryMaxAttempts,
      DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS,
      MIN_TRANSPORT_RETRY_MAX_ATTEMPTS,
      MAX_TRANSPORT_RETRY_MAX_ATTEMPTS,
    ),
  };
}

function getDefaultSettings(): ChapterWriterRuntimeSettings {
  return buildSettings({
    openingDiversityRecentWindow: DEFAULT_OPENING_DIVERSITY_RECENT_WINDOW,
    openingDiversitySimilarityThreshold: DEFAULT_OPENING_DIVERSITY_SIMILARITY_THRESHOLD,
    openingDiversityOpeningChars: DEFAULT_OPENING_DIVERSITY_OPENING_CHARS,
    transportRetryMaxAttempts: getDefaultTransportRetryMaxAttempts(),
  });
}

function toNumber(rawValue: string | undefined, fallback: number): number {
  if (rawValue === undefined) {
    return fallback;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function getChapterWriterRuntimeSettings(): Promise<ChapterWriterRuntimeSettings> {
  const defaults = getDefaultSettings();
  try {
    const records = await prisma.appSetting.findMany({
      where: { key: { in: [...CHAPTER_WRITER_RUNTIME_SETTING_KEYS] } },
    });
    const valueMap = new Map(records.map((row) => [row.key, row.value]));
    return buildSettings({
      openingDiversityRecentWindow: toNumber(
        valueMap.get(CHAPTER_WRITER_OPENING_DIVERSITY_RECENT_WINDOW_KEY),
        defaults.openingDiversityRecentWindow,
      ),
      openingDiversitySimilarityThreshold: toNumber(
        valueMap.get(CHAPTER_WRITER_OPENING_DIVERSITY_SIMILARITY_THRESHOLD_KEY),
        defaults.openingDiversitySimilarityThreshold,
      ),
      openingDiversityOpeningChars: toNumber(
        valueMap.get(CHAPTER_WRITER_OPENING_DIVERSITY_OPENING_CHARS_KEY),
        defaults.openingDiversityOpeningChars,
      ),
      transportRetryMaxAttempts: toNumber(
        valueMap.get(CHAPTER_WRITER_TRANSPORT_RETRY_MAX_ATTEMPTS_KEY),
        defaults.transportRetryMaxAttempts,
      ),
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return defaults;
    }
    throw error;
  }
}

export async function saveChapterWriterRuntimeSettings(
  input: ChapterWriterRuntimeSettingsInput,
): Promise<ChapterWriterRuntimeSettings> {
  const previous = await getChapterWriterRuntimeSettings();
  const settings = buildSettings({
    openingDiversityRecentWindow: Number.isFinite(input.openingDiversityRecentWindow)
      ? input.openingDiversityRecentWindow
      : previous.openingDiversityRecentWindow,
    openingDiversitySimilarityThreshold: Number.isFinite(input.openingDiversitySimilarityThreshold)
      ? input.openingDiversitySimilarityThreshold
      : previous.openingDiversitySimilarityThreshold,
    openingDiversityOpeningChars: Number.isFinite(input.openingDiversityOpeningChars)
      ? input.openingDiversityOpeningChars
      : previous.openingDiversityOpeningChars,
    transportRetryMaxAttempts: Number.isFinite(input.transportRetryMaxAttempts)
      ? input.transportRetryMaxAttempts
      : previous.transportRetryMaxAttempts,
  });

  try {
    await prisma.$transaction([
      prisma.appSetting.upsert({
        where: { key: CHAPTER_WRITER_OPENING_DIVERSITY_RECENT_WINDOW_KEY },
        update: { value: String(settings.openingDiversityRecentWindow) },
        create: {
          key: CHAPTER_WRITER_OPENING_DIVERSITY_RECENT_WINDOW_KEY,
          value: String(settings.openingDiversityRecentWindow),
        },
      }),
      prisma.appSetting.upsert({
        where: { key: CHAPTER_WRITER_OPENING_DIVERSITY_SIMILARITY_THRESHOLD_KEY },
        update: { value: String(settings.openingDiversitySimilarityThreshold) },
        create: {
          key: CHAPTER_WRITER_OPENING_DIVERSITY_SIMILARITY_THRESHOLD_KEY,
          value: String(settings.openingDiversitySimilarityThreshold),
        },
      }),
      prisma.appSetting.upsert({
        where: { key: CHAPTER_WRITER_OPENING_DIVERSITY_OPENING_CHARS_KEY },
        update: { value: String(settings.openingDiversityOpeningChars) },
        create: {
          key: CHAPTER_WRITER_OPENING_DIVERSITY_OPENING_CHARS_KEY,
          value: String(settings.openingDiversityOpeningChars),
        },
      }),
      prisma.appSetting.upsert({
        where: { key: CHAPTER_WRITER_TRANSPORT_RETRY_MAX_ATTEMPTS_KEY },
        update: { value: String(settings.transportRetryMaxAttempts) },
        create: {
          key: CHAPTER_WRITER_TRANSPORT_RETRY_MAX_ATTEMPTS_KEY,
          value: String(settings.transportRetryMaxAttempts),
        },
      }),
    ]);
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }

  return settings;
}
