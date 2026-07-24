/**
 * 解析 volumeOrder → chapter order 区间。
 * 优先 NovelVolumeService 卷工作区 chapters.chapterOrder；
 * 无卷表 / 无匹配卷时回退固定 20 章窗（与旧 ops 约定一致）。
 */

import { NovelVolumeService } from "./NovelVolumeService";

const FALLBACK_CHAPTERS_PER_VOLUME = 20;

export interface ResolvedVolumeOrderRange {
  fromOrder: number;
  toOrder: number;
  volumeOrder: number;
  source: "volume_workspace" | "fallback_20";
  volumeId?: string | null;
  volumeTitle?: string | null;
}

function ordersFromVolumeChapters(
  chapters: Array<{ chapterOrder?: number | null }>,
): { fromOrder: number; toOrder: number } | null {
  const orders = chapters
    .map((chapter) => (typeof chapter.chapterOrder === "number" && Number.isFinite(chapter.chapterOrder)
      ? Math.floor(chapter.chapterOrder)
      : null))
    .filter((order): order is number => order != null && order >= 1);
  if (orders.length === 0) {
    return null;
  }
  return {
    fromOrder: Math.min(...orders),
    toOrder: Math.max(...orders),
  };
}

/**
 * volumeOrder 为 1-based 卷序（sortOrder+1 或 volumes 数组下标+1）。
 */
export async function resolveVolumeOrderRange(input: {
  novelId: string;
  volumeOrder: number;
  maxChapterOrder: number;
  volumeService?: Pick<NovelVolumeService, "getVolumes">;
}): Promise<ResolvedVolumeOrderRange> {
  const volumeOrder = Math.max(1, Math.floor(input.volumeOrder));
  const maxOrder = Math.max(1, Math.floor(input.maxChapterOrder));

  try {
    const volumeService = input.volumeService ?? new NovelVolumeService();
    const workspace = await volumeService.getVolumes(input.novelId);
    const volumes = Array.isArray(workspace?.volumes) ? workspace.volumes : [];
    if (volumes.length > 0) {
      // sortOrder 升序；volumeOrder N → 第 N 卷（1-based）
      const sorted = [...volumes].sort((a, b) => {
        const ao = typeof a.sortOrder === "number" ? a.sortOrder : 0;
        const bo = typeof b.sortOrder === "number" ? b.sortOrder : 0;
        return ao - bo || String(a.id).localeCompare(String(b.id));
      });
      const volume = sorted[volumeOrder - 1];
      if (volume) {
        const range = ordersFromVolumeChapters(volume.chapters ?? []);
        if (range) {
          return {
            fromOrder: Math.min(range.fromOrder, maxOrder),
            toOrder: Math.min(Math.max(range.toOrder, range.fromOrder), maxOrder),
            volumeOrder,
            source: "volume_workspace",
            volumeId: volume.id ?? null,
            volumeTitle: volume.title ?? null,
          };
        }
      }
    }
  } catch {
    // fall through to fixed window
  }

  const fromOrder = Math.min((volumeOrder - 1) * FALLBACK_CHAPTERS_PER_VOLUME + 1, maxOrder);
  const toOrder = Math.min(volumeOrder * FALLBACK_CHAPTERS_PER_VOLUME, maxOrder);
  return {
    fromOrder,
    toOrder: Math.max(toOrder, fromOrder),
    volumeOrder,
    source: "fallback_20",
  };
}
