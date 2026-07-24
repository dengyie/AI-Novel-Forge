/**
 * Volume Readiness 预算与调度配置。
 * 默认调度关闭；仅 VOLUME_READINESS_SCHEDULE=1 时在后台注册 dry-run 巡检。
 */

function asInt(rawValue: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(rawValue ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const value = Math.floor(parsed);
  return Math.max(min, Math.min(max, value));
}

function asBool(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue == null || rawValue.trim() === "") {
    return fallback;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export const VOLUME_READINESS_DEFAULT_MAX_CHAPTERS = asInt(
  process.env.VOLUME_READINESS_MAX_CHAPTERS,
  20,
  1,
  500,
);
export const VOLUME_READINESS_DEFAULT_MAX_HEAVY = asInt(
  process.env.VOLUME_READINESS_MAX_HEAVY,
  3,
  0,
  100,
);
export const VOLUME_READINESS_DEFAULT_MAX_LLM_CALLS = asInt(
  process.env.VOLUME_READINESS_MAX_LLM_CALLS,
  60,
  1,
  2000,
);
export const VOLUME_READINESS_DEFAULT_MAX_WALL_MINUTES = asInt(
  process.env.VOLUME_READINESS_MAX_WALL_MINUTES,
  45,
  1,
  24 * 60,
);

/** 后台巡检间隔（ms）；默认 12h。 */
export const VOLUME_READINESS_SCHEDULE_INTERVAL_MS = asInt(
  process.env.VOLUME_READINESS_SCHEDULE_INTERVAL_MS,
  12 * 60 * 60 * 1000,
  60_000,
  7 * 24 * 60 * 60 * 1000,
);

/** 默认关：仅 ops 显式打开才注册 scheduler。 */
export const VOLUME_READINESS_SCHEDULE_ENABLED = asBool(process.env.VOLUME_READINESS_SCHEDULE, false);

/** assess 时信号过期阈值（小时）；缺 qualityLoop 或超龄则 evaluateOnly 补算。 */
export const VOLUME_READINESS_SIGNAL_STALE_HOURS = asInt(
  process.env.VOLUME_READINESS_SIGNAL_STALE_HOURS,
  72,
  1,
  24 * 30,
);

/**
 * 同章 incomplete（re_review/repair/polish）最多自动重试次数；
 * 超过后 escalate 为 kept（manual），避免 resume 空转烧预算。
 */
export const VOLUME_READINESS_MAX_INCOMPLETE_RETRIES = asInt(
  process.env.VOLUME_READINESS_MAX_INCOMPLETE_RETRIES,
  2,
  1,
  10,
);

export interface VolumeReadinessBudgetDefaults {
  maxChapters: number;
  maxHeavyRewrites: number;
  maxLlmCalls: number;
  maxWallMinutes: number;
}

export interface VolumeReadinessConfig {
  budget: VolumeReadinessBudgetDefaults;
  scheduleEnabled: boolean;
  scheduleIntervalMs: number;
  signalStaleHours: number;
  maxIncompleteRetries: number;
}

export const volumeReadinessConfig: VolumeReadinessConfig = {
  budget: {
    maxChapters: VOLUME_READINESS_DEFAULT_MAX_CHAPTERS,
    maxHeavyRewrites: VOLUME_READINESS_DEFAULT_MAX_HEAVY,
    maxLlmCalls: VOLUME_READINESS_DEFAULT_MAX_LLM_CALLS,
    maxWallMinutes: VOLUME_READINESS_DEFAULT_MAX_WALL_MINUTES,
  },
  scheduleEnabled: VOLUME_READINESS_SCHEDULE_ENABLED,
  scheduleIntervalMs: VOLUME_READINESS_SCHEDULE_INTERVAL_MS,
  signalStaleHours: VOLUME_READINESS_SIGNAL_STALE_HOURS,
  maxIncompleteRetries: VOLUME_READINESS_MAX_INCOMPLETE_RETRIES,
};
