import {
  DEFAULT_AUDIOBOOK_NARRATOR_STYLE,
  DEFAULT_AUDIOBOOK_NARRATOR_VOICE,
  isAudiobookTtsMode,
  isMimoTtsPresetVoice,
  type AudiobookNarratorConfig,
  type AudiobookTtsMode,
  type AudiobookVoiceReadinessSummary,
  type CharacterVoiceBindingStatus,
  type CharacterVoicePreviewStatus,
  type CharacterVoiceReadinessAction,
  type CharacterVoiceReadinessItem,
} from "@ai-novel/shared/types/audiobook";

export type VoiceBindingResolveInput = {
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  /**
   * clone 且 path 非空时：调用方 fs 探测结果。
   * 非 clone 或 path 空时传 null。
   */
  refAudioOk: boolean | null;
};

export type ResolveVoiceBindingResult = {
  status: CharacterVoiceBindingStatus;
  reason?: string;
  /** 归一化后的 mode（非法字符串时仍为原 trim 后字符串语义：按 invalid 处理） */
  mode: AudiobookTtsMode | string;
};

/** 纯函数：绑定状态（不碰 fs；clone 文件可用性由 refAudioOk 注入）。 */
export function resolveVoiceBindingStatus(input: VoiceBindingResolveInput): ResolveVoiceBindingResult {
  const rawMode = input.ttsMode?.trim() || "";
  if (rawMode && !isAudiobookTtsMode(rawMode)) {
    return {
      status: "invalid",
      reason: `ttsMode「${rawMode}」非法（须 preset|design|clone）。`,
      mode: rawMode,
    };
  }

  const mode: AudiobookTtsMode = isAudiobookTtsMode(rawMode) ? rawMode : "preset";
  const voice = input.ttsVoice?.trim() || "";
  const designPrompt = input.ttsDesignPrompt?.trim() || "";
  const refPath = input.ttsRefAudioPath?.trim() || "";

  if (mode === "preset") {
    if (!voice) {
      return {
        status: "missing",
        reason: "角色卡未配置 ttsVoice（MiMo 预置音色）。",
        mode,
      };
    }
    if (!isMimoTtsPresetVoice(voice)) {
      return {
        status: "invalid",
        reason: `音色「${voice}」不在 MiMo 预置表中。`,
        mode,
      };
    }
    return { status: "configured", mode };
  }

  if (mode === "design") {
    if (!designPrompt) {
      return {
        status: "missing",
        reason: "角色卡未配置 ttsDesignPrompt（音色设计描述）。",
        mode,
      };
    }
    return { status: "configured", mode };
  }

  // clone
  if (!refPath) {
    return {
      status: "missing",
      reason: "角色卡未配置 clone 参考音频（ttsRefAudioPath）。",
      mode,
    };
  }
  if (refPath.includes("..") || refPath.includes("\0")) {
    return {
      status: "invalid",
      reason: "参考音频路径非法。",
      mode,
    };
  }
  if (input.refAudioOk !== true) {
    return {
      status: "invalid",
      reason: "参考音频文件不存在或不可用。",
      mode,
    };
  }
  return { status: "configured", mode };
}

export function resolveReadinessAction(
  binding: CharacterVoiceBindingStatus,
  mode: string,
  preview: CharacterVoicePreviewStatus,
): CharacterVoiceReadinessAction {
  const isClone = mode === "clone";
  if (binding === "invalid") {
    return isClone ? "manual_clone" : "fix_invalid";
  }
  if (binding === "missing") {
    return isClone ? "manual_clone" : "apply_plan";
  }
  if (preview === "ready") {
    return "none";
  }
  return "generate_preview";
}

export function buildVoiceDetailLabel(input: {
  binding: CharacterVoiceBindingStatus;
  mode: string;
  ttsVoice?: string | null;
  ttsDesignPrompt?: string | null;
  ttsVoiceAssetId?: string | null;
  reason?: string | null;
}): string {
  const mode = input.mode || "preset";
  if (input.binding === "missing") {
    if (mode === "clone") return "clone·缺参考音";
    if (mode === "design") return "design·缺描述";
    return "preset·未配音色";
  }
  if (input.binding === "invalid") {
    if (mode === "clone") return "clone·文件不可用";
    if (mode === "preset") {
      const voice = input.ttsVoice?.trim();
      return voice ? `preset·非法「${voice}」` : "preset·非法";
    }
    return input.reason?.trim() || `${mode}·无效`;
  }
  if (mode === "design") {
    const prompt = input.ttsDesignPrompt?.trim() || "";
    return prompt ? `design·${prompt.length > 16 ? `${prompt.slice(0, 16)}…` : prompt}` : "design";
  }
  if (mode === "clone") {
    const assetId = input.ttsVoiceAssetId?.trim();
    if (assetId) {
      return `clone·库/${assetId.slice(0, 10)}`;
    }
    return "clone";
  }
  const voice = input.ttsVoice?.trim() || "";
  return voice ? `preset/${voice}` : "preset";
}

export type CharacterReadinessRowInput = {
  characterId: string;
  characterName: string;
  castRole?: string | null;
  gender?: string | null;
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  ttsVoiceAssetId?: string | null;
  refAudioOk: boolean | null;
  previewStatus: CharacterVoicePreviewStatus;
  previewGeneratedAt?: string | null;
};

export function buildCharacterReadinessItem(row: CharacterReadinessRowInput): CharacterVoiceReadinessItem {
  const binding = resolveVoiceBindingStatus({
    ttsMode: row.ttsMode,
    ttsVoice: row.ttsVoice,
    ttsDesignPrompt: row.ttsDesignPrompt,
    ttsRefAudioPath: row.ttsRefAudioPath,
    refAudioOk: row.refAudioOk,
  });
  const mode = isAudiobookTtsMode(String(binding.mode))
    ? (binding.mode as AudiobookTtsMode)
    : isAudiobookTtsMode(row.ttsMode?.trim() || "")
      ? (row.ttsMode!.trim() as AudiobookTtsMode)
      : "preset";
  const actionMode = String(binding.mode || mode);
  const action = resolveReadinessAction(binding.status, actionMode, row.previewStatus);
  const voiceDetailLabel = buildVoiceDetailLabel({
    binding: binding.status,
    mode: actionMode,
    ttsVoice: row.ttsVoice,
    ttsDesignPrompt: row.ttsDesignPrompt,
    ttsVoiceAssetId: row.ttsVoiceAssetId,
    reason: binding.reason,
  });

  return {
    characterId: row.characterId,
    characterName: row.characterName,
    castRole: row.castRole ?? null,
    gender: row.gender ?? null,
    voiceBindingStatus: binding.status,
    ttsMode: mode,
    ttsVoice: row.ttsVoice?.trim() || null,
    ttsVoiceAssetId: row.ttsVoiceAssetId?.trim() || null,
    voiceDetailLabel,
    previewStatus: row.previewStatus,
    previewGeneratedAt: row.previewGeneratedAt ?? null,
    action,
    blocksTask: binding.status !== "configured",
    blocksReadyPreview: binding.status === "configured" && row.previewStatus !== "ready",
    reason: binding.reason ?? null,
  };
}

export function aggregateVoiceReadinessSummary(input: {
  novelId: string;
  narratorVoice?: string | null;
  narratorStyle?: string | null;
  items: CharacterVoiceReadinessItem[];
  extraWarnings?: string[];
  extraBlockingErrors?: string[];
}): AudiobookVoiceReadinessSummary {
  const narratorVoice =
    (input.narratorVoice?.trim() || DEFAULT_AUDIOBOOK_NARRATOR_VOICE);
  const narratorStyle =
    (input.narratorStyle?.trim() || DEFAULT_AUDIOBOOK_NARRATOR_STYLE);
  const narratorValid = isMimoTtsPresetVoice(narratorVoice);
  const narrator: AudiobookNarratorConfig & { valid: boolean } = {
    voice: narratorVoice,
    style: narratorStyle,
    valid: narratorValid,
  };

  const items = input.items;
  const voiceConfigured = items.filter((item) => item.voiceBindingStatus === "configured").length;
  const voiceMissing = items.filter((item) => item.voiceBindingStatus === "missing").length;
  const voiceInvalid = items.filter((item) => item.voiceBindingStatus === "invalid").length;

  const configured = items.filter((item) => item.voiceBindingStatus === "configured");
  const previewReady = configured.filter((item) => item.previewStatus === "ready").length;
  const previewStale = configured.filter((item) => item.previewStatus === "stale").length;
  const previewMissing = configured.filter((item) => item.previewStatus === "missing").length;

  const previewOk = configured.length === 0
    ? true
    : previewStale === 0 && previewMissing === 0;

  const voiceOk = voiceMissing === 0 && voiceInvalid === 0 && narratorValid;
  const readyForWorkbench = voiceOk && previewOk;

  const warnings = [...(input.extraWarnings ?? [])];
  const blockingErrors = [...(input.extraBlockingErrors ?? [])];
  if (items.length === 0) {
    warnings.push("小说尚无角色卡；对白将仅使用旁白音色。");
  }
  if (!narratorValid) {
    blockingErrors.push(`旁白音色「${narratorVoice}」不在 MiMo 预置表中（旁白仅支持 preset）。`);
  }
  for (const item of items) {
    if (item.voiceBindingStatus === "invalid" && item.reason) {
      blockingErrors.push(`角色「${item.characterName}」${item.reason}`);
    }
  }

  return {
    novelId: input.novelId,
    characterTotal: items.length,
    voiceConfigured,
    voiceMissing,
    voiceInvalid,
    previewReady,
    previewStale,
    previewMissing,
    voiceOk,
    previewOk,
    readyForWorkbench,
    narrator,
    items,
    warnings,
    blockingErrors,
  };
}

export function toBootstrapReadiness(
  summary: AudiobookVoiceReadinessSummary,
  activeReadinessJobId?: string | null,
): NonNullable<import("@ai-novel/shared/types/audiobook").AudiobookWorkspaceBootstrap["readiness"]> {
  const attentionItems = summary.items
    .filter((item) => item.action !== "none")
    .slice(0, 12)
    .map((item) => ({
      characterId: item.characterId,
      characterName: item.characterName,
      action: item.action,
      previewStatus: item.previewStatus,
      voiceBindingStatus: item.voiceBindingStatus,
    }));

  return {
    voiceOk: summary.voiceOk,
    previewOk: summary.previewOk,
    readyForWorkbench: summary.readyForWorkbench,
    voiceConfigured: summary.voiceConfigured,
    voiceMissing: summary.voiceMissing,
    voiceInvalid: summary.voiceInvalid,
    previewReady: summary.previewReady,
    previewStale: summary.previewStale,
    previewMissing: summary.previewMissing,
    characterTotal: summary.characterTotal,
    narratorValid: summary.narrator.valid,
    attentionItems,
    activeReadinessJobId: activeReadinessJobId ?? null,
  };
}
