/**
 * Volume Readiness 预算与调度配置。
 * 默认调度关闭；仅 VOLUME_READINESS_SCHEDULE=1 时在后台注册 dry-run 巡检。
 */

/**
 * Parse env int with clamp. Empty / whitespace / undefined → fallback.
 * Critical: `Number("") === 0` is finite, so treating missing env as ""
 * used to clamp every default to `min` (e.g. perChapterTimeoutMs=60s,
 * maxChapters=1, maxWallMinutes=1) and burn readiness runs in 60s steps.
 */
function asInt(rawValue: string | undefined, fallback: number, min: number, max: number): number {
  if (rawValue == null || rawValue.trim() === "") {
    return fallback;
  }
  const parsed = Number(rawValue);
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
/**
 * 默认 wall：v2 单卷 20 章 ×（re_review + 可能 heavy）常超 45m。
 * 180m 与生产真跑常用预算对齐；仍可用 env / request.budget 覆盖。
 * 单章 thrash 不得靠无限 wall 掩盖——post-adopt 已 fail-soft artifact。
 */
export const VOLUME_READINESS_DEFAULT_MAX_WALL_MINUTES = asInt(
  process.env.VOLUME_READINESS_MAX_WALL_MINUTES,
  180,
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
 * 默认 3：heavy adopt 后 quality 仍 needs_heavy 很常见，需至少 2 次同章 follow-up
 * 才 escalate；生产曾用 1 导致 adopt 一次即 kept。
 */
export const VOLUME_READINESS_MAX_INCOMPLETE_RETRIES = asInt(
  process.env.VOLUME_READINESS_MAX_INCOMPLETE_RETRIES,
  3,
  1,
  10,
);

/**
 * 单章单步 review / repair / polish 的墙钟硬超时（ms）。
 * 防 provider silent-hang / transport 半开连接导致单章 await 永不返回，
 * 把整卷 wall 烧干并永久卡住 executor（"卡住不动"次主因）。到点 abort 并 race
 * 兜底抛错，outcome=failed/incomplete 可 resume 重试，不污染 chapter 日志。
 *
 * 默认 45 分钟（曾 15m）：heavy 路径真实墙钟 ≈
 *   resolveIssues(critical_review 可达 600s + fallback 600s)
 *   + rewrite stream
 *   + baseline/candidate evaluateOnly（各可达 600s）
 * 15m 在 grok-4.5 慢响应时必然 timeout after 900s: createRepairStream，
 * 整卷 acted 永久 0。45m 覆盖「一次成功 critical_review ~6m + stream + 两次
 * evaluateOnly」常态，仍远小于整卷 wall；silent-hang 仍由章级 abort 收口。
 */
export const VOLUME_READINESS_PER_CHAPTER_TIMEOUT_MS = asInt(
  process.env.VOLUME_READINESS_PER_CHAPTER_TIMEOUT_MS,
  45 * 60 * 1000,
  60_000,
  60 * 60 * 1000,
);

/**
 * wallMsUsed heartbeat 落盘间隔（ms）。
 * 旧实现只在章间刷 wallMsUsed——单章 hang 时快照永驻旧值，进程重启后 hydrate
 * 仍判 wall 未耗尽 → auto-resume 原地复现同章 hang。心跳让 wall 真实推进，重启自愈。
 */
export const VOLUME_READINESS_WALL_HEARTBEAT_MS = asInt(
  process.env.VOLUME_READINESS_WALL_HEARTBEAT_MS,
  30_000,
  5_000,
  5 * 60 * 1000,
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
  perChapterTimeoutMs: number;
  wallHeartbeatMs: number;
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
  perChapterTimeoutMs: VOLUME_READINESS_PER_CHAPTER_TIMEOUT_MS,
  wallHeartbeatMs: VOLUME_READINESS_WALL_HEARTBEAT_MS,
};
