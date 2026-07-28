import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../db/prisma";

export interface ChapterProjectionOwner {
  novelId: string;
  chapterId: string;
  expectedContentRevision: number;
}

export class ChapterProjectionSupersededError extends Error {
  readonly novelId: string;
  readonly chapterId: string;
  readonly expectedContentRevision: number;

  constructor(owner: ChapterProjectionOwner) {
    super(
      `Chapter projection superseded for ${owner.chapterId} at content revision ${owner.expectedContentRevision}`,
    );
    this.name = "ChapterProjectionSupersededError";
    this.novelId = owner.novelId;
    this.chapterId = owner.chapterId;
    this.expectedContentRevision = owner.expectedContentRevision;
  }
}

type ChapterRevisionReader = Pick<Prisma.TransactionClient, "chapter">;

export class ChapterProjectionRevisionGuard {
  constructor(private readonly db: ChapterRevisionReader = prisma) {}

  async assertCurrent(owner: ChapterProjectionOwner): Promise<void> {
    const current = await this.db.chapter.findFirst({
      where: {
        id: owner.chapterId,
        novelId: owner.novelId,
        contentRevision: owner.expectedContentRevision,
      },
      select: { id: true },
    });
    if (!current) {
      throw new ChapterProjectionSupersededError(owner);
    }
  }
}
