import type { VolumeChapterPlan, VolumePlanDocument } from "@ai-novel/shared/types/novel";
import { prisma } from "../../../../db/prisma";

interface VolumeChapterProjectionDeps {
  ensureVolumeWorkspace(novelId: string): Promise<VolumePlanDocument>;
  persistWorkspaceDocument(novelId: string, document: VolumePlanDocument, options: { emitEvent: boolean; syncPayoffLedger: boolean }): Promise<unknown>;
}

/** Chapter rows own execution fields; volume workspace remains a planning projection. */
export class VolumeChapterProjectionService {
  constructor(private readonly deps: VolumeChapterProjectionDeps) {}
  async hydrateCanonicalChapterFields(
    novelId: string,
    document: VolumePlanDocument,
  ): Promise<{ document: VolumePlanDocument; changed: boolean }> {
    const chapterRows = await prisma.chapter.findMany({
      where: { novelId },
      orderBy: { order: "asc" },
      select: {
        id: true,
        order: true,
        title: true,
        expectation: true,
        targetWordCount: true,
        conflictLevel: true,
        revealLevel: true,
        mustAvoid: true,
        taskSheet: true,
        sceneCards: true,
      },
    });
    if (chapterRows.length === 0) {
      return { document, changed: false };
    }

    const chapterById = new Map(chapterRows.map((row) => [row.id, row] as const));
    const chapterByOrder = new Map(chapterRows.map((row) => [row.order, row] as const));
    let changed = false;
    const volumes = document.volumes.map((volume) => {
      const chapters = volume.chapters.map((chapter) => {
        const row = chapter.chapterId
          ? chapterById.get(chapter.chapterId) ?? chapterByOrder.get(chapter.chapterOrder)
          : chapterByOrder.get(chapter.chapterOrder);
        if (!row) {
          return chapter;
        }
        const conflictLevelSource: VolumeChapterPlan["conflictLevelSource"] = chapter.conflictLevelSource === "user" ? "user" : "ai";
        const nextChapter = {
          ...chapter,
          chapterId: row.id,
          chapterOrder: row.order,
          title: row.title,
          summary: row.expectation?.trim() || chapter.summary,
          targetWordCount: row.targetWordCount ?? null,
          conflictLevel: chapter.conflictLevelSource === "user"
            ? chapter.conflictLevel ?? null
            : row.conflictLevel ?? null,
          conflictLevelSource,
          revealLevel: row.revealLevel ?? null,
          mustAvoid: row.mustAvoid ?? null,
          taskSheet: row.taskSheet ?? null,
          sceneCards: row.sceneCards ?? null,
        };
        if (JSON.stringify(nextChapter) !== JSON.stringify(chapter)) {
          changed = true;
        }
        return nextChapter;
      });
      return changed ? { ...volume, chapters } : volume;
    });

    return { document: changed ? { ...document, volumes } : document, changed };
  }

  async mirrorChapterIntoWorkspace(
    novelId: string,
    chapter: {
      id?: string | null;
      order: number;
      title: string;
      expectation?: string | null;
      targetWordCount?: number | null;
      conflictLevel?: number | null;
      revealLevel?: number | null;
      mustAvoid?: string | null;
      taskSheet?: string | null;
      sceneCards?: string | null;
    },
  ): Promise<void> {
    const document = await this.deps.ensureVolumeWorkspace(novelId);
    let changed = false;
    const nextVolumes = document.volumes.map((volume) => {
      const chapters = volume.chapters.map((item) => {
        const matchesChapter = chapter.id
          ? item.chapterId === chapter.id || item.chapterOrder === chapter.order
          : item.chapterOrder === chapter.order;
        if (!matchesChapter) {
          return item;
        }
        changed = true;
        const conflictLevelSource: VolumeChapterPlan["conflictLevelSource"] = item.conflictLevelSource === "user" ? "user" : "ai";
        return {
          ...item,
          chapterId: chapter.id ?? item.chapterId ?? null,
          chapterOrder: chapter.order,
          title: chapter.title,
          summary: chapter.expectation?.trim() || item.summary,
          targetWordCount: chapter.targetWordCount ?? null,
          conflictLevel: item.conflictLevelSource === "user"
            ? item.conflictLevel ?? null
            : chapter.conflictLevel ?? null,
          conflictLevelSource,
          revealLevel: chapter.revealLevel ?? null,
          mustAvoid: chapter.mustAvoid ?? null,
          taskSheet: chapter.taskSheet ?? null,
          sceneCards: chapter.sceneCards ?? null,
        };
      });
      return changed ? { ...volume, chapters } : volume;
    });
    if (!changed) {
      return;
    }
    await this.deps.persistWorkspaceDocument(novelId, {
      ...document,
      volumes: nextVolumes,
    }, {
      emitEvent: false,
      syncPayoffLedger: false,
    });
  }

}
