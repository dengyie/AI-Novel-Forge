import { prisma } from "../../db/prisma";
import {
  contentRevisionBumpData,
  initialContentRevisionForCreate,
} from "./chapterContentCas";
import { AppError } from "../../middleware/errorHandler";
import { assertChapterBlankDeletable } from "./chapterBlankDeleteGate";

interface ChapterWriteInput {
  title?: string;
  content?: string;
  order?: number;
}

export class ChapterService {
  async listChapters(novelId: string) {
    return prisma.chapter.findMany({
      where: { novelId },
      orderBy: { order: "asc" },
    });
  }

  async createChapter(novelId: string, input: Required<Pick<ChapterWriteInput, "title" | "order">> & ChapterWriteInput) {
    const initialContent = input.content ?? "";
    return prisma.chapter.create({
      data: {
        novelId,
        title: input.title,
        order: input.order,
        content: initialContent,
        contentRevision: initialContentRevisionForCreate(initialContent),
      },
    });
  }

  async updateChapter(novelId: string, chapterId: string, input: ChapterWriteInput) {
    const exists = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      select: { id: true },
    });
    if (!exists) {
      throw new Error("章节不存在。");
    }
    const isContentWrite = typeof input.content === "string";
    return prisma.chapter.update({
      where: { id: chapterId },
      data: {
        ...input,
        ...(isContentWrite ? contentRevisionBumpData() : {}),
      },
    });
  }

  /** Same blank-chapter gate as NovelCoreCrudService (legacy direct path). */
  async deleteChapter(
    novelId: string,
    chapterId: string,
    options?: { confirmBlank?: boolean },
  ) {
    const chapter = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      select: {
        id: true,
        content: true,
        chapterStatus: true,
        sceneCards: true,
        taskSheet: true,
        order: true,
      },
    });
    if (!chapter) {
      throw new AppError("章节不存在", 404, { code: "CHAPTER_NOT_FOUND" });
    }

    const busyJob = await prisma.generationJob.findFirst({
      where: {
        novelId,
        status: { in: ["queued", "running"] },
        startOrder: { lte: chapter.order },
        endOrder: { gte: chapter.order },
      },
      select: { id: true },
    });

    assertChapterBlankDeletable({
      content: chapter.content,
      chapterStatus: chapter.chapterStatus,
      sceneCards: chapter.sceneCards,
      taskSheet: chapter.taskSheet,
      hasBusyJob: Boolean(busyJob),
      confirmBlank: options?.confirmBlank,
    });

    const deleted = await prisma.chapter.deleteMany({
      where: { id: chapterId, novelId },
    });
    if (deleted.count === 0) {
      throw new AppError("章节不存在", 404, { code: "CHAPTER_NOT_FOUND" });
    }
  }
}
