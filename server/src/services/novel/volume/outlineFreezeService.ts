import type {
  OutlineDiffReport,
  OutlineFreezeChapterRef,
  OutlineFreezeSnapshot,
} from "@ai-novel/shared/types/outlineFreeze";
import {
  buildOutlineDiffAgainstFunctions,
  buildOutlineFreezeSnapshot,
  evaluateOutlineFreezeGate,
  getOutlineFreezeSnapshotForVolume,
  upsertOutlineFreezeSnapshot,
} from "@ai-novel/shared/types/outlineFreeze";
import type { SettingQualityMode } from "@ai-novel/shared/types/settingQualityPolicy";
import { resolveSettingQualityPolicy } from "@ai-novel/shared/types/settingQualityPolicy";
import {
  getFunctionTableForVolume,
} from "@ai-novel/shared/types/functionAcceptance";
import type {
  VolumeChapterPlan,
  VolumePlan,
  VolumePlanDocument,
} from "@ai-novel/shared/types/novel";

/**
 * C1 Outline Freeze 服务层（纯函数 + document 投影）。
 * 绑定现网 structured_outline_ready；不新建 checkpointType。
 */

function chaptersToFreezeRefs(chapters: VolumeChapterPlan[]): OutlineFreezeChapterRef[] {
  return chapters.map((chapter) => ({
    chapterOrder: chapter.chapterOrder,
    title: chapter.title,
    summary: chapter.summary,
    exclusiveEvent: chapter.exclusiveEvent,
    mustAvoid: chapter.mustAvoid,
    functionIds: chapter.functionIds,
    purpose: chapter.purpose,
  }));
}

export function buildOutlineDiffForVolume(input: {
  document: VolumePlanDocument;
  volumeId: string;
  mode?: SettingQualityMode | null;
  beatNames?: string[] | null;
  hardForbiddenTerms?: string[] | null;
}): OutlineDiffReport {
  const volume = input.document.volumes.find((item) => item.id === input.volumeId);
  const table = getFunctionTableForVolume(
    input.document.functionAcceptanceTables,
    input.volumeId,
  );
  return buildOutlineDiffAgainstFunctions({
    volumeId: input.volumeId,
    chapters: chaptersToFreezeRefs(volume?.chapters ?? []),
    table,
    mode: input.mode,
    beatNames: input.beatNames,
    hardForbiddenTerms: input.hardForbiddenTerms,
  });
}

/**
 * structured_outline_ready 审批通过钩子：写入 freeze snapshot。
 * enforce 且 coverage 未过时仍可写 snapshot（coverageOk=false），调用方应用 gate 决定是否进 auto_execute。
 */
export function persistOutlineFreezeOnStructuredOutlineReady(input: {
  document: VolumePlanDocument;
  volumeId: string;
  mode?: SettingQualityMode | null;
  actor?: string | null;
  reason?: string | null;
  beatNames?: string[] | null;
  hardForbiddenTerms?: string[] | null;
}): {
  document: VolumePlanDocument;
  snapshot: OutlineFreezeSnapshot;
} {
  const volume = input.document.volumes.find((item) => item.id === input.volumeId);
  const table = getFunctionTableForVolume(
    input.document.functionAcceptanceTables,
    input.volumeId,
  );
  const snapshot = buildOutlineFreezeSnapshot({
    volumeId: input.volumeId,
    novelId: input.document.novelId,
    chapters: chaptersToFreezeRefs(volume?.chapters ?? []),
    table,
    mode: input.mode,
    beatNames: input.beatNames,
    hardForbiddenTerms: input.hardForbiddenTerms,
    actor: input.actor,
    reason: input.reason ?? "structured_outline_ready",
  });
  return {
    document: {
      ...input.document,
      outlineFreezeSnapshots: upsertOutlineFreezeSnapshot(
        input.document.outlineFreezeSnapshots,
        snapshot,
      ),
    },
    snapshot,
  };
}

export function evaluateDocumentOutlineFreezeGate(input: {
  document: VolumePlanDocument;
  volumeId: string;
  mode?: SettingQualityMode | null;
}): ReturnType<typeof evaluateOutlineFreezeGate> {
  const volume = input.document.volumes.find((item) => item.id === input.volumeId);
  const table = getFunctionTableForVolume(
    input.document.functionAcceptanceTables,
    input.volumeId,
  );
  const snapshot = getOutlineFreezeSnapshotForVolume(
    input.document.outlineFreezeSnapshots,
    input.volumeId,
  );
  return evaluateOutlineFreezeGate({
    mode: input.mode,
    snapshot,
    chapters: chaptersToFreezeRefs(volume?.chapters ?? []),
    table,
  });
}

/**
 * enforce 覆盖失败 → structured outline 事实未完成（供 inspectCompletion evidence）。
 * off/advisory：不阻塞。
 */
export function buildStructuredOutlineFunctionCoverageEvidence(input: {
  document: VolumePlanDocument;
  volumeId?: string | null;
  mode?: SettingQualityMode | null;
}): {
  mode: SettingQualityMode;
  blocking: boolean;
  issues: string[];
  volumeId: string | null;
  coverageOk: boolean;
} {
  const mode = resolveSettingQualityPolicy(input.mode ? { mode: input.mode } : null).mode;
  if (mode === "off") {
    return {
      mode,
      blocking: false,
      issues: [],
      volumeId: input.volumeId ?? null,
      coverageOk: true,
    };
  }
  const volumeId = input.volumeId
    ?? input.document.volumes[0]?.id
    ?? null;
  if (!volumeId) {
    return {
      mode,
      blocking: false,
      issues: [],
      volumeId: null,
      coverageOk: true,
    };
  }
  const diff = buildOutlineDiffForVolume({
    document: input.document,
    volumeId,
    mode,
  });
  return {
    mode,
    blocking: diff.blocking,
    issues: diff.issues,
    volumeId,
    coverageOk: diff.coverageOk && !diff.blocking,
  };
}

export function pickPrimaryVolume(document: VolumePlanDocument): VolumePlan | null {
  return document.volumes[0] ?? null;
}
