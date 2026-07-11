import { prisma } from "../../../db/prisma";
import {
  buildQualityDebtBoardResult,
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
      select: { id: true },
    });
    if (!novel) {
      throw new Error("小说不存在");
    }
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
    return buildQualityDebtBoardResult({
      novelId,
      chapters,
      threshold: options.threshold ?? QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD,
    });
  }
}

export const qualityDebtBoardService = new QualityDebtBoardService();
