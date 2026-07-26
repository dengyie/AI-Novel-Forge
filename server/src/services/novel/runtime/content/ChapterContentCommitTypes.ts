export interface CommittedChapterContent {
  novelId: string;
  chapterId: string;
  content: string;
  contentRevision: number;
}

export interface CommitChapterContentInput {
  novelId: string;
  chapterId: string;
  content: string;
  expectedContentRevision: number;
  statePatch?: Record<string, unknown>;
  source: "style_rewrite" | "repair_adopt";
}

export interface ChapterContentCommitDatabase {
  chapter: {
    updateMany(input: {
      where: {
        id: string;
        novelId: string;
        contentRevision: number;
      };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    findFirst(input: {
      where: { id: string; novelId: string };
      select: Record<string, boolean>;
    }): Promise<Record<string, unknown> | null>;
  };
}
