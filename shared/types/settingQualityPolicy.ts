import { z } from "zod";

/**
 * 设定对齐质量总开关（见 docs/plans/setting-alignment-quality-architecture-plan.md §3）。
 * 默认 off：现网零行为变化。
 */
export const SETTING_QUALITY_MODES = ["off", "advisory", "enforce"] as const;
export type SettingQualityMode = (typeof SETTING_QUALITY_MODES)[number];

export const settingQualityModeSchema = z.enum(SETTING_QUALITY_MODES);

export const MID_RUN_DIFF_MODES = ["off", "advisory", "blocking"] as const;
export type MidRunDiffMode = (typeof MID_RUN_DIFF_MODES)[number];

export const midRunDiffModeSchema = z.enum(MID_RUN_DIFF_MODES);

export const settingQualityPolicySchema = z.object({
  mode: settingQualityModeSchema.default("off"),
  /**
   * slice 构建是否走 canonical strip。
   * enforce 解析默认 true；off/advisory 默认 false。
   */
  canonicalSliceLock: z.boolean().optional(),
  /** 本 milestone 默认不启用 mid-run；保留字段供后续 */
  midRunDiffMode: midRunDiffModeSchema.optional(),
  midRunDiffCheckpoints: z.array(z.number().int().positive()).max(16).optional(),
});

export type SettingQualityPolicy = z.infer<typeof settingQualityPolicySchema>;

export const DEFAULT_SETTING_QUALITY_POLICY: SettingQualityPolicy = {
  mode: "off",
  canonicalSliceLock: false,
  midRunDiffMode: "off",
  midRunDiffCheckpoints: [10, 20],
};

export function resolveSettingQualityPolicy(
  raw: unknown,
): SettingQualityPolicy {
  if (raw == null) {
    return { ...DEFAULT_SETTING_QUALITY_POLICY };
  }
  const parsed = settingQualityPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return { ...DEFAULT_SETTING_QUALITY_POLICY };
  }
  const mode = parsed.data.mode;
  const canonicalSliceLock = parsed.data.canonicalSliceLock
    ?? (mode === "enforce");
  return {
    mode,
    canonicalSliceLock,
    midRunDiffMode: parsed.data.midRunDiffMode ?? "off",
    midRunDiffCheckpoints: parsed.data.midRunDiffCheckpoints ?? [10, 20],
  };
}

/** enforce 且 canonicalSliceLock 时 slice 用 canonical；其余 theme_invent */
export function resolveStoryWorldSliceLockModeFromPolicy(
  policy: SettingQualityPolicy,
): "canonical" | "theme_invent" {
  if (policy.mode === "enforce" && policy.canonicalSliceLock !== false) {
    return "canonical";
  }
  return "theme_invent";
}

export function isSettingQualityEnforced(policy: SettingQualityPolicy): boolean {
  return policy.mode === "enforce";
}

export function isSettingQualityActive(policy: SettingQualityPolicy): boolean {
  return policy.mode === "advisory" || policy.mode === "enforce";
}
