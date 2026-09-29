import { ChapterProjectionRevisionGuard, ChapterProjectionSupersededError } from "./projections";
import type { RagOwnerType } from "../../rag/types";
import { prisma } from "../../../db/prisma";
import { withSqliteRetry } from "../../../db/sqliteRetry";
import { ragMain } from "../../rag/mainProcessProxy";
import { briefSummary, extractFacts } from "../novelP0Utils";
import { chapterStatePairAfterDraftSave } from "../chapterLifecycleState";
import { chapterArtifactBackgroundSyncService } from "./ChapterArtifactBackgroundSyncService";
import { assertChapterContentNotEmpty } from "./chapterEmptyContentError";
import type { ArtifactSyncMode } from "../novelCoreShared";
import type { ContentProvenance } from "@ai-novel/shared/types/canonicalState";
import type { CommittedChapterContent } from "./content/ChapterContentCommitTypes";
import { ChapterContentCommitService } from "./content/ChapterContentCommitService";

export interface ChapterArtifactSyncOptions {
  expectedContentRevision: number;
  markSummaryStale?: boolean;
  scheduleBackgroundSync?: boolean;
  artifactSyncMode?: ArtifactSyncMode;
  syncArtifacts?: boolean;
  awaitArtifactDelta?: boolean;
  skipLegacySummaryAndFacts?: boolean;
  provider?: string;
  model?: string;
  temperature?: number;
  contentProvenance?: ContentProvenance;
}

export interface ChapterDraftCommitOptions extends ChapterArtifactSyncOptions {
  expectedContentRevision: number;
}

export class ChapterArtifactSyncService {
  constructor(
    private readonly contentCommitService: ChapterContentCommitService = new ChapterContentCommitService(),
  ) {}

  async saveDraftAndArtifacts(
    novelId: string,
    chapterId: string,
    content: string,
    generationState: "drafted" | "repaired",
    options: ChapterDraftCommitOptions,
  ): Promise<CommittedChapterContent> {
    const safeContent = assertChapterContentNotEmpty(content, {
      novelId,
      chapterId,
      source: "chapter_artifact_save",
    });
    const committed = await this.contentCommitService.commit({
      novelId,
      chapterId,
      content: safeContent,
      expectedContentRevision: options.expectedContentRevision,
      statePatch: chapterStatePairAfterDraftSave(generationState),
      source: "writer_draft",
    });
    if (options.syncArtifacts === false) {
      return committed;
    }
    await this.syncChapterArtifacts(novelId, chapterId, safeContent, { ...options, expectedContentRevision: committed.contentRevision });
    return committed;
  }

  async syncManualChapterArtifacts(novelId: string, chapterId: string, content: string, expectedContentRevision: number): Promise<void> {
    try {
      await this.syncChapterArtifacts(novelId, chapterId, content, { expectedContentRevision, markSummaryStale: true });
    } catch (error) {
      // A later successful save owns projections; this save's content commit still succeeded.
      if (!(error instanceof ChapterProjectionSupersededError)) throw error;
    }
  }

  async syncChapterArtifacts(
    novelId: string,
    chapterId: string,
    content: string,
    options: ChapterArtifactSyncOptions,
  ): Promise<void> {
    const owner = { novelId, chapterId, expectedContentRevision: options.expectedContentRevision };
    if (!options.skipLegacySummaryAndFacts) {
      const facts = extractFacts(content);
      const summary = briefSummary(content, facts);

      await withSqliteRetry(
        () => prisma.$transaction(async (tx) => {
          await new ChapterProjectionRevisionGuard(tx).lockCurrentForWrite(owner);
          if (options.markSummaryStale) {
            const chapter = await tx.chapter.findUnique({ where: { id: chapterId }, select: { riskFlags: true } });
            let flags: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(chapter?.riskFlags ?? "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) flags = parsed;
            } catch { /* Invalid historical metadata has no mergeable fields. */ }
            await tx.chapter.update({ where: { id: chapterId }, data: {
              riskFlags: JSON.stringify({ ...flags, chapterSummaryStale: {
                at: new Date().toISOString(), reason: "manual_content_saved",
              } }),
            } });
          }
          // regex 摘要仅作 fallback：已有非空 summary（LLM 摘要或此前回填）时不覆写，
          // 避免把 NovelChapterSummaryService 生成的 LLM 摘要降级为正则截断版。
          const existingSummary = await tx.chapterSummary.findUnique({ where: { chapterId } });
          const shouldBackfillSummary = !existingSummary || existingSummary.summary.trim().length === 0;
          await tx.chapterSummary.upsert({
            where: { chapterId },
            update: {
              ...(shouldBackfillSummary ? { summary } : {}),
              keyEvents: facts.map((item) => item.content).slice(0, 3).join(""),
              characterStates: facts.filter((item) => item.category === "character").map((item) => item.content).slice(0, 3).join(""),
            },
            create: {
              novelId,
              chapterId,
              summary,
              keyEvents: facts.map((item) => item.content).slice(0, 3).join(""),
              characterStates: facts.filter((item) => item.category === "character").map((item) => item.content).slice(0, 3).join(""),
            },
          });

          await tx.consistencyFact.deleteMany({ where: { novelId, chapterId } });
          if (facts.length > 0) {
            await tx.consistencyFact.createMany({
              data: facts.map((item) => ({
                novelId,
                chapterId,
                category: item.category,
                content: item.content,
                source: "chapter_auto_extract",
              })),
            });
          }
        }),
        { label: "chapterArtifactSync.summaryAndFacts" },
      );
    }

    const timelines = await this.syncCharacterTimelineForChapter(novelId, chapterId, content, options.expectedContentRevision);
    if (options.scheduleBackgroundSync !== false) {
      const artifactSyncMode = options.artifactSyncMode ?? "adaptive";
      if (options.awaitArtifactDelta || artifactSyncMode === "strict") {
        await chapterArtifactBackgroundSyncService.runChapterSyncNow(novelId, chapterId, content, {
          artifactSyncMode,
          provider: options.provider,
          model: options.model,
          temperature: options.temperature,
          contentProvenance: options.contentProvenance,
        });
      } else {
        chapterArtifactBackgroundSyncService.scheduleChapterSync(novelId, chapterId, content, {
          artifactSyncMode,
          provider: options.provider,
          model: options.model,
          temperature: options.temperature,
          contentProvenance: options.contentProvenance,
        });
      }
    }

    const factRows = await prisma.consistencyFact.findMany({
      where: { novelId, chapterId },
      select: { id: true },
    });
    await new ChapterProjectionRevisionGuard().assertCurrent(owner);
    this.queueRagUpsert("chapter", chapterId);
    this.queueRagUpsert("chapter_summary", chapterId);
    this.queueRagUpsert("novel", novelId);
    for (const timeline of timelines) this.queueRagUpsert("character_timeline", timeline.id);
    for (const fact of factRows) {
      this.queueRagUpsert("consistency_fact", fact.id);
    }

  }

  private async syncCharacterTimelineForChapter(novelId: string, chapterId: string, content: string, expectedContentRevision: number): Promise<Array<{ id: string }>> {
    const [chapter, characters] = await Promise.all([
      prisma.chapter.findFirst({
        where: { id: chapterId, novelId },
        select: { order: true, title: true },
      }),
      prisma.character.findMany({
        where: { novelId },
        select: { id: true, name: true },
      }),
    ]);

    if (!chapter || characters.length === 0) {
      return [];
    }

    const events: Array<{
      novelId: string;
      characterId: string;
      chapterId: string;
      chapterOrder: number;
      title: string;
      content: string;
      source: string;
    }> = [];

    for (const character of characters) {
      const lines = content
        .split(/[\n。！？!?]/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 8 && item.includes(character.name))
        .slice(0, 3);
      for (const line of lines) {
        events.push({
          novelId,
          characterId: character.id,
          chapterId,
          chapterOrder: chapter.order,
          title: `${chapter.order} - ${chapter.title}`,
          content: line,
          source: "chapter_extract",
        });
      }
    }

    await withSqliteRetry(
      () => prisma.$transaction(async (tx) => {
        await new ChapterProjectionRevisionGuard(tx).lockCurrentForWrite({ novelId, chapterId, expectedContentRevision });
        await tx.characterTimeline.deleteMany({
          where: {
            novelId,
            chapterId,
            source: "chapter_extract",
          },
        });
        if (events.length > 0) {
          await tx.characterTimeline.createMany({ data: events });
        }
      }),
      { label: "chapterArtifactSync.characterTimeline" },
    );

    const timelines = await prisma.characterTimeline.findMany({
      where: {
        novelId,
        chapterId,
        source: "chapter_extract",
      },
      select: { id: true },
    });
    return timelines;
  }

  private queueRagUpsert(ownerType: RagOwnerType, ownerId: string): void {
    void ragMain.jobs.enqueueUpsert(ownerType, ownerId).catch(() => {});
  }
}
