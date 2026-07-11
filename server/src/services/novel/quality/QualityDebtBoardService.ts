import { prisma } from "../../../db/prisma";
import {
  buildQualityDebtBoardResult,
  GENRE_BEAT_BOARD_WINDOW_SIZE,
  QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD,
  type QualityDebtBoardResult,
} from "./qualityDebtBoard";

export class QualityDebtBoardService {
  async listNovelQualityDebt(
    novelId: string,
    options: { threshold?: number } = {},
  ): Promise<QualityDebtBoardResult> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        bookSellingPoint: true,
        competingFeel: true,
        first30ChapterPromise: true,
      },
    });
    if (!novel) {
      throw new Error("小说不存在");
    }

    // replan gate / 债条目：全书轻字段（不含 taskSheet / summary 大文本）
    const chapters = await prisma.chapter.findMany({
      where: { novelId },
      select: {
        id: true,
        order: true,
        title: true,
        generationState: true,
        chapterStatus: true,
        riskFlags: true,
      },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    });

    // genreBeat 观测：仅前 N 章（按 order）拉取 taskSheet + summary，避免长书全表重字段
    const genreBeatWindow = GENRE_BEAT_BOARD_WINDOW_SIZE;
    const genreBeatChapterRows = await prisma.chapter.findMany({
      where: { novelId },
      select: {
        order: true,
        title: true,
        taskSheet: true,
        chapterSummary: {
          select: { summary: true },
        },
      },
      orderBy: [{ order: "asc" }, { id: "asc" }],
      take: genreBeatWindow,
    });

    return buildQualityDebtBoardResult({
      novelId,
      chapters,
      threshold: options.threshold ?? QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD,
      genreBeat: {
        framing: {
          sellingPoint: novel.bookSellingPoint,
          competingFeel: novel.competingFeel,
          first30ChapterPromise: novel.first30ChapterPromise,
        },
        chapters: genreBeatChapterRows.map((chapter) => ({
          order: chapter.order,
          title: chapter.title,
          taskSheet: chapter.taskSheet,
          summary: chapter.chapterSummary?.summary ?? null,
        })),
        windowSize: genreBeatWindow,
      },
    });
  }
}

export const qualityDebtBoardService = new QualityDebtBoardService();
