import type { FunctionAcceptanceTable } from "./functionAcceptance.js";
import type { SettingQualityMode } from "./settingQualityPolicy.js";
import { resolveSettingQualityPolicy } from "./settingQualityPolicy.js";

/**
 * C3 监管停条件与设定卷解耦。
 * mode=off → legacy（现网窗尽/workflow_completed 语义）。
 */

export const VOLUME_COMPLETION_KINDS = [
  "legacy",
  "setting_complete",
  "prose_complete_only",
  "forced",
] as const;

export type VolumeCompletionKind = (typeof VOLUME_COMPLETION_KINDS)[number];

export type VolumeCompletionForceAudit = {
  actor: string;
  at: string;
  reason: string;
};

export type VolumeCompletionResolution = {
  kind: VolumeCompletionKind;
  mode: SettingQualityMode;
  allFunctionsSatisfied: boolean;
  unsatisfiedIds: string[];
  forceApplied: boolean;
  audit: VolumeCompletionForceAudit | null;
  summary: string;
  /** 监管默认可收工（setting_complete / forced / legacy） */
  supervisoryCloseable: boolean;
};

function listUnsatisfiedFunctionIds(
  table: FunctionAcceptanceTable | null | undefined,
): string[] {
  if (!table || table.items.length === 0) {
    return [];
  }
  return table.items
    .filter((item) => item.status !== "satisfied" && item.status !== "missed")
    .map((item) => item.id);
}

/**
 * 解析卷设定完成态（纯函数）。
 *
 * - mode=off：legacy
 * - forceFlag + audit：forced（可审计）
 * - enforce 且全部 required function satisfied（missed 不计未完成）：setting_complete
 * - 否则 prose_complete_only（章可写满，监管默认不收工）
 */
export function resolveVolumeCompletion(input: {
  mode?: SettingQualityMode | null;
  functionTable?: FunctionAcceptanceTable | null;
  /** 章面是否已写满/窗尽；mode=off 时仅影响 summary */
  proseComplete?: boolean;
  forceFlag?: boolean;
  forceAudit?: VolumeCompletionForceAudit | null;
}): VolumeCompletionResolution {
  const mode = resolveSettingQualityPolicy(input.mode ? { mode: input.mode } : null).mode;
  const table = input.functionTable ?? null;
  const forceFlag = Boolean(input.forceFlag);
  const audit = forceFlag && input.forceAudit
    ? {
      actor: String(input.forceAudit.actor ?? "").trim() || "unknown",
      at: String(input.forceAudit.at ?? "").trim() || new Date().toISOString(),
      reason: String(input.forceAudit.reason ?? "").trim() || "force_complete_volume",
    }
    : null;

  if (mode === "off") {
    return {
      kind: "legacy",
      mode,
      allFunctionsSatisfied: true,
      unsatisfiedIds: [],
      forceApplied: false,
      audit: null,
      summary: "settingQualityMode=off：沿用现网窗尽/workflow_completed 语义。",
      supervisoryCloseable: true,
    };
  }

  if (forceFlag) {
    if (!audit) {
      // force 无审计：仍返回 forced 但标不可静默收工提示
      return {
        kind: "forced",
        mode,
        allFunctionsSatisfied: listUnsatisfiedFunctionIds(table).length === 0,
        unsatisfiedIds: listUnsatisfiedFunctionIds(table),
        forceApplied: true,
        audit: null,
        summary: "force_complete_volume 已声明但缺少 audit；请补 actor/at/reason。",
        supervisoryCloseable: false,
      };
    }
    return {
      kind: "forced",
      mode,
      allFunctionsSatisfied: listUnsatisfiedFunctionIds(table).length === 0,
      unsatisfiedIds: listUnsatisfiedFunctionIds(table),
      forceApplied: true,
      audit,
      summary: `用户强制收工：${audit.reason}（${audit.actor}@${audit.at}）`,
      supervisoryCloseable: true,
    };
  }

  const unsatisfiedIds = listUnsatisfiedFunctionIds(table);
  // 无表时 advisory/enforce 视为设定侧无约束 → setting_complete（不挡 prose 路径）
  if (!table || table.items.length === 0) {
    return {
      kind: "setting_complete",
      mode,
      allFunctionsSatisfied: true,
      unsatisfiedIds: [],
      forceApplied: false,
      audit: null,
      summary: "无功能验收表：设定侧视为完成。",
      supervisoryCloseable: true,
    };
  }

  if (unsatisfiedIds.length === 0) {
    return {
      kind: "setting_complete",
      mode,
      allFunctionsSatisfied: true,
      unsatisfiedIds: [],
      forceApplied: false,
      audit: null,
      summary: "全部功能已 satisfied（或 missed），设定卷完成。",
      supervisoryCloseable: true,
    };
  }

  return {
    kind: "prose_complete_only",
    mode,
    allFunctionsSatisfied: false,
    unsatisfiedIds,
    forceApplied: false,
    audit: null,
    summary: `章面可完成，但功能未全部 satisfied：${unsatisfiedIds.join(", ")}。监管默认不收工。`,
    supervisoryCloseable: false,
  };
}

/**
 * BatchRoll completed_scope 投影钩子（纯）：是否允许把卷标为监管可收工。
 * 不直接改 BatchRoll 算法；由调用方在 completed_scope 路径读取。
 */
export function shouldCloseVolumeForSupervisor(
  resolution: VolumeCompletionResolution,
): boolean {
  return resolution.supervisoryCloseable;
}
