/**
 * 就绪 job 终态 / 进度 pure 规则（service 与测试共用，避免镜像分叉）。
 */

export type VoiceReadinessJobTerminalStatus = "cancelled" | "failed" | "succeeded";

export type ResolveVoiceReadinessJobTerminalInput = {
  cancelRequested: boolean;
  failed: number;
  appliedVoice: number;
  generatedPreview: number;
  attemptedVoiceApply: boolean;
  attemptedPreview: boolean;
};

/**
 * cancel → cancelled；
 * failed>0 且无任何成功写入且曾尝试 → failed；
 * 否则 succeeded（含部分失败但有写入 / 无操作）。
 */
export function resolveVoiceReadinessJobTerminalStatus(
  input: ResolveVoiceReadinessJobTerminalInput,
): VoiceReadinessJobTerminalStatus {
  if (input.cancelRequested) {
    return "cancelled";
  }
  if (
    input.failed > 0
    && input.appliedVoice === 0
    && input.generatedPreview === 0
    && (input.attemptedVoiceApply || input.attemptedPreview)
  ) {
    return "failed";
  }
  return "succeeded";
}

export function resolveVoiceReadinessProgressWeights(options: {
  fillMissingVoice: boolean;
  generatePreview: boolean;
}): { weightVoice: number; weightPreview: number } {
  const weightVoice = options.fillMissingVoice ? 15 : 0;
  const weightPreview = options.generatePreview
    ? (options.fillMissingVoice ? 85 : 100)
    : 0;
  return { weightVoice, weightPreview };
}

/** 完成第 completedCount 个预览目标后的进度（completedCount 1-based 完成数）。 */
export function resolveVoiceReadinessPreviewProgress(input: {
  weightVoice: number;
  weightPreview: number;
  completedCount: number;
  total: number;
}): number {
  const total = Math.max(input.total, 1);
  return Math.min(
    100,
    input.weightVoice + Math.round((input.completedCount / total) * input.weightPreview),
  );
}
