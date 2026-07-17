import type { AudiobookWorkspaceNovelOverview } from "@ai-novel/shared/types/audiobook";

export type AudiobookWorkspaceBadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline";

export type AudiobookWorkspaceBadge = {
  label: string;
  variant: AudiobookWorkspaceBadgeVariant;
};

export type AudiobookWorkspaceBadgeSet = {
  primary: AudiobookWorkspaceBadge | null;
  secondary: AudiobookWorkspaceBadge[];
};

/**
 * 选书页 Badge 优先级栈（编码 SoT，见 UX plan §4.1.1）。
 * 主态仅 1 枚（高优先命中即停）；辅态最多 2 枚。
 */
export function resolveAudiobookWorkspaceBadges(
  overview: AudiobookWorkspaceNovelOverview | null | undefined,
): AudiobookWorkspaceBadgeSet {
  if (!overview) {
    return { primary: null, secondary: [] };
  }

  const { readiness, latestTask, activeReadinessJob } = overview;
  let primary: AudiobookWorkspaceBadge | null = null;

  if (latestTask && (latestTask.status === "queued" || latestTask.status === "running")) {
    const progress = Math.max(0, Math.min(100, Math.round(latestTask.progress || 0)));
    primary = { label: `生成中 ${progress}%`, variant: "default" };
  } else if (activeReadinessJob) {
    primary = { label: "就绪中", variant: "secondary" };
  } else if (readiness != null && !readiness.voiceOk) {
    primary = { label: "缺音色", variant: "destructive" };
  } else if (latestTask?.status === "failed") {
    primary = { label: "上次失败", variant: "destructive" };
  } else if (
    latestTask
    && (
      latestTask.fullAudioReady === true
      || (latestTask.fullAudioReady == null && latestTask.status === "succeeded")
    )
  ) {
    primary = { label: "可听/可下", variant: "outline" };
  } else if (readiness != null && readiness.voiceOk) {
    primary = { label: "待生成", variant: "secondary" };
  } else if (readiness === null && !latestTask) {
    primary = { label: "态势暂不可用", variant: "outline" };
  } else if (latestTask) {
    // 其它终态（cancelled 等）兜底
    if (latestTask.status === "succeeded") {
      primary = { label: "可听/可下", variant: "outline" };
    } else if (readiness != null && readiness.voiceOk) {
      primary = { label: "待生成", variant: "secondary" };
    } else {
      primary = { label: latestTask.status, variant: "outline" };
    }
  }

  const secondary: AudiobookWorkspaceBadge[] = [];
  if (readiness != null) {
    // 主态已是缺音色时仍可展示计数（不重复「缺音色」文案）
    secondary.push({
      label: `音色 ${readiness.voiceConfigured}/${readiness.characterTotal}`,
      variant: "outline",
    });
    if (readiness.previewMissing > 0) {
      secondary.push({
        label: `试听缺 ${readiness.previewMissing}`,
        variant: "outline",
      });
    } else {
      secondary.push({
        label: `试听 ready ${readiness.previewReady}`,
        variant: "outline",
      });
    }
  }

  return {
    primary,
    secondary: secondary.slice(0, 2),
  };
}
