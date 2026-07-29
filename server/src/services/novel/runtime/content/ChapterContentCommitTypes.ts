import type { ChapterStatePairPatch } from "../../chapterLifecycleState";

export type ChapterContentStatePatch = ChapterStatePairPatch & {
  repairHistory?: string | null;
};

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
  statePatch?: ChapterContentStatePatch;
  source: "style_rewrite" | "repair_adopt" | "pipeline_repair" | "writer_draft";
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
