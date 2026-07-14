import type { FunctionAcceptanceTable } from "@ai-novel/shared/types/functionAcceptance";
import { getFunctionTableForVolume } from "@ai-novel/shared/types/functionAcceptance";
import type { SettingQualityMode } from "@ai-novel/shared/types/settingQualityPolicy";
import {
  resolveVolumeCompletion,
  shouldCloseVolumeForSupervisor,
  type VolumeCompletionForceAudit,
  type VolumeCompletionKind,
  type VolumeCompletionResolution,
} from "@ai-novel/shared/types/volumeSettingCompletion";
import type { VolumePlanDocument } from "@ai-novel/shared/types/novel";

/**
 * C3 卷设定完成态投影（纯函数服务）。
 * BatchRoll completed_scope 可读取 supervisoryCloseable；不改窗算法本身。
 */

export type VolumeCompletionProjection = VolumeCompletionResolution & {
  volumeId: string | null;
  proseComplete: boolean;
};

export function projectVolumeSettingCompletion(input: {
  document: VolumePlanDocument;
  volumeId?: string | null;
  mode?: SettingQualityMode | null;
  proseComplete?: boolean;
  forceFlag?: boolean;
  forceAudit?: VolumeCompletionForceAudit | null;
}): VolumeCompletionProjection {
  const volumeId = input.volumeId ?? input.document.volumes[0]?.id ?? null;
  const table: FunctionAcceptanceTable | null = volumeId
    ? getFunctionTableForVolume(input.document.functionAcceptanceTables, volumeId)
    : null;
  const resolution = resolveVolumeCompletion({
    mode: input.mode,
    functionTable: table,
    proseComplete: input.proseComplete,
    forceFlag: input.forceFlag,
    forceAudit: input.forceAudit,
  });
  return {
    ...resolution,
    volumeId,
    proseComplete: Boolean(input.proseComplete),
  };
}

export function isVolumeSupervisoryCloseable(
  projection: VolumeCompletionProjection | VolumeCompletionResolution,
): boolean {
  return shouldCloseVolumeForSupervisor(projection);
}

/** checkpoint / director state 可挂的轻量 payload */
export function toVolumeCompletionCheckpointPayload(
  projection: VolumeCompletionProjection,
): {
  volumeCompletion: VolumeCompletionKind;
  supervisoryCloseable: boolean;
  unsatisfiedFunctionIds: string[];
  forceApplied: boolean;
  summary: string;
  volumeId: string | null;
  mode: SettingQualityMode;
} {
  return {
    volumeCompletion: projection.kind,
    supervisoryCloseable: projection.supervisoryCloseable,
    unsatisfiedFunctionIds: projection.unsatisfiedIds,
    forceApplied: projection.forceApplied,
    summary: projection.summary,
    volumeId: projection.volumeId,
    mode: projection.mode,
  };
}
